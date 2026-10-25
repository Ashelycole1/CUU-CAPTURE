import 'server-only';
import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { config } from '../config';
import { getDb, type Db, type DbOrTx } from '../db/client';
import { applications, notifications, profiles, reasonTemplates, ruleDocuments } from '../db/schema';
import { DevOutboxChannel, ResendChannel, type EmailMessage, type NotificationChannel } from './channels';
import { renderEmail, type EmailContext, type NotificationKind } from './templates';

export type { NotificationChannel, EmailMessage } from './channels';
export { DevOutboxChannel, ResendChannel } from './channels';
export { renderEmail, NOTIFICATION_KINDS, type NotificationKind } from './templates';

let channel: NotificationChannel | null = null;

/** RESEND_API_KEY set => Resend; otherwise the dev outbox. */
export function getChannel(): NotificationChannel {
  if (channel) return channel;
  const c = config();
  channel = c.resendApiKey ? new ResendChannel(c.resendApiKey, c.emailFrom) : new DevOutboxChannel(() => getDb());
  return channel;
}

/** Test hook. */
export function setChannel(ch: NotificationChannel | null): void {
  channel = ch;
}

export interface QueueNotificationInput {
  kind: NotificationKind;
  recipientId: string;
  applicationId?: string | null;
  /** Globally unique per logical send, e.g. `receipt:{appId}`. Same key => never sent twice (FR-RUN-5). */
  dedupeKey: string;
  /** IDs and codes only (no PII). */
  payload?: Record<string, unknown>;
}

/**
 * Queue a notification INSIDE the caller's transaction. Idempotent via the UNIQUE
 * dedupe_key: returns false if this key was already queued/sent.
 * Delivery happens in `flushNotifications()` (call it after the transaction commits,
 * e.g. `after(() => flushNotifications())` in a route/action; the daily cron retries).
 */
export async function queueNotification(tx: DbOrTx, input: QueueNotificationInput): Promise<boolean> {
  const res = await tx
    .insert(notifications)
    .values({
      kind: input.kind,
      recipientId: input.recipientId,
      applicationId: input.applicationId ?? null,
      dedupeKey: input.dedupeKey,
      payload: input.payload ?? {},
      channel: 'email',
    })
    .onConflictDoNothing({ target: notifications.dedupeKey })
    .returning({ id: notifications.id });
  return res.length > 0;
}

const MAX_ATTEMPTS = 5;

async function buildContext(db: Db, n: typeof notifications.$inferSelect): Promise<{ to: string; ctx: EmailContext } | null> {
  const c = config();
  if (!n.recipientId) return null;
  const recipient = (await db.select().from(profiles).where(eq(profiles.id, n.recipientId)))[0];
  if (!recipient || recipient.deletedAt || recipient.status === 'disabled') return null;
  const app = n.applicationId ? (await db.select().from(applications).where(eq(applications.id, n.applicationId)))[0] : undefined;
  const p = n.payload as Record<string, unknown>;
  const ctx: EmailContext = {
    appName: c.appName,
    appUrl: c.appUrl,
    recipientName: recipient.fullName,
    ref: app?.ref ?? null,
    newExpiry: (p.newExpiry as string | undefined) ?? app?.newExpiry ?? null,
    expiry: (p.expiry as string | undefined) ?? null,
    applyBy: (p.applyBy as string | undefined) ?? null,
    day: typeof p.day === 'number' ? p.day : undefined,
    messagePreview: typeof p.preview === 'string' ? p.preview : undefined,
    text: typeof p.text === 'string' ? p.text : undefined,
  };
  if (n.kind === 'corrections_needed' && app) {
    const items = (p.items as { docCode: string; reasonCode: string | null; note?: string | null }[]) ?? [];
    const docs = await db.select().from(ruleDocuments).where(eq(ruleDocuments.ruleSetId, app.ruleSetId));
    const reasons = await db.select().from(reasonTemplates);
    ctx.rejected = items.map((i) => ({
      name: docs.find((d) => d.code === i.docCode)?.name ?? i.docCode,
      reason: reasons.find((r) => r.code === i.reasonCode)?.label ?? 'Needs fixing',
      note: i.note ?? null,
    }));
  }
  return { to: recipient.email, ctx };
}

/**
 * Deliver queued notifications (at-most-once per row: each row is claimed with a
 * conditional UPDATE before sending). Safe to call concurrently and repeatedly.
 */
export async function flushNotifications(opts: { db?: Db; limit?: number; channel?: NotificationChannel } = {}): Promise<{
  sent: number;
  failed: number;
  skipped: number;
}> {
  const db = opts.db ?? getDb();
  const ch = opts.channel ?? getChannel();
  const staleSending = new Date(Date.now() - 10 * 60_000).toISOString();
  const rows = await db
    .select()
    .from(notifications)
    .where(
      and(
        lt(notifications.attempts, MAX_ATTEMPTS),
        or(
          inArray(notifications.status, ['queued', 'failed']),
          and(eq(notifications.status, 'sending'), lt(notifications.sentAt, staleSending)),
        ),
      ),
    )
    .orderBy(notifications.createdAt)
    .limit(opts.limit ?? 50);

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const n of rows) {
    // Claim: only one flusher wins.
    const claimed = await db
      .update(notifications)
      .set({ status: 'sending', attempts: sql`${notifications.attempts} + 1`, sentAt: new Date().toISOString() })
      .where(and(eq(notifications.id, n.id), eq(notifications.status, n.status)))
      .returning({ id: notifications.id });
    if (claimed.length === 0) continue;
    try {
      const built = await buildContext(db, n);
      if (!built) {
        await db.update(notifications).set({ status: 'skipped', lastError: 'recipient unavailable' }).where(eq(notifications.id, n.id));
        skipped++;
        continue;
      }
      const email = renderEmail(n.kind as NotificationKind, built.ctx);
      const msg: EmailMessage = { to: built.to, ...email, kind: n.kind, idempotencyKey: n.dedupeKey };
      const res = await ch.send(msg);
      await db
        .update(notifications)
        .set({ status: 'sent', sentAt: new Date().toISOString(), providerId: res.providerId ?? null, channel: ch.name, lastError: null })
        .where(eq(notifications.id, n.id));
      sent++;
    } catch (e) {
      await db
        .update(notifications)
        .set({ status: 'failed', lastError: String((e as Error).message ?? e).slice(0, 500) })
        .where(eq(notifications.id, n.id));
      failed++;
    }
  }
  return { sent, failed, skipped };
}

/** Send immediately without queueing (OTP codes only — they must not be stored). */
export async function sendEmailNow(message: EmailMessage): Promise<void> {
  await getChannel().send(message);
}
