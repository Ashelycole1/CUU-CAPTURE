/** FR-AUD-2 retention sweep, FR-ADM-3 dry run, FR-AUD-3 account deletion. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createAdmin, createStaff, createTestDb, type TestDb } from '../helpers/db';
import { createDraft } from '../helpers/factories';
import { applicationEvents, applications, auditLog, documentVersions, messages, payments, profiles, students } from '@/server/db/schema';
import { planRetention, runRetentionSweep } from '@/server/jobs';
import { REMOVED_MESSAGE } from '@/server/jobs/retention';
import { verifyAuditChain } from '@/server/audit';
import { getBlobStore } from '@/server/storage';
import { withdrawApplication } from '@/server/services';
import { cancelDeletionRequest, decideDeletionRequest, listDeletionRequests, requestAccountDeletion } from '@/server/services/privacy';
import { ForbiddenError, InvalidStateError } from '@/server/errors';
import type { Actor } from '@/server/authz';
import { closedApplication, resetJobRuns } from './helpers';

let t: TestDb;
let staff: Actor;
let admin: Actor;

beforeAll(async () => {
  t = await createTestDb();
  staff = await createStaff(t.db);
  admin = await createAdmin(t.db);
});
afterAll(() => t.cleanup());

describe('retention sweep', () => {
  it('dry run equals the actual sweep; blobs deleted; personal data nulled; audit chain intact', async () => {
    const old = await closedApplication(t.db, staff, { closedDaysAgo: 120 });
    const recent = await closedApplication(t.db, staff, { closedDaysAgo: 10 });
    const store = getBlobStore();
    for (const k of old.keys) expect(await store.exists(k)).toBe(true);

    const auditBefore = await t.db.select().from(auditLog);
    const plan = await planRetention();
    expect(plan.retentionDays).toBe(90);
    expect(plan.applications.map((a) => a.applicationId)).toEqual([old.app.id]);
    expect(plan.totals.files).toBe(old.keys.length);
    expect(plan.totals.messages).toBe(1);
    expect(plan.totals.students).toBe(1);

    const result = await runRetentionSweep();
    expect(result.complete).toBe(true);
    expect(result.dryRun).toEqual(plan.totals);
    const { errors, ...done } = result.done;
    expect(errors).toBe(0);
    expect(done).toEqual(plan.totals);

    for (const k of old.keys) expect(await store.exists(k)).toBe(false);
    for (const k of recent.keys) expect(await store.exists(k)).toBe(true);

    const versions = await t.db.select().from(documentVersions).where(eq(documentVersions.applicationId, old.app.id));
    expect(versions.every((v) => v.deletedAt && v.storageKey === '' && v.thumbKey === null)).toBe(true);
    const msgs = await t.db.select().from(messages).where(eq(messages.applicationId, old.app.id));
    expect(msgs.every((m) => m.body === REMOVED_MESSAGE)).toBe(true);
    const pay = await t.db.select().from(payments).where(eq(payments.applicationId, old.app.id));
    expect(pay[0]!.receiptKey).toBeNull();
    expect(pay[0]!.reference).toBeNull();
    const app = (await t.db.select().from(applications).where(eq(applications.id, old.app.id)))[0]!;
    expect(app.purgedAt).toBeTruthy();
    expect(app.status).toBe('closed'); // anonymised aggregate row is kept
    const ev = await t.db.select().from(applicationEvents).where(eq(applicationEvents.applicationId, old.app.id));
    expect(ev.some((e) => e.type === 'purged')).toBe(true);

    const p = (await t.db.select().from(profiles).where(eq(profiles.id, old.student.id)))[0]!;
    expect(p.email).not.toBe(old.student.email);
    expect(p.fullName).toBeNull();
    expect(p.deletedAt).toBeTruthy();
    const s = (await t.db.select().from(students).where(eq(students.profileId, old.student.id)))[0]!;
    expect(s.studentNo).toBeNull();
    const recentStudent = (await t.db.select().from(profiles).where(eq(profiles.id, recent.student.id)))[0]!;
    expect(recentStudent.deletedAt).toBeNull();

    // audit_log: never modified; only appended; chain verifies.
    const auditAfter = await t.db.select().from(auditLog);
    expect(auditAfter.slice(0, auditBefore.length)).toEqual(auditBefore);
    expect(auditAfter.some((a) => a.action === 'retention.application_purged')).toBe(true);
    expect((await verifyAuditChain(t.db)).ok).toBe(true);
    expect(JSON.stringify(auditAfter.map((a) => a.meta))).not.toContain(old.student.email);
  });

  it('is idempotent: the same day is a no-op and the next plan is empty', async () => {
    const again = await runRetentionSweep();
    expect(again.alreadyDone).toBe(true);
    await resetJobRuns(t.db);
    const plan = await planRetention();
    expect(plan.totals.applications).toBe(0);
    const r = await runRetentionSweep();
    expect(r.done.applications).toBe(0);
  });

  it('respects the retention setting and includes withdrawn applications', async () => {
    const { student, app } = await createDraft(t.db);
    await withdrawApplication(student, app.id);
    await t.db.update(applications).set({ withdrawnAt: new Date(Date.now() - 100 * 86_400_000).toISOString() }).where(eq(applications.id, app.id));
    expect((await planRetention()).applications.map((a) => a.applicationId)).toContain(app.id);
    // 120 days later in the future = nothing at 365-day retention.
    const { updateSetting } = await import('@/server/services');
    await updateSetting(admin, 'retention_days', 365);
    expect((await planRetention()).applications.map((a) => a.applicationId)).not.toContain(app.id);
    await updateSetting(admin, 'retention_days', 90);
  });
});

describe('account deletion (FR-AUD-3)', () => {
  it('needs the cycle to be over, then an admin approval purges and anonymises now', async () => {
    const { student, app } = await createDraft(t.db);
    await expect(requestAccountDeletion(student)).rejects.toBeInstanceOf(InvalidStateError);
    await withdrawApplication(student, app.id);
    const req = await requestAccountDeletion(student);
    expect(req.status).toBe('pending');
    expect((await requestAccountDeletion(student)).id).toBe(req.id); // idempotent

    await expect(decideDeletionRequest(staff, req.id, 'approve')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listDeletionRequests(staff)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requestAccountDeletion(staff)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listDeletionRequests(admin)).map((r) => r.id)).toContain(req.id);

    const done = await decideDeletionRequest(admin, req.id, 'approve');
    expect(done.status).toBe('completed');
    const p = (await t.db.select().from(profiles).where(eq(profiles.id, student.id)))[0]!;
    expect(p.status).toBe('disabled');
    expect(p.email).toMatch(/^deleted\+/);
    const a = (await t.db.select().from(applications).where(eq(applications.id, app.id)))[0]!;
    expect(a.purgedAt).toBeTruthy();
    expect((await verifyAuditChain(t.db)).ok).toBe(true);
  });

  it('students can cancel; admins can decline', async () => {
    const { student, app } = await createDraft(t.db);
    await withdrawApplication(student, app.id);
    await requestAccountDeletion(student);
    await cancelDeletionRequest(student);
    const r2 = await requestAccountDeletion(student);
    const declined = await decideDeletionRequest(admin, r2.id, 'reject');
    expect(declined.status).toBe('rejected');
    await expect(decideDeletionRequest(admin, r2.id, 'approve')).rejects.toBeInstanceOf(InvalidStateError);
  });
});
