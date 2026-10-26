/**
 * Database round-trip budgets for the hot paths (docs/PERFORMANCE.md §3).
 *
 * On Turso every round trip is a network hop (~2 ms in the same region, 15–80 ms
 * across regions), so round trips, not local CPU, dominate production latency. These
 * budgets fail CI when a change adds queries to a hot path. Raise a budget only on
 * purpose, and update docs/PERFORMANCE.md with the reason.
 *
 * Set PERF_REPORT=1 to print the per-scenario table (statements, round trips, write
 * transactions) that docs/PERFORMANCE.md quotes.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createStudent, createTestDb, type TestDb } from '../helpers/db';
import { applicationDocuments, students } from '@/server/db/schema';
import { addDays, todayInKampala } from '@/domain/dates';
import { runDailyRunway } from '@/server/jobs';
import { invalidateReadCache } from '@/server/services/read-cache';
import { instrumentClient, measure, type Instrumented, type QueryCounter } from './instrument';
import { buildFixture, documentJpeg, packet, reviewDecision, reviewDecisionRerender, SCENARIOS, sessionAuthMock, uploadRequest, authState, type Fixture } from './scenarios';

vi.mock('@/server/auth/current', () => sessionAuthMock());
const { POST: uploadPOST } = await import('@/app/api/uploads/route');

let t: TestDb;
let fx: Fixture;
let inst: Instrumented;
const report: { name: string; c: QueryCounter }[] = [];

/**
 * Round-trip budgets (warm instance: in-process read cache populated). Set to the values
 * measured after the Wave 3 perf pass; the "was" comments are the numbers before it
 * (docs/PERFORMANCE.md §3).
 */
const BUDGET: Record<string, number> = {
  'session lookup (every request)': 1, // was 1
  'student /apply (checklist home)': 6, // was 10 (+ a write transaction)
  'student /documents/[type]': 6, // was 9
  'student /review': 12, // was 15
  'student /status (detail)': 9, // was 18
  'staff /dashboard (first page)': 5, // was 6
  'staff /dashboard (filtered + search)': 5, // was 6
  'staff /applications/[id]': 10, // was 20
  'staff file view (thumb, audited)': 5, // was 7
  'student file view (original)': 2, // was 4
  'POST /api/uploads': 20, // was 35
  'review decision (action only)': 10, // was 10
  'packet generation': 22, // was 32
  'daily cron: newly flagged student': 7, // was 7
};

beforeAll(async () => {
  t = await createTestDb();
  fx = await buildFixture(t.db);
  inst = instrumentClient(t.handle.client);
}, 120_000);
afterAll(async () => {
  inst?.restore();
  if (process.env.PERF_REPORT) {
    console.log('\n| Hot path | Statements | Round trips | Write tx |');
    console.log('|---|---|---|---|');
    for (const r of report) console.log(`| ${r.name} | ${r.c.statements} | ${r.c.roundTrips} | ${r.c.writeTransactions} |`);
    if (process.env.PERF_REPORT === 'log') for (const r of report) console.log(`\n## ${r.name}\n${r.c.log.join('\n')}`);
  }
  await t.cleanup();
});

async function warmThenMeasure(name: string, fn: () => Promise<unknown>) {
  await fn(); // warm the per-instance read cache, like a warm serverless instance
  const { counter } = await measure(inst, fn);
  report.push({ name, c: counter });
  return counter;
}

describe('round-trip budgets per hot path (warm instance)', () => {
  for (const [name, fn] of Object.entries(SCENARIOS)) {
    it(name, async () => {
      const c = await warmThenMeasure(name, () => fn(fx));
      expect(c.roundTrips).toBeLessThanOrEqual(BUDGET[name]!);
    });
  }

  it('POST /api/uploads', async () => {
    const a = await documentJpeg(2000, 1500, 11);
    const b = await documentJpeg(2000, 1500, 12);
    authState.token = fx.studentToken;
    const first = await uploadPOST(uploadRequest({ applicationId: fx.draftAppId, docCode: fx.uploadDocCode }, a), undefined as never);
    expect(first.status).toBe(201);
    const { counter, result } = await measure(inst, () =>
      uploadPOST(uploadRequest({ applicationId: fx.draftAppId, docCode: fx.uploadDocCode }, b), undefined as never),
    );
    expect((result as Response).status).toBe(201);
    report.push({ name: 'POST /api/uploads', c: counter });
    expect(counter.writeTransactions).toBe(1);
    expect(counter.roundTrips).toBeLessThanOrEqual(BUDGET['POST /api/uploads']!);
  });

  it('review decision (action only) and the revalidated page', async () => {
    await reviewDecision(fx, fx.reviewDocIds[0]!);
    const { counter } = await measure(inst, () => reviewDecision(fx, fx.reviewDocIds[1]!));
    report.push({ name: 'review decision (action only)', c: counter });
    expect(counter.writeTransactions).toBe(1);
    expect(counter.roundTrips).toBeLessThanOrEqual(BUDGET['review decision (action only)']!);
    const re = await measure(inst, () => reviewDecisionRerender(fx));
    report.push({ name: '  + revalidated /applications/[id] render', c: re.counter });
  });

  it('packet generation', async () => {
    const { counter } = await measure(inst, () => packet(fx));
    report.push({ name: 'packet generation', c: counter });
    expect(counter.roundTrips).toBeLessThanOrEqual(BUDGET['packet generation']!);
  });

  it('daily cron per student', async () => {
    const N = 40;
    const today = todayInKampala();
    for (let i = 0; i < N; i++) {
      const s = await createStudent(t.db, { nationality: 'NG' });
      await t.db.update(students).set({ passExpiry: addDays(today, 10) }).where(eq(students.profileId, s.id));
    }
    invalidateReadCache();
    const first = await measure(inst, () => runDailyRunway({ today }));
    const perStudent = { ...first.counter, statements: Math.ceil(first.counter.statements / N), roundTrips: Math.ceil(first.counter.roundTrips / N), writeTransactions: Math.round(first.counter.writeTransactions / N) };
    report.push({ name: `daily cron: newly flagged student (run total ${first.counter.roundTrips} RT / ${N})`, c: perStudent });
    expect(perStudent.roundTrips).toBeLessThanOrEqual(BUDGET['daily cron: newly flagged student']!);
    const steady = await measure(inst, () => runDailyRunway({ today: addDays(today, 1) }));
    report.push({ name: `daily cron: steady-state run total (${N + 3} students, nothing new)`, c: steady.counter });
    // Steady state is per page of 200 students, not per student.
    expect(steady.counter.roundTrips).toBeLessThan(N);
    const open = await t.db.select().from(applicationDocuments).where(and(eq(applicationDocuments.state, 'missing'), isNull(applicationDocuments.reviewedAt)));
    expect(open).toBeDefined();
  }, 60_000);
});
