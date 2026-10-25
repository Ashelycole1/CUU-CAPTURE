/** FR-DOS-1/2: listing, risk-then-expiry sort, filters, keyset pagination, summary, saved views; DB pragmas. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaff, createTestDb, type TestDb } from '../helpers/db';
import { createDraft, createSubmittedApplication } from '../helpers/factories';
import { createSavedView, deleteSavedView, getDashboardSummary, listApplicationsForStaff, listSavedViews } from '@/server/services';
import type { Actor } from '@/server/authz';

let t: TestDb;
let staff: Actor;

beforeAll(async () => {
  t = await createTestDb();
  staff = await createStaff(t.db);
  // expiry offsets → bands: 100 safe, 45 plan, 20 urgent, 3 critical, -5 expired, null no_pass
  for (const d of [100, 45, 20, 3, -5, null, 61, 0]) {
    await createSubmittedApplication(t.db, { expiryInDays: d, nationality: d === 20 ? 'KE' : 'NG', studentType: d === 45 ? 'masters' : 'new' });
  }
  await createDraft(t.db, { expiryInDays: 1 }); // draft: excluded by default
});
afterAll(() => t.cleanup());

describe('listApplicationsForStaff', () => {
  it('default sort is risk band then expiry; drafts excluded', async () => {
    const r = await listApplicationsForStaff(staff);
    expect(r.total).toBe(8);
    expect(r.items.map((i) => i.riskBand)).toEqual(['expired', 'critical', 'critical', 'urgent', 'no_pass', 'plan', 'safe', 'safe']);
    expect(r.items[1]!.daysToExpiry).toBe(0);
    expect(r.items[0]!.docsRequired).toBe(7);
    expect(r.items.every((i) => i.status === 'submitted')).toBe(true);
  });

  it('paginates with a cursor without gaps or duplicates', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listApplicationsForStaff(staff, { limit: 3, cursor });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    const all = await listApplicationsForStaff(staff, { limit: 100 });
    expect(seen).toEqual(all.items.map((i) => i.id));
    for (const sort of ['expiry', 'submitted', 'activity', 'name'] as const) {
      const ids: string[] = [];
      let c: string | null = null;
      do {
        const p = await listApplicationsForStaff(staff, { sort, limit: 3, cursor: c });
        ids.push(...p.items.map((i) => i.id));
        c = p.nextCursor;
      } while (c);
      expect(new Set(ids).size).toBe(8);
    }
  });

  it('filters by risk band, nationality, type, fee, status, search and drafts', async () => {
    expect((await listApplicationsForStaff(staff, { filters: { riskBand: ['critical', 'expired'] } })).total).toBe(3);
    expect((await listApplicationsForStaff(staff, { filters: { riskBand: ['no_pass'] } })).total).toBe(1);
    expect((await listApplicationsForStaff(staff, { filters: { nationality: ['ke'] } })).total).toBe(1);
    expect((await listApplicationsForStaff(staff, { filters: { studentType: ['masters'] } })).total).toBe(1);
    expect((await listApplicationsForStaff(staff, { filters: { feeStatus: ['not_required'] } })).total).toBe(1);
    expect((await listApplicationsForStaff(staff, { filters: { includeDrafts: true } })).total).toBe(9);
    expect((await listApplicationsForStaff(staff, { filters: { status: ['draft'] } })).total).toBe(1);
    const one = (await listApplicationsForStaff(staff)).items[0]!;
    expect((await listApplicationsForStaff(staff, { filters: { q: one.ref! } })).items.map((i) => i.id)).toEqual([one.id]);
    expect((await listApplicationsForStaff(staff, { filters: { q: '%' } })).total).toBe(0);
  });

  it('summary tiles (FR-DOS-2)', async () => {
    const s = await getDashboardSummary(staff);
    expect(s.needsReview).toBe(8);
    expect(s.criticalOrExpired).toBe(4); // 3 submitted (≤7d incl. expired) + 1 draft at 1 day
    expect(s.feesUnpaid).toBe(7);
    expect(s.readyForImmigration).toBe(0);
  });

  it('saved views are per-user unless shared', async () => {
    const other = await createStaff(t.db);
    const v = await createSavedView(staff, { name: 'Urgent this week', filters: { riskBand: ['critical', 'expired'], sort: 'risk' } });
    await createSavedView(staff, { name: 'Shared', filters: {}, shared: true });
    expect((await listSavedViews(staff)).map((x) => x.name)).toEqual(['Shared', 'Urgent this week']);
    expect((await listSavedViews(other)).map((x) => x.name)).toEqual(['Shared']);
    await expect(deleteSavedView(other, v.id)).rejects.toThrow();
    await deleteSavedView(staff, v.id);
    expect((await listSavedViews(staff)).map((x) => x.name)).toEqual(['Shared']);
  });
});

describe('database connection', () => {
  it('enforces foreign keys on pooled connections', async () => {
    const r = await t.handle.client.execute('PRAGMA foreign_keys');
    expect(Number(r.rows[0]![0])).toBe(1);
    await expect(t.handle.client.execute("INSERT INTO students (profile_id, created_at) VALUES ('nope', 'x')")).rejects.toThrow(/FOREIGN KEY/);
  });
  it('uses WAL for local files', async () => {
    const r = await t.handle.client.execute('PRAGMA journal_mode');
    expect(String(r.rows[0]![0]).toLowerCase()).toBe('wal');
  });
});
