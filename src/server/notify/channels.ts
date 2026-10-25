import 'server-only';
import type { Db } from '../db/client';
import { outbox } from '../db/schema';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  kind?: string;
  /** Passed to providers that support idempotency (Resend `Idempotency-Key`). */
  idempotencyKey?: string;
}

/** Delivery channel. Email today; SMS/WhatsApp providers implement the same shape later (FR-NOT-4). */
export interface NotificationChannel {
  readonly name: string;
  send(message: EmailMessage): Promise<{ providerId?: string }>;
}

/** Dev/test sink: writes to the `outbox` table (readable at /dev/outbox) and logs. */
export class DevOutboxChannel implements NotificationChannel {
  readonly name = 'dev_outbox';
  constructor(
    private readonly db: () => Db,
    private readonly log = true,
  ) {}
  async send(m: EmailMessage): Promise<{ providerId?: string }> {
    const id = crypto.randomUUID();
    await this.db()
      .insert(outbox)
      .values({ id, to: m.to, subject: m.subject, text: m.text, html: m.html ?? null, kind: m.kind ?? null });
    if (this.log && process.env.NODE_ENV !== 'test') {
      console.info(`[dev-outbox] to=${m.to} subject="${m.subject}"\n${m.text}`);
    }
    return { providerId: id };
  }
}

/** Resend over plain fetch (no SDK). */
export class ResendChannel implements NotificationChannel {
  readonly name = 'resend';
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async send(m: EmailMessage): Promise<{ providerId?: string }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (m.idempotencyKey) headers['Idempotency-Key'] = m.idempotencyKey.slice(0, 256);
    const res = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers,
      body: JSON.stringify({ from: this.from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Resend ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = (await res.json().catch(() => ({}))) as { id?: string };
    return { providerId: json.id };
  }
}
