/** NFR-REL notification retries with backoff, Resend daily cap, housekeeping, email design (FR-NOT-1). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createStaff, createTestDb, createUser, type TestDb } from '../helpers/db';
import { createSubmittedApplication } from '../helpers/factories';
import { applications, notifications } from '@/server/db/schema';
import { flushNotifications, queueNotification, renderEmail, MAX_ATTEMPTS, type NotificationChannel } from '@/server/notify';
import { flushWithinCap, releaseStaleClaims } from '@/server/jobs';
import { claimApplication } from '@/server/services';
import { addDays, todayInKampala } from '@/domain/dates';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.cleanup());

const down: NotificationChannel = {
  name: 'down',
  async send() {
    throw new Error('provider down');
  },
};

describe('retry with backoff', () => {
  it('retries the first failure immediately, then waits, and caps attempts', async () => {
    await flushNotifications(); // drain anything queued earlier
    const u = await createUser(t.db, { role: 'student' });
    const key = `test:${u.id}`;
    await queueNotification(t.db, { kind: 'staff_alert', recipientId: u.id, dedupeKey: key, payload: { text: 'x' } });
    const row = async () => (await t.db.select().from(notifications).where(eq(notifications.dedupeKey, key)))[0]!;

    await flushNotifications({ channel: down });
    expect((await row()).attempts).toBe(1);
    await flushNotifications({ channel: down }); // 1st retry is immediate
    const r2 = await row();
    expect(r2.attempts).toBe(2);
    expect(r2.status).toBe('failed');
    expect(Date.parse(r2.nextAttemptAt!)).toBeGreaterThan(Date.now() + 10 * 60_000);

    // Within the backoff window nothing is retried.
    await flushNotifications({ channel: down });
    expect((await row()).attempts).toBe(2);

    // A later run (window passed) picks it up again, until MAX_ATTEMPTS.
    for (let i = 0; i < 10; i++) {
      await t.db.update(notifications).set({ nextAttemptAt: new Date(Date.now() - 1000).toISOString() }).where(eq(notifications.dedupeKey, key));
      await flushNotifications({ channel: down });
    }
    const last = await row();
    expect(last.attempts).toBe(MAX_ATTEMPTS);
    expect(last.status).toBe('failed');
    expect(last.lastError).toContain('provider down');
  });
});

describe('daily email cap (Resend free tier)', () => {
  it('sends at most the remaining quota and leaves the rest queued', async () => {
    await flushNotifications();
    const sentBefore = (await t.db.select().from(notifications).where(eq(notifications.status, 'sent'))).length;
    const users = await Promise.all(Array.from({ length: 5 }, () => createUser(t.db, { role: 'student' })));
    for (const u of users) await queueNotification(t.db, { kind: 'staff_alert', recipientId: u.id, dedupeKey: `cap:${u.id}`, payload: { text: 'x' } });
    const res = await flushWithinCap({ cap: sentBefore + 2 });
    expect(res.sent).toBe(2);
    expect(res.capped).toBe(true);
    const queued = (await t.db.select().from(notifications)).filter((n) => n.dedupeKey.startsWith('cap:') && n.status === 'queued');
    expect(queued).toHaveLength(3);
    const none = await flushWithinCap({ cap: sentBefore + 2 });
    expect(none.sent).toBe(0);
  });
});

describe('housekeeping', () => {
  it('releases claims whose window has passed', async () => {
    const staff = await createStaff(t.db);
    const { app } = await createSubmittedApplication(t.db);
    await claimApplication(staff, app.id);
    expect(await releaseStaleClaims(new Date())).toBe(0);
    const released = await releaseStaleClaims(new Date(Date.now() + 16 * 60_000));
    expect(released).toBeGreaterThanOrEqual(1);
    const a = (await t.db.select().from(applications).where(eq(applications.id, app.id)))[0]!;
    expect(a.claimedBy).toBeNull();
    expect(a.status).toBe('under_review');
  });
});

describe('email templates (design §12)', () => {
  const base = { appName: 'VisaDesk', appUrl: 'https://visadesk.example', recipientName: 'Amina Okello', ref: 'VD-2026-00042' };
  it('corrections: explicit subject, only the rejected documents, one button, plain text', () => {
    const one = renderEmail('corrections_needed', { ...base, rejected: [{ name: 'Passport data page', reason: 'Glare hides details' }] });
    expect(one.subject).toBe('Action needed: fix 1 document for VD-2026-00042');
    expect(one.text).toContain('- Passport data page: Glare hides details');
    expect(one.html.match(/<a href=/g)).toHaveLength(2); // button + plain fallback link (same URL)
    expect(one.html).toContain('max-width:560px');
    expect(one.text).toContain('Dean of Students');
    expect(one.text).toMatch(/automated message/);
    const two = renderEmail('corrections_needed', { ...base, rejected: [{ name: 'A', reason: 'x' }, { name: 'B', reason: 'y' }] });
    expect(two.subject).toBe('Action needed: fix 2 documents for VD-2026-00042');
  });
  it('reminder: Runway line with the apply-by date', () => {
    const today = todayInKampala();
    const expiry = addDays(today, 45);
    const m = renderEmail('reminder', { ...base, ref: null, day: 60, expiry, applyBy: addDays(expiry, -30), today });
    expect(m.subject).toMatch(/^Action needed: your Student Pass expires on .* Apply by /);
    expect(m.text).toMatch(/Apply by \d{1,2} \w{3} \d{4}\./);
    expect(m.text).toContain('Start your application');
  });
  it('reminder: past the apply-by date and expired variants', () => {
    const today = todayInKampala();
    const soon = renderEmail('reminder', { ...base, day: 14, expiry: addDays(today, 10), applyBy: addDays(today, -20), today });
    expect(soon.subject).toMatch(/^Urgent:/);
    expect(soon.text).toContain('has passed');
    const gone = renderEmail('reminder', { ...base, day: -1, expiry: addDays(today, -4), applyBy: null, today, payload: { penaltyUsdPerDay: 20 } });
    expect(gone.subject).toContain('has expired');
    expect(gone.text).toContain('USD 20 per day');
  });
  it('escapes HTML in names and notes', () => {
    const m = renderEmail('message', { ...base, recipientName: '<script>x</script>', messagePreview: 'a & b' });
    expect(m.html).not.toContain('<script>x');
    expect(m.html).toContain('&lt;script&gt;');
  });
});
