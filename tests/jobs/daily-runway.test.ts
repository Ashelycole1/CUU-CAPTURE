/** FR-RUN-3/5, PRD story 4, NFR-REL (idempotent, resumable jobs). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createAdmin, createTestDb, outboxFor, type TestDb } from '../helpers/db';
import { createDraft, createSubmittedApplication } from '../helpers/factories';
import { jobRuns, notifications, runwayFlags, outbox } from '@/server/db/schema';
import { flushNotifications } from '@/server/notify';
import { runDailyRunway, reminderStage, EXPIRED_STAGE } from '@/server/jobs';
import { verifyAuditChain } from '@/server/audit';
import { addDays, todayInKampala } from '@/domain/dates';
import { resetJobRuns, studentExpiringIn } from './helpers';

let t: TestDb;
const today = todayInKampala();

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.cleanup());

async function flagsFor(studentId: string) {
  return t.db.select().from(runwayFlags).where(eq(runwayFlags.studentId, studentId));
}
async function remindersFor(studentId: string) {
  return (await t.db.select().from(notifications).where(eq(notifications.recipientId, studentId))).filter((n) => n.kind === 'reminder');
}

describe('reminderStage', () => {
  const days = [60, 30, 14, 7, 0];
  it.each([
    [90, null],
    [61, null],
    [60, 60],
    [45, 60],
    [31, 60],
    [30, 30],
    [15, 30],
    [14, 14],
    [8, 14],
    [7, 7],
    [1, 7],
    [0, 0],
    [-1, EXPIRED_STAGE],
    [-40, EXPIRED_STAGE],
  ])('%i days to expiry → stage %s', (d, stage) => {
    expect(reminderStage(d, days)).toBe(stage);
  });
  it('ignores duplicate/unsorted/negative configured days', () => {
    expect(reminderStage(20, [7, 30, 30, -5, 60])).toBe(30);
  });
});

describe('PRD story 4: expiry watch', () => {
  beforeEach(() => resetJobRuns(t.db));

  it('flags a student with no application and 30 days left as urgent, emails once, and a second run sends nothing', async () => {
    const s = await studentExpiringIn(t.db, 30, today);
    const r1 = await runDailyRunway({ today });
    expect(r1.complete).toBe(true);

    const flags = await flagsFor(s.id);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ day: 30, band: 'urgent', expiry: addDays(today, 30), resolvedAt: null });
    const rem = await remindersFor(s.id);
    expect(rem).toHaveLength(1);
    expect(rem[0]!.dedupeKey).toBe(`reminder:${s.id}:${addDays(today, 30)}:30`);

    await flushNotifications();
    const mails = (await outboxFor(t.db, s.email)).filter((m) => m.kind === 'reminder');
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toContain('Action needed');
    expect(mails[0]!.text).toContain(`Apply by`);
    expect(mails[0]!.html).toContain('max-width:560px');

    // Same day again: the run is recorded as done.
    const r2 = await runDailyRunway({ today });
    expect(r2.alreadyDone).toBe(true);
    // Even if the run record is lost, nothing new is flagged or sent.
    await resetJobRuns(t.db);
    const r3 = await runDailyRunway({ today });
    expect(r3.complete).toBe(true);
    await flushNotifications();
    expect(await flagsFor(s.id)).toHaveLength(1);
    expect(await remindersFor(s.id)).toHaveLength(1);
    expect((await outboxFor(t.db, s.email)).filter((m) => m.kind === 'reminder')).toHaveLength(1);
  });
});

describe('every reminder day and the expired case', () => {
  beforeEach(() => resetJobRuns(t.db));

  it.each([
    [60, 60, 'plan'],
    [30, 30, 'urgent'],
    [14, 14, 'urgent'],
    [7, 7, 'critical'],
    [0, 0, 'critical'],
    [-3, EXPIRED_STAGE, 'expired'],
  ])('%i days left → stage %i (%s), one reminder', async (days, stage, band) => {
    const s = await studentExpiringIn(t.db, days, today);
    await runDailyRunway({ today });
    const flags = await flagsFor(s.id);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ day: stage, band });
    const rem = await remindersFor(s.id);
    expect(rem).toHaveLength(1);
    expect(rem[0]!.payload).toMatchObject({ day: stage, expiry: addDays(today, days), hasDraft: false });
    await flushNotifications();
    const mail = (await outboxFor(t.db, s.email)).find((m) => m.kind === 'reminder')!;
    if (stage === EXPIRED_STAGE) expect(mail.subject).toContain('has expired');
    else if (stage === 0) expect(mail.subject).toContain('expires today');
    else expect(mail.subject).toContain('expires on');
  });

  it('does not flag students far from expiry or with no pass', async () => {
    const far = await studentExpiringIn(t.db, 61, today);
    const none = await studentExpiringIn(t.db, null, today);
    await runDailyRunway({ today });
    expect(await flagsFor(far.id)).toHaveLength(0);
    expect(await flagsFor(none.id)).toHaveLength(0);
  });

  it('walks through the stages day by day, sending each reminder exactly once', async () => {
    const s = await studentExpiringIn(t.db, 62, today);
    const sentStages: number[] = [];
    for (let i = 0; i <= 66; i++) {
      await runDailyRunway({ today: addDays(today, i) });
    }
    for (const r of await remindersFor(s.id)) sentStages.push(r.payload.day as number);
    expect(sentStages.sort((a, b) => b - a)).toEqual([60, 30, 14, 7, 0, EXPIRED_STAGE]);
    // Only the latest stage stays open; earlier ones were superseded.
    const open = (await flagsFor(s.id)).filter((f) => !f.resolvedAt);
    expect(open.map((f) => f.day)).toEqual([EXPIRED_STAGE]);
  });

  it('sends DOS one expired digest per day', async () => {
    const admin = await createAdmin(t.db);
    const day = addDays(today, 200); // a fresh run key for this test
    await studentExpiringIn(t.db, -1, day);
    await studentExpiringIn(t.db, -10, day);
    await runDailyRunway({ today: day });
    await resetJobRuns(t.db);
    await runDailyRunway({ today: day });
    const alerts = (await t.db.select().from(notifications).where(eq(notifications.recipientId, admin.id))).filter((n) =>
      n.dedupeKey.startsWith(`expired_digest:${day}`),
    );
    expect(alerts).toHaveLength(1);
    expect(String(alerts[0]!.payload.text)).toMatch(/expired/);
  });
});

describe('applications and drafts', () => {
  beforeEach(() => resetJobRuns(t.db));

  it('reminds students with only a draft (with "finish" copy) but not those who submitted', async () => {
    const { student: drafter } = await createDraft(t.db, { expiryInDays: 14 });
    const { student: submitter } = await createSubmittedApplication(t.db, { expiryInDays: 14 });
    await runDailyRunway({ today });
    expect(await flagsFor(drafter.id)).toHaveLength(1);
    expect(await flagsFor(submitter.id)).toHaveLength(0);
    const rem = await remindersFor(drafter.id);
    expect(rem[0]!.payload.hasDraft).toBe(true);
    await flushNotifications();
    const mail = (await outboxFor(t.db, drafter.email)).find((m) => m.kind === 'reminder')!;
    expect(mail.text).toContain('Finish your application');
  });

  it('resolves open flags once the student submits', async () => {
    const { student, app } = await createDraft(t.db, { expiryInDays: 7 });
    await runDailyRunway({ today });
    expect((await flagsFor(student.id)).filter((f) => !f.resolvedAt)).toHaveLength(1);
    const { uploadAllRequired } = await import('../helpers/factories');
    const { submitApplication } = await import('@/server/services');
    await uploadAllRequired(t.db, student, app.id);
    await submitApplication(student, app.id);
    await resetJobRuns(t.db);
    await runDailyRunway({ today });
    expect((await flagsFor(student.id)).filter((f) => !f.resolvedAt)).toHaveLength(0);
  });
});

describe('batching and resumability', () => {
  beforeEach(() => resetJobRuns(t.db));

  it('stops at the time budget, saves a cursor, resumes, and never double-sends', async () => {
    const day = addDays(today, 400);
    const ids: string[] = [];
    for (let i = 0; i < 23; i++) ids.push((await studentExpiringIn(t.db, 10, day)).id);

    // budgetMs 0 => stop after every page of 5.
    let res = await runDailyRunway({ today: day, chunkSize: 5, budgetMs: 0 });
    expect(res.complete).toBe(false);
    const run = (await t.db.select().from(jobRuns).where(and(eq(jobRuns.job, 'daily-runway'), eq(jobRuns.runKey, day))))[0]!;
    expect(run.status).toBe('running');
    expect(run.cursor).toBeTruthy();

    let calls = 1;
    while (!res.complete && calls < 50) {
      res = await runDailyRunway({ today: day, chunkSize: 5, budgetMs: 0 });
      calls++;
    }
    expect(res.complete).toBe(true);
    expect(calls).toBeGreaterThan(2);
    const done = (await t.db.select().from(jobRuns).where(and(eq(jobRuns.job, 'daily-runway'), eq(jobRuns.runKey, day))))[0]!;
    expect(done.status).toBe('done');
    expect(done.attempts).toBe(calls);

    for (const id of ids) {
      expect(await flagsFor(id)).toHaveLength(1);
      expect(await remindersFor(id)).toHaveLength(1);
    }
  });

  it('a run cut off mid-way (crash) is completed by the next call without duplicates', async () => {
    const day = addDays(today, 500);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await studentExpiringIn(t.db, 7, day)).id);
    // Simulate a crash after some flags were written but before the cursor was saved.
    await runDailyRunway({ today: day, chunkSize: 2, budgetMs: 0 });
    await t.db.update(jobRuns).set({ cursor: null }).where(eq(jobRuns.runKey, day));
    let res;
    do res = await runDailyRunway({ today: day, chunkSize: 100 });
    while (!res.complete);
    for (const id of ids) expect(await remindersFor(id)).toHaveLength(1);
  });

  it('keeps the audit chain valid and writes a run summary', async () => {
    const v = await verifyAuditChain(t.db);
    expect(v.ok).toBe(true);
    const out = await t.db.select().from(outbox);
    expect(out.length).toBeGreaterThan(0);
  });
});
