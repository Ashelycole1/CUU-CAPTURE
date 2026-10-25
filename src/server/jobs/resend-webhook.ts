import 'server-only';
/**
 * Resend webhooks (PRD §7 "Email bounce → student unreachable").
 *
 * Resend signs webhooks with Svix: headers `svix-id`, `svix-timestamp`,
 * `svix-signature` ("v1,<base64> v1,<base64>…"); the signed content is
 * `${id}.${timestamp}.${rawBody}`, HMAC-SHA256 with the base64 part of the
 * `whsec_…` secret. We reject stale timestamps (> 5 min) to stop replays.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { writeAudit } from '../audit';
import { getDb } from '../db/client';
import { notifications, profiles } from '../db/schema';
import { withTx } from '../services/internal';

export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

function secretBytes(secret: string): Buffer {
  return Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
}

export function signWebhook(secret: string, id: string, timestamp: number | string, body: string): string {
  return createHmac('sha256', secretBytes(secret)).update(`${id}.${timestamp}.${body}`).digest('base64');
}

/** Throws WebhookVerificationError unless the headers carry a valid, fresh signature. */
export function verifyWebhook(
  secret: string | undefined,
  headers: Headers,
  body: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): void {
  if (!secret) throw new WebhookVerificationError('Webhook secret not configured');
  const id = headers.get('svix-id') ?? headers.get('webhook-id');
  const ts = headers.get('svix-timestamp') ?? headers.get('webhook-timestamp');
  const sigHeader = headers.get('svix-signature') ?? headers.get('webhook-signature');
  if (!id || !ts || !sigHeader) throw new WebhookVerificationError('Missing signature headers');
  const timestamp = Number(ts);
  if (!Number.isFinite(timestamp) || Math.abs(nowSeconds - timestamp) > WEBHOOK_TOLERANCE_SECONDS) {
    throw new WebhookVerificationError('Timestamp outside tolerance');
  }
  const expected = Buffer.from(signWebhook(secret, id, ts, body));
  const ok = sigHeader.split(' ').some((part) => {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) return false;
    const given = Buffer.from(sig);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!ok) throw new WebhookVerificationError('Invalid signature');
}

export interface ResendEvent {
  type: string;
  created_at?: string;
  data?: { email_id?: string; to?: string[] | string; bounce?: { type?: string } };
}

export type WebhookOutcome = 'marked_bounced' | 'marked_ok' | 'ignored' | 'unknown_recipient';

/** Apply a verified Resend event. Only bounce/complaint/delivered events change state. */
export async function handleResendEvent(event: ResendEvent): Promise<WebhookOutcome> {
  const bounce = event.type === 'email.bounced' && event.data?.bounce?.type?.toLowerCase() !== 'transient';
  const complaint = event.type === 'email.complained';
  const delivered = event.type === 'email.delivered';
  if (!bounce && !complaint && !delivered) return 'ignored';

  const db = getDb();
  let profileId: string | null = null;
  if (event.data?.email_id) {
    const n = (await db.select({ r: notifications.recipientId }).from(notifications).where(eq(notifications.providerId, event.data.email_id)))[0];
    profileId = n?.r ?? null;
  }
  if (!profileId) {
    const to = Array.isArray(event.data?.to) ? event.data?.to[0] : event.data?.to;
    if (to) {
      const p = (await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.email, to.trim().toLowerCase())))[0];
      profileId = p?.id ?? null;
    }
  }
  if (!profileId) return 'unknown_recipient';

  const status = delivered ? 'ok' : 'bounced';
  const changed = await withTx(async (tx) => {
    const p = (await tx.select({ s: profiles.emailStatus }).from(profiles).where(eq(profiles.id, profileId!)))[0];
    if (!p || p.s === status) return false;
    await tx.update(profiles).set({ emailStatus: status, updatedAt: new Date().toISOString() }).where(eq(profiles.id, profileId!));
    await writeAudit(tx, { actorId: null, action: 'profile.email_status_set', targetType: 'profile', targetId: profileId!, meta: { status, event: event.type } });
    return true;
  });
  if (!changed) return 'ignored';
  return status === 'ok' ? 'marked_ok' : 'marked_bounced';
}
