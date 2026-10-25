/** FR-REV-5 (batched once), FR-RUN-5 (dedupe), FR-AUD-1 (hash chain, append-only). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createStaff, createTestDb, outboxFor, type TestDb } from '../helpers/db';
import { createSubmittedApplication, docsOf } from '../helpers/factories';
import { reviewDocument, claimApplication } from '@/server/services';
import { flushNotifications, queueNotification, ResendChannel, type NotificationChannel } from '@/server/notify';
import { auditLog, notifications } from '@/server/db/schema';
import { verifyAuditChain, writeAudit, GENESIS_HASH } from '@/server/audit';
import type { Actor } from '@/server/authz';

let t: TestDb;
let staff: Actor;

beforeAll(async () => {
  t = await createTestDb();
  staff = await createStaff(t.db);
});
afterAll(() => t.cleanup());

describe('batched corrections notification (FR-REV-5, PRD story 3)', () => {
  it('queues exactly one email listing only the rejected documents', async () => {
    const { student, app } = await createSubmittedApplication(t.db, { nationality: 'NG' });
    await claimApplication(staff, app.id);
    const docs = (await docsOf(t.db, app.id)).filter((d) => d.required);
    const toReject = ['passport_data_page', 'fees_statement'];
    let queued = 0;
    for (const d of docs) {
      const r = toReject.includes(d.docCode)
        ? await reviewDocument(staff, { documentId: d.id, decision: 'reject', reasonCode: d.docCode === 'fees_statement' ? 'other' : 'glare', note: d.docCode === 'fees_statement' ? 'Statement is from 2023' : null })
        : await reviewDocument(staff, { documentId: d.id, decision: 'approve' });
      if (r.correctionsNotified) queued++;
    }
    expect(queued).toBe(1);
    const rows = (await t.db.select().from(notifications).where(eq(notifications.applicationId, app.id))).filter((n) => n.kind === 'corrections_needed');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dedupeKey).toBe(`corrections:${app.id}:1`);

    const res = await flushNotifications();
    expect(res.failed).toBe(0);
    const mails = await outboxFor(t.db, student.email);
    const corr = mails.filter((m) => m.kind === 'corrections_needed');
    expect(corr).toHaveLength(1);
    expect(corr[0]!.subject).toContain('fix 2 document');
    expect(corr[0]!.text).toContain('Passport data page: Glare hides details');
    expect(corr[0]!.text).toContain('Statement is from 2023');
    expect(corr[0]!.text).not.toContain('Face of student ID card');
    // Receipt went out too, once.
    expect(mails.filter((m) => m.kind === 'receipt')).toHaveLength(1);

    // Flushing again sends nothing new.
    await flushNotifications();
    expect((await outboxFor(t.db, student.email)).length).toBe(mails.length);
  });
});

describe('notification dedupe (FR-RUN-5)', () => {
  it('the same dedupe key is only queued and sent once', async () => {
    const { student } = await createSubmittedApplication(t.db);
    const key = `reminder:${student.id}:2026-12-01:30`;
    const first = await queueNotification(t.db, { kind: 'reminder', recipientId: student.id, dedupeKey: key, payload: { day: 30, expiry: '2026-12-01' } });
    const second = await queueNotification(t.db, { kind: 'reminder', recipientId: student.id, dedupeKey: key, payload: { day: 30, expiry: '2026-12-01' } });
    expect(first).toBe(true);
    expect(second).toBe(false);
    await Promise.all([flushNotifications(), flushNotifications()]);
    const reminders = (await outboxFor(t.db, student.email)).filter((m) => m.kind === 'reminder');
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.subject).toContain('1 Dec 2026');
  });

  it('failed sends are recorded and retried', async () => {
    const { student } = await createSubmittedApplication(t.db);
    await flushNotifications(); // drain the receipt
    await queueNotification(t.db, { kind: 'staff_alert', recipientId: student.id, dedupeKey: `alert:${student.id}`, payload: { text: 'x' } });
    let calls = 0;
    const flaky: NotificationChannel = {
      name: 'flaky',
      async send() {
        calls++;
        if (calls === 1) throw new Error('provider down');
        return { providerId: 'p1' };
      },
    };
    expect((await flushNotifications({ channel: flaky })).failed).toBe(1);
    const row1 = (await t.db.select().from(notifications).where(eq(notifications.dedupeKey, `alert:${student.id}`)))[0]!;
    expect(row1.status).toBe('failed');
    expect(row1.lastError).toContain('provider down');
    expect((await flushNotifications({ channel: flaky })).sent).toBe(1);
    const row2 = (await t.db.select().from(notifications).where(eq(notifications.dedupeKey, `alert:${student.id}`)))[0]!;
    expect(row2.status).toBe('sent');
    expect(row2.attempts).toBe(2);
  });

  it('ResendChannel posts JSON with an idempotency key', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 });
    }) as unknown as typeof fetch;
    const ch = new ResendChannel('re_test', 'VisaDesk <a@b.c>', fakeFetch);
    const r = await ch.send({ to: 'x@cavendish.ac.ug', subject: 's', text: 't', idempotencyKey: 'k1' });
    expect(r.providerId).toBe('em_1');
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect((calls[0]!.init.headers as Record<string, string>)['Idempotency-Key']).toBe('k1');
    expect(JSON.parse(String(calls[0]!.init.body)).to).toEqual(['x@cavendish.ac.ug']);
  });
});

describe('audit log (FR-AUD-1)', () => {
  it('chain verifies over all service writes', async () => {
    const v = await verifyAuditChain(t.db);
    expect(v.ok).toBe(true);
    expect(v.checked).toBeGreaterThan(10);
    const first = (await t.db.select().from(auditLog).orderBy(auditLog.id).limit(1))[0]!;
    expect(first.prevHash).toBe(GENESIS_HASH);
  });

  it('meta never contains emails (PII decision)', async () => {
    const rows = await t.db.select().from(auditLog);
    expect(rows.some((r) => /@/.test(r.meta))).toBe(false);
  });

  it('UPDATE and DELETE are blocked by triggers', async () => {
    const causeOf = async (p: Promise<unknown>) => {
      try {
        await p;
        return 'no error';
      } catch (e) {
        return `${(e as Error).message} ${(e as { cause?: Error }).cause?.message ?? ''}`;
      }
    };
    expect(await causeOf(t.db.update(auditLog).set({ action: 'tampered' }).where(eq(auditLog.id, 1)))).toMatch(/append-only/);
    expect(await causeOf(t.db.delete(auditLog).where(eq(auditLog.id, 1)))).toMatch(/append-only/);
    expect(await causeOf(Promise.resolve(t.handle.client.execute('DELETE FROM audit_log')))).toMatch(/append-only/);
  });

  it('detects tampering (trigger bypassed by an attacker with raw DB access)', async () => {
    await t.handle.client.execute('DROP TRIGGER audit_log_no_update');
    const mid = (await t.db.select().from(auditLog).orderBy(auditLog.id).limit(1).offset(3))[0]!;
    await t.db.run(sql`UPDATE audit_log SET meta = '{"forged":true}' WHERE id = ${mid.id}`);
    const v = await verifyAuditChain(t.db);
    expect(v.ok).toBe(false);
    expect(v.brokenAtId).toBe(mid.id);
    // Restore trigger for any later writes.
    await t.handle.client.execute(
      "CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END",
    );
  });

  it('a forked chain (same prev_hash) is rejected by the UNIQUE index', async () => {
    const last = (await t.db.select().from(auditLog).orderBy(sql`id desc`).limit(1))[0]!;
    await writeAudit(t.db, { actorId: null, action: 'test.ok' });
    await expect(
      t.db.insert(auditLog).values({ at: new Date().toISOString(), actorId: null, action: 'fork', meta: '{}', prevHash: last.hash, hash: 'f'.repeat(64) }),
    ).rejects.toThrow();
  });
});
