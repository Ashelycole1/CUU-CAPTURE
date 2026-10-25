/** Cron auth (CONTRACTS §12) and the Resend bounce webhook (PRD §7: student unreachable). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';
import { auditLog, profiles } from '@/server/db/schema';
import { signWebhook } from '@/server/jobs';
import { GET as dailyRunway } from '@/app/api/cron/daily-runway/route';
import { GET as retentionSweep } from '@/app/api/cron/retention-sweep/route';
import { GET as flush } from '@/app/api/cron/flush/route';
import { POST as resendWebhook } from '@/app/api/webhooks/resend/route';
import { studentExpiringIn } from './helpers';

const SECRET = 'whsec_' + Buffer.from('test-webhook-secret-32-bytes!!!!').toString('base64');
let t: TestDb;

beforeAll(async () => {
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
  t = await createTestDb();
});
afterAll(() => t.cleanup());

const cronReq = (path: string, auth?: string) =>
  new Request(`http://localhost:3000${path}`, { headers: auth ? { authorization: auth } : {} });

describe('cron routes', () => {
  it.each([
    ['/api/cron/daily-runway', dailyRunway],
    ['/api/cron/retention-sweep', retentionSweep],
    ['/api/cron/flush', flush],
  ] as const)('%s rejects missing or wrong secrets', async (path, handler) => {
    expect((await handler(cronReq(path), undefined)).status).toBe(401);
    expect((await handler(cronReq(path, 'Bearer wrong-secret-0000000'), undefined)).status).toBe(401);
  });

  it('daily-runway runs with the secret and reports its work', async () => {
    await studentExpiringIn(t.db, 30);
    const res = await dailyRunway(cronReq('/api/cron/daily-runway', `Bearer ${process.env.CRON_SECRET}`), undefined);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runway: { complete: boolean; stats: { flagged: number } }; housekeeping: unknown; notifications: { sent: number } };
    expect(body.runway.complete).toBe(true);
    expect(body.runway.stats.flagged).toBeGreaterThanOrEqual(1);
    expect(body.housekeeping).toBeTruthy();
    expect(body.notifications.sent).toBeGreaterThanOrEqual(1);
  });

  it('retention-sweep runs with the secret', async () => {
    const res = await retentionSweep(cronReq('/api/cron/retention-sweep', `Bearer ${process.env.CRON_SECRET}`), undefined);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { complete: boolean }).complete).toBe(true);
  });
});

function webhookReq(body: string, opts: { secret?: string; ts?: number; id?: string; omit?: boolean } = {}) {
  const id = opts.id ?? `msg_${crypto.randomUUID()}`;
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const sig = signWebhook(opts.secret ?? SECRET, id, ts, body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (!opts.omit) Object.assign(headers, { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` });
  return new Request('http://localhost:3000/api/webhooks/resend', { method: 'POST', headers, body });
}

describe('Resend webhook', () => {
  it('rejects unsigned, wrongly signed, tampered and stale requests', async () => {
    const body = JSON.stringify({ type: 'email.bounced', data: { to: ['nobody@cavendish.ac.ug'] } });
    expect((await resendWebhook(webhookReq(body, { omit: true }), undefined)).status).toBe(401);
    const wrongSecret = 'whsec_' + Buffer.from('another-secret-another-secret!!!').toString('base64');
    expect((await resendWebhook(webhookReq(body, { secret: wrongSecret }), undefined)).status).toBe(401);
    const stale = Math.floor(Date.now() / 1000) - 3600;
    expect((await resendWebhook(webhookReq(body, { ts: stale }), undefined)).status).toBe(401);
    // Tampered body: sign one body, send another.
    const signed = webhookReq(body);
    const tampered = new Request(signed.url, { method: 'POST', headers: signed.headers, body: body.replace('bounced', 'delivered') });
    expect((await resendWebhook(tampered, undefined)).status).toBe(401);
  });

  it('marks a bounced student unreachable, and reachable again after a delivery', async () => {
    const s = await studentExpiringIn(t.db, 100, undefined, { email: 'bouncy@cavendish.ac.ug' });
    const bounce = JSON.stringify({ type: 'email.bounced', created_at: new Date().toISOString(), data: { email_id: 'em_1', to: ['Bouncy@cavendish.ac.ug'], bounce: { type: 'Permanent' } } });
    const res = await resendWebhook(webhookReq(bounce), undefined);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcome: string }).outcome).toBe('marked_bounced');
    const p = (await t.db.select().from(profiles).where(eq(profiles.id, s.id)))[0]!;
    expect(p.emailStatus).toBe('bounced');
    const audits = (await t.db.select().from(auditLog).where(eq(auditLog.targetId, s.id))).filter((a) => a.action === 'profile.email_status_set');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.meta).not.toContain('bouncy');

    const delivered = JSON.stringify({ type: 'email.delivered', data: { to: ['bouncy@cavendish.ac.ug'] } });
    await resendWebhook(webhookReq(delivered), undefined);
    expect((await t.db.select().from(profiles).where(eq(profiles.id, s.id)))[0]!.emailStatus).toBe('ok');
  });

  it('ignores transient bounces and unrelated events', async () => {
    const transient = JSON.stringify({ type: 'email.bounced', data: { to: ['bouncy@cavendish.ac.ug'], bounce: { type: 'Transient' } } });
    expect(((await (await resendWebhook(webhookReq(transient), undefined)).json()) as { outcome: string }).outcome).toBe('ignored');
    const opened = JSON.stringify({ type: 'email.opened', data: {} });
    expect(((await (await resendWebhook(webhookReq(opened), undefined)).json()) as { outcome: string }).outcome).toBe('ignored');
  });
});
