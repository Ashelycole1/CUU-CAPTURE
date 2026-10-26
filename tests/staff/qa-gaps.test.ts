/**
 * Wave 3 gap fixes: getProfileNames (ST-08 names instead of "Staff"), emailBounced on
 * the profile view (detail "unreachable" badge), per-student Runway flags + draft id
 * (detail flags, dashboard "Not applied yet"), and the student deletion actions (FR-AUD-3).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createStaff, createStudent, createTestDb, createUser, type TestDb } from '../helpers/db';
import { createDraft, createSubmittedApplication } from '../helpers/factories';
import { applications, deletionRequests, profiles, runwayFlags } from '@/server/db/schema';
import { getApplicationDetail, getProfileNames } from '@/server/services';
import { listOpenRunwayFlags } from '@/server/services/runway-flags';
import * as studentActions from '@/app/(student)/actions';
import type { Actor } from '@/server/authz';
import { addDays, todayInKampala } from '@/domain/dates';
import { setActor } from './helpers';

vi.mock('@/server/auth/current', async () => (await import('./helpers')).authMock());
vi.mock('next/server', async (orig) => (await import('./helpers')).nextServerMock(orig));
vi.mock('next/cache', async () => (await import('./helpers')).nextCacheMock());

let t: TestDb;
let staff: Actor;

beforeAll(async () => {
  t = await createTestDb();
  staff = await createStaff(t.db);
});
afterAll(() => t.cleanup());

async function flag(studentId: string, day: number, expiryInDays: number) {
  await t.db.insert(runwayFlags).values({
    studentId,
    expiry: addDays(todayInKampala(), expiryInDays),
    day,
    band: 'urgent',
    flaggedAt: new Date().toISOString(),
  });
}

describe('getProfileNames', () => {
  it('returns names for staff and students, email local part as fallback, skips unknown/system/deleted', async () => {
    const named = await createUser(t.db, { role: 'dos_admin', fullName: 'Grace Namuli' });
    const unnamed = await createUser(t.db, { role: 'dos_staff', email: 'okello.j@cavendish.ac.ug' });
    await t.db.update(profiles).set({ fullName: null }).where(eq(profiles.id, unnamed.id));
    const gone = await createUser(t.db, { role: 'dos_staff', fullName: 'Former Staff' });
    await t.db.update(profiles).set({ deletedAt: new Date().toISOString() }).where(eq(profiles.id, gone.id));
    const student = await createStudent(t.db, { fullName: 'Achieng Otieno' });

    const names = await getProfileNames(staff, [named.id, unnamed.id, gone.id, student.id, null, 'system', 'nope', named.id]);
    expect(names).toEqual({ [named.id]: 'Grace Namuli', [unnamed.id]: 'okello.j', [student.id]: 'Achieng Otieno' });
    expect(await getProfileNames(staff, [])).toEqual({});
  });

  it('is staff-only', async () => {
    const student = await createStudent(t.db);
    await expect(getProfileNames(student, [staff.id])).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('student unreachable on the detail view', () => {
  it('exposes emailBounced from profiles.email_status', async () => {
    const { student, app } = await createSubmittedApplication(t.db, {});
    expect((await getApplicationDetail(staff, app.id)).student.emailBounced).toBe(false);
    await t.db.update(profiles).set({ emailStatus: 'bounced' }).where(eq(profiles.id, student.id));
    expect((await getApplicationDetail(staff, app.id)).student.emailBounced).toBe(true);
  });
});

describe('listOpenRunwayFlags', () => {
  it('filters by student and reports the draft application id (null = no application)', async () => {
    const noApp = await createStudent(t.db, { fullName: 'No App' });
    const { student: withDraft, app: draft } = await createDraft(t.db, { expiryInDays: 10 });
    await flag(noApp.id, 7, 5);
    await flag(withDraft.id, 14, 10);

    const mine = await listOpenRunwayFlags(staff, { studentId: withDraft.id });
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ studentId: withDraft.id, day: 14, draftApplicationId: draft.id, daysToExpiry: 10 });

    const none = await listOpenRunwayFlags(staff, { studentId: noApp.id });
    expect(none[0]).toMatchObject({ draftApplicationId: null, day: 7 });

    const all = await listOpenRunwayFlags(staff, { limit: 10 });
    expect(all.map((f) => f.studentId)).toEqual(expect.arrayContaining([noApp.id, withDraft.id]));
  });
});

describe('student account deletion actions', () => {
  it('blocks while an application is submitted', async () => {
    const { student } = await createSubmittedApplication(t.db, {});
    setActor(student);
    const r = await studentActions.requestAccountDeletionAction(true);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.code).toBe('INVALID_STATE');
  });

  it('withdraws a draft only when confirmed, then requests; cancel works; staff are refused', async () => {
    const { student, app } = await createDraft(t.db, {});
    setActor(student);
    const refused = await studentActions.requestAccountDeletionAction(false);
    expect(refused.ok).toBe(false);
    expect((await t.db.select().from(applications).where(eq(applications.id, app.id)))[0]!.status).toBe('draft');

    expect((await studentActions.requestAccountDeletionAction(true)).ok).toBe(true);
    expect((await t.db.select().from(applications).where(eq(applications.id, app.id)))[0]!.status).toBe('withdrawn');
    const reqs = await t.db.select().from(deletionRequests).where(eq(deletionRequests.profileId, student.id));
    expect(reqs.map((x) => x.status)).toEqual(['pending']);
    // Idempotent while pending.
    expect((await studentActions.requestAccountDeletionAction(true)).ok).toBe(true);
    expect(await t.db.select().from(deletionRequests).where(eq(deletionRequests.profileId, student.id))).toHaveLength(1);

    expect((await studentActions.cancelAccountDeletionAction()).ok).toBe(true);
    expect((await t.db.select().from(deletionRequests).where(eq(deletionRequests.profileId, student.id)))[0]!.status).toBe('rejected');

    setActor(staff);
    const r = await studentActions.requestAccountDeletionAction(true);
    expect(r.ok === false && r.error.code).toBe('FORBIDDEN');
    setActor(null);
    const u = await studentActions.cancelAccountDeletionAction();
    expect(u.ok === false && u.error.code).toBe('UNAUTHENTICATED');
  });
});
