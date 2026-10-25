/** NFR-PERF smoke: 500+ applications, one dashboard page < 1.5 s, risk-then-expiry order, keyset paging. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createStaff, createTestDb, type TestDb } from '../helpers/db';
import { applicationDocuments, applications, profiles, ruleSets, students } from '@/server/db/schema';
import { getDashboardSummary, listApplicationsForStaff } from '@/server/services';
import { addDays, todayInKampala } from '@/domain/dates';
import { RISK_RANK } from '@/domain/rules';
import type { ApplicationStatus } from '@/domain/types';
import type { Actor } from '@/server/authz';

const N = 520;
let t: TestDb;
let staff: Actor;
const today = todayInKampala();

async function chunked<T>(rows: T[], size: number, fn: (part: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
}

beforeAll(async () => {
  t = await createTestDb();
  staff = await createStaff(t.db);
  const rs = (await t.db.select().from(ruleSets).where(eq(ruleSets.status, 'published')))[0]!;
  const statuses: ApplicationStatus[] = ['submitted', 'under_review', 'corrections_needed', 'approved', 'sent_to_immigration'];
  const profileRows: (typeof profiles.$inferInsert)[] = [];
  const studentRows: (typeof students.$inferInsert)[] = [];
  const appRows: (typeof applications.$inferInsert)[] = [];
  const docRows: (typeof applicationDocuments.$inferInsert)[] = [];
  const now = new Date().toISOString();
  for (let i = 0; i < N; i++) {
    const pid = crypto.randomUUID();
    const aid = crypto.randomUUID();
    const noPass = i % 37 === 0;
    profileRows.push({ id: pid, email: `perf${i}@cavendish.ac.ug`, fullName: `Perf Student ${i}`, role: 'student' });
    studentRows.push({ profileId: pid, studentNo: `PERF-${i}`, nationality: i % 3 ? 'NG' : 'KE', studentType: 'new' });
    appRows.push({
      id: aid,
      ref: `VD-2026-${String(i + 1).padStart(5, '0')}`,
      studentId: pid,
      ruleSetId: rs.id,
      status: statuses[i % statuses.length]!,
      noPass,
      currentExpiry: noPass ? null : addDays(today, (i * 7919) % 200 - 20),
      feeStatus: i % 4 ? 'unpaid' : 'paid',
      submittedAt: now,
      lastActivityAt: now,
    });
    for (const code of ['visa_status_page', 'passport_data_page', 'passport_photos', 'student_id_face', 'proof_of_registration', 'admission_letter', 'fees_statement']) {
      docRows.push({ applicationId: aid, docCode: code, state: i % 2 ? 'approved' : 'uploaded', minFiles: code === 'admission_letter' ? 2 : 1 });
    }
  }
  await chunked(profileRows, 200, (p) => t.db.insert(profiles).values(p));
  await chunked(studentRows, 200, (p) => t.db.insert(students).values(p));
  await chunked(appRows, 100, (p) => t.db.insert(applications).values(p));
  await chunked(docRows, 300, (p) => t.db.insert(applicationDocuments).values(p));
}, 120_000);
afterAll(() => t.cleanup());

describe('dashboard query at scale', () => {
  it('first page of 50 + summary in < 1.5 s, sorted by risk band then expiry', async () => {
    await listApplicationsForStaff(staff, { limit: 50, today }); // warm the connection / statement cache
    const t0 = performance.now();
    const [page, summary] = await Promise.all([listApplicationsForStaff(staff, { limit: 50, today }), getDashboardSummary(staff, today)]);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(1500);
    expect(page.total).toBe(N);
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).toBeTruthy();
    expect(summary.readyForImmigration).toBe(N / 5);

    const keys = page.items.map((i) => [RISK_RANK[i.riskBand], i.noPass || !i.currentExpiry ? '9999-12-31' : i.currentExpiry] as const);
    for (let i = 1; i < keys.length; i++) {
      const [r0, e0] = keys[i - 1]!;
      const [r1, e1] = keys[i]!;
      expect(r0 < r1 || (r0 === r1 && e0 <= e1)).toBe(true);
    }
    expect(page.items[0]!.riskBand).toBe('expired');
    expect(page.items[0]!.docsRequired).toBe(7);
  });

  it('walks all pages with the cursor (no gaps, no duplicates) and each page is fast', async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const t0 = performance.now();
      const p = await listApplicationsForStaff(staff, { limit: 50, cursor, today });
      expect(performance.now() - t0).toBeLessThan(1500);
      p.items.forEach((i) => seen.add(i.id));
      cursor = p.nextCursor;
      pages++;
    } while (cursor && pages < 50);
    expect(seen.size).toBe(N);
    expect(pages).toBe(Math.ceil(N / 50));
  });

  it('filtered search stays fast', async () => {
    const t0 = performance.now();
    const r = await listApplicationsForStaff(staff, { filters: { q: 'perf-12', riskBand: ['expired', 'critical', 'urgent'], nationality: ['NG'] }, limit: 50, today });
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(r.items.every((i) => i.nationality === 'NG')).toBe(true);
  });
});
