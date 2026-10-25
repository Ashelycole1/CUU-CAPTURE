/**
 * PRD story 6 (isolation) + NFR-SEC: the authz module replaces RLS. Student A must
 * not read or mutate student B's application, documents, versions, messages or files,
 * students never see internal notes, and students cannot change staff-owned fields.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createStaff, createStudent, createTestDb, createAdmin, type TestDb } from '../helpers/db';
import { createDraft, createSubmittedApplication, docsOf, uploadDoc } from '../helpers/factories';
import {
  authorizeVersionFile,
  claimApplication,
  getApplicationDetail,
  getChecklistForApplication,
  getDashboardSummary,
  getStudentProfile,
  listApplicationsForStaff,
  listDocumentVersions,
  listMessages,
  listReviewQueue,
  markApproved,
  postMessage,
  prepareDocumentUpload,
  recordPayment,
  registerDocumentVersion,
  reviewDocument,
  submitApplication,
  updateApplicationFields,
  withdrawApplication,
  getOrCreateDraft,
  inviteStaff,
  publishRuleSet,
  markSentToImmigration,
  startPacket,
} from '@/server/services';
import { documentVersions, applications } from '@/server/db/schema';
import { ForbiddenError, NotFoundError } from '@/server/errors';
import type { Actor } from '@/server/authz';

let t: TestDb;
let a: Actor;
let b: Actor;
let staff: Actor;
let appA: string;
let appB: string;
let versionB: string;

beforeAll(async () => {
  t = await createTestDb();
  staff = await createStaff(t.db);
  const ra = await createSubmittedApplication(t.db, { nationality: 'KE', studentType: 'continuing' });
  a = ra.student;
  appA = ra.app.id;
  const rb = await createDraft(t.db, { nationality: 'NG', studentType: 'masters' });
  b = rb.student;
  appB = rb.app.id;
  const up = await uploadDoc(b, appB, 'passport_data_page');
  versionB = up.version.id;
  await postMessage(staff, appA, { body: 'Internal: check stamp', internal: true });
  await postMessage(staff, appA, { body: 'Hello A', internal: false });
});
afterAll(() => t.cleanup());

describe('student isolation (PRD story 6)', () => {
  it('cannot read another student application, checklist or detail (NotFound, no existence leak)', async () => {
    await expect(getApplicationDetail(a, appB)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getChecklistForApplication(a, appB)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getApplicationDetail(a, 'does-not-exist')).rejects.toBeInstanceOf(NotFoundError);
  });
  it('cannot read another student profile', async () => {
    await expect(getStudentProfile(a, b.id)).rejects.toBeInstanceOf(NotFoundError);
  });
  it('cannot read another student versions or files', async () => {
    const docB = (await docsOf(t.db, appB)).find((d) => d.docCode === 'passport_data_page')!;
    await expect(listDocumentVersions(a, docB.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(authorizeVersionFile(a, versionB)).rejects.toBeInstanceOf(NotFoundError);
    await expect(authorizeVersionFile(a, versionB, 'thumb')).rejects.toBeInstanceOf(NotFoundError);
    // Owner can.
    await expect(authorizeVersionFile(b, versionB)).resolves.toMatchObject({ contentType: 'image/jpeg' });
  });
  it('cannot read or post messages on another application', async () => {
    await expect(listMessages(b, appA)).rejects.toBeInstanceOf(NotFoundError);
    await expect(postMessage(b, appA, { body: 'hi' })).rejects.toBeInstanceOf(NotFoundError);
  });
  it('cannot mutate another student application or documents', async () => {
    await expect(updateApplicationFields(a, appB, { notes: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(submitApplication(a, appB)).rejects.toBeInstanceOf(NotFoundError);
    await expect(withdrawApplication(a, appB)).rejects.toBeInstanceOf(NotFoundError);
    await expect(prepareDocumentUpload(a, { applicationId: appB, docCode: 'passport_data_page' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      registerDocumentVersion(a, {
        applicationId: appB,
        docCode: 'visa_status_page',
        seq: 99,
        storageKey: `${appB}/visa_status_page/99.jpg`,
        sha256: 'a'.repeat(64),
        width: 2000,
        height: 1500,
        bytes: 1000,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const versions = await t.db.select().from(documentVersions).where(eq(documentVersions.applicationId, appB));
    expect(versions.every((v) => v.uploadedBy === b.id)).toBe(true);
  });
  it('getOrCreateDraft always returns the caller own application', async () => {
    const mine = await getOrCreateDraft(b);
    expect(mine.id).toBe(appB);
    expect(mine.studentId).toBe(b.id);
  });
});

describe('internal notes and staff-only data', () => {
  it('students never see internal messages', async () => {
    const msgs = await listMessages(a, appA);
    expect(msgs.map((m) => m.body)).toEqual(['Hello A']);
    const detail = await getApplicationDetail(a, appA);
    expect(detail.messages.some((m) => m.internal)).toBe(false);
  });
  it('staff see internal notes', async () => {
    const msgs = await listMessages(staff, appA);
    expect(msgs.some((m) => m.internal && m.body.startsWith('Internal'))).toBe(true);
  });
  it('students cannot post internal notes', async () => {
    await expect(postMessage(a, appA, { body: 'x', internal: true })).rejects.toBeInstanceOf(ForbiddenError);
  });
  it('student detail hides claim, reviewer ids, staff-only events, payments, packets and storage keys', async () => {
    await claimApplication(staff, appA);
    const d = await getApplicationDetail(a, appA);
    expect(d.application.claimedBy).toBeNull();
    expect(d.events.some((e) => e.type === 'claimed')).toBe(false);
    expect(d.documents.every((doc) => doc.reviewerId === null)).toBe(true);
    expect(d.documents.flatMap((doc) => doc.versions).every((v) => v.storageKey === '')).toBe(true);
    expect(d.payments).toEqual([]);
    const sd = await getApplicationDetail(staff, appA);
    expect(sd.application.claimedBy).toBe(staff.id);
    expect(sd.events.some((e) => e.type === 'claimed')).toBe(true);
  });
});

describe('students cannot perform staff actions (status, fee, reviewer fields)', () => {
  it('rejects every staff service for a student actor', async () => {
    const docA = (await docsOf(t.db, appA))[0]!;
    await expect(reviewDocument(a, { documentId: docA.id, decision: 'approve' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(markApproved(a, appA)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordPayment(a, appA, { amountUgx: 370000, paidOn: '2026-10-01' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(claimApplication(a, appA)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(markSentToImmigration(a, appA, { method: 'email' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(startPacket(a, appA)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listApplicationsForStaff(a)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listReviewQueue(a)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getDashboardSummary(a)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(inviteStaff(a, { email: 'x@y.z', role: 'dos_admin' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(publishRuleSet(a, 'x')).rejects.toBeInstanceOf(ForbiddenError);
  });
  it('the application fields patch ignores status/fee/reviewer fields', async () => {
    const s = await createStudent(t.db);
    const app = await getOrCreateDraft(s);
    // Extra keys are stripped by the schema; status and fee are unchanged.
    await updateApplicationFields(s, app.id, { notes: 'hello', status: 'approved', feeStatus: 'paid', claimedBy: s.id } as never);
    const row = (await t.db.select().from(applications).where(eq(applications.id, app.id)))[0]!;
    expect(row.status).toBe('draft');
    expect(row.feeStatus).not.toBe('paid');
    expect(row.claimedBy).toBeNull();
    expect(row.notes).toBe('hello');
  });
  it('staff cannot use student-only mutations on a student application', async () => {
    await expect(submitApplication(staff, appB)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateApplicationFields(staff, appB, { notes: 'x' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getOrCreateDraft(staff)).rejects.toBeInstanceOf(ForbiddenError);
  });
  it('only admins can invite staff', async () => {
    await expect(inviteStaff(staff, { email: 'new@cavendish.ac.ug', role: 'dos_staff' })).rejects.toBeInstanceOf(ForbiddenError);
    const admin = await createAdmin(t.db);
    const p = await inviteStaff(admin, { email: 'new@cavendish.ac.ug', role: 'dos_staff' });
    expect(p.role).toBe('dos_staff');
  });
});
