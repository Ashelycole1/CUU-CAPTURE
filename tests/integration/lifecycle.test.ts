/** Full lifecycle (PRD §2, FR-SUB, FR-REV, FR-FEE, FR-PKT-3/4) through the services. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createStaff, createStudent, createTestDb, fakeSha, type TestDb } from '../helpers/db';
import { createDraft, createSubmittedApplication, docsOf, uploadAllRequired, uploadDoc } from '../helpers/factories';
import {
  claimApplication,
  closeApplication,
  getApplicationDetail,
  getChecklistForApplication,
  getOrCreateDraft,
  getSubmitBlockers,
  listReviewQueue,
  markApproved,
  markSentToImmigration,
  recordPassIssued,
  recordPayment,
  releaseClaim,
  reviewDocument,
  submitApplication,
  updateStudentProfile,
  withdrawApplication,
  startPacket,
  completePacket,
  listPackets,
  createRuleSetDraft,
  publishRuleSet,
  getActiveRuleSet,
} from '@/server/services';
import { applicationEvents, applications, auditLog, students } from '@/server/db/schema';
import { ConflictError, InvalidStateError, ValidationError } from '@/server/errors';
import { verifyAuditChain } from '@/server/audit';
import { RULE_DOCUMENTS_V1, RULE_SET_V1 } from '@/server/db/seed-data';
import type { Actor } from '@/server/authz';

let t: TestDb;
let staff: Actor;
let staff2: Actor;

beforeAll(async () => {
  t = await createTestDb();
  staff = await createStaff(t.db);
  staff2 = await createStaff(t.db);
});
afterAll(() => t.cleanup());

describe('draft and checklist', () => {
  it('PRD story 1: continuing KE, 45 days → 8 items, fee waived, 15 days to apply-by', async () => {
    const { student, app } = await createDraft(t.db, { nationality: 'KE', studentType: 'continuing', expiryInDays: 45 });
    const c = await getChecklistForApplication(student, app.id);
    expect(c.items).toHaveLength(8);
    expect(c.feeRequired).toBe(false);
    expect(c.feeStatus).toBe('not_required');
    expect(c.runway.daysToApplyBy).toBe(15);
    expect(c.progress).toEqual({ done: 0, total: 8 });
  });

  it('getOrCreateDraft is idempotent (one active application, FR-APP-4)', async () => {
    const s = await createStudent(t.db);
    const [x, y] = await Promise.all([getOrCreateDraft(s), getOrCreateDraft(s)]);
    expect(x.id).toBe(y.id);
    const all = await t.db.select().from(applications).where(eq(applications.studentId, s.id));
    expect(all).toHaveLength(1);
  });

  it('profile change recomputes checklist; orphaned docs kept as not required (PRD §7)', async () => {
    const { student, app } = await createDraft(t.db, { nationality: 'NG', studentType: 'continuing' });
    await uploadDoc(student, app.id, 'exam_results');
    await updateStudentProfile(student, { studentType: 'masters' });
    const docs = await docsOf(t.db, app.id);
    const exam = docs.find((d) => d.docCode === 'exam_results')!;
    expect(exam.required).toBe(false);
    expect(exam.state).toBe('uploaded');
    expect(docs.find((d) => d.docCode === 'transcripts')!.required).toBe(true);
    const c = await getChecklistForApplication(student, app.id);
    expect(c.notRequired.map((d) => d.docCode)).toEqual(['exam_results']);
    // Changing nationality to an exempt country waives the fee.
    await updateStudentProfile(student, { nationality: 'RW' });
    expect((await getChecklistForApplication(student, app.id)).feeStatus).toBe('not_required');
  });

  it('blocks a duplicate student number (PRD §7)', async () => {
    const s1 = await createStudent(t.db, { studentNo: 'DUP-001' });
    const s2 = await createStudent(t.db);
    expect(s1).toBeTruthy();
    await expect(updateStudentProfile(s2, { studentNo: 'dup-001' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('duplicate hash across document types is flagged (FR-UP-6)', async () => {
    const { student, app } = await createDraft(t.db);
    await uploadDoc(student, app.id, 'passport_data_page', { sha: fakeSha('same') });
    const r = await uploadDoc(student, app.id, 'visa_status_page', { sha: fakeSha('same') });
    expect(r.duplicateOf).toEqual(['passport_data_page']);
  });

  it('multi-page items become uploaded only when all pages are present (FR-CHK-5)', async () => {
    const { student, app } = await createDraft(t.db);
    const r1 = await uploadDoc(student, app.id, 'admission_letter', { pages: 1 });
    expect(r1.document.state).toBe('missing');
    const r2 = await uploadDoc(student, app.id, 'admission_letter', { pages: 2 });
    expect(r2.document.state).toBe('uploaded');
  });
});

describe('submission (FR-SUB)', () => {
  it('refuses to submit with missing documents and explains', async () => {
    const { student, app } = await createDraft(t.db);
    const blockers = await getSubmitBlockers(student, app.id);
    expect(blockers.missingDocs.length).toBe(7);
    await expect(submitApplication(student, app.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it('submits, assigns VD-YYYY-NNNNN, freezes, and queues a receipt', async () => {
    const { student, app } = await createSubmittedApplication(t.db, { nationality: 'NG' });
    expect(app.status).toBe('submitted');
    expect(app.ref).toMatch(/^VD-\d{4}-\d{5}$/);
    expect(app.feeStatus).toBe('unpaid');
    await expect(updateStudentProfile(student, { programme: 'Other' })).rejects.toBeInstanceOf(InvalidStateError);
    await expect(uploadDoc(student, app.id, 'passport_data_page')).rejects.toBeInstanceOf(InvalidStateError);
    await expect(submitApplication(student, app.id)).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('refs are sequential and unique', async () => {
    const r1 = await createSubmittedApplication(t.db);
    const r2 = await createSubmittedApplication(t.db);
    const n1 = Number(r1.app.ref!.slice(-5));
    const n2 = Number(r2.app.ref!.slice(-5));
    expect(n2).toBe(n1 + 1);
  });
});

describe('review → corrections → fix → approve → immigration → pass (golden path)', () => {
  it('runs the full lifecycle and rejects invalid transitions', async () => {
    const { student, app } = await createSubmittedApplication(t.db, { nationality: 'NG', studentType: 'new' });
    // Invalid: cannot approve a submitted application or send it to immigration.
    await expect(markApproved(staff, app.id)).rejects.toBeInstanceOf(InvalidStateError);
    await expect(markSentToImmigration(staff, app.id, { method: 'email' })).rejects.toBeInstanceOf(InvalidStateError);
    await expect(startPacket(staff, app.id)).rejects.toBeInstanceOf(InvalidStateError);

    // Claim → under_review; another reviewer is blocked (FR-REV-6).
    const claimed = await claimApplication(staff, app.id);
    expect(claimed.status).toBe('under_review');
    await expect(claimApplication(staff2, app.id)).rejects.toBeInstanceOf(ConflictError);

    const queue = await listReviewQueue(staff, { applicationId: app.id });
    expect(queue.items).toHaveLength(7);
    expect(queue.items[0]!.versionIds.length).toBeGreaterThan(0);

    const docs = await docsOf(t.db, app.id);
    const passport = docs.find((d) => d.docCode === 'passport_data_page')!;
    for (const d of docs.filter((x) => x.required)) {
      if (d.id === passport.id) continue;
      const r = await reviewDocument(staff, { documentId: d.id, decision: 'approve' });
      expect(r.allDecided).toBe(false);
    }
    // Rejection without a reason is refused.
    await expect(reviewDocument(staff, { documentId: passport.id, decision: 'reject' })).rejects.toBeInstanceOf(ValidationError);
    const rej = await reviewDocument(staff, { documentId: passport.id, decision: 'reject', reasonCode: 'glare', note: 'Right side' });
    expect(rej.allDecided).toBe(true);
    expect(rej.correctionsNotified).toBe(true);
    expect(rej.application.status).toBe('corrections_needed');

    // Only the rejected document is re-openable (PRD story 3).
    const c = await getChecklistForApplication(student, app.id);
    expect(c.items.filter((i) => i.canUpload).map((i) => i.item.code)).toEqual(['passport_data_page']);
    await expect(uploadDoc(student, app.id, 'visa_status_page')).rejects.toBeInstanceOf(InvalidStateError);

    // Fix → back to under_review automatically.
    const fixed = await uploadDoc(student, app.id, 'passport_data_page');
    expect(fixed.document.state).toBe('uploaded');
    expect(fixed.document.reviewerReasonCode).toBeNull();
    expect(fixed.application.status).toBe('under_review');

    // Approve the fix; all approved → still under_review until one-click approve.
    const ok = await reviewDocument(staff, { documentId: passport.id, decision: 'approve' });
    expect(ok.allDecided).toBe(true);
    expect(ok.correctionsNotified).toBe(false);
    expect(ok.application.status).toBe('under_review');
    // Approved documents are locked.
    await expect(reviewDocument(staff, { documentId: passport.id, decision: 'reject', reasonCode: 'blurry' })).rejects.toBeInstanceOf(InvalidStateError);

    const approved = await markApproved(staff, app.id);
    expect(approved.status).toBe('approved');
    expect(approved.claimedBy).toBeNull();
    await expect(withdrawApplication(student, app.id)).rejects.toBeInstanceOf(InvalidStateError);

    // Fee (FR-FEE-2).
    const pay = await recordPayment(staff, app.id, { amountUgx: 370000, paidOn: '2026-10-20', reference: 'RCPT-1' });
    expect(pay.amountUgx).toBe(370000);

    // Packet record (FR-PKT-1/3).
    const p = await startPacket(staff, app.id);
    expect(p.status).toBe('generating');
    const done = await completePacket(staff, p.id, {
      storageKey: `packets/${app.id}/${p.id}.zip`,
      sha256: fakeSha('zip'),
      bytes: 1234,
      manifest: { generatedAt: new Date().toISOString(), applicationRef: app.ref, files: [] },
    });
    expect(done.status).toBe('ready');
    expect('storageKey' in done).toBe(false);

    const sent = await markSentToImmigration(staff, app.id, { method: 'in_person', sentOn: '2026-10-21' });
    expect(sent.status).toBe('sent_to_immigration');
    expect(sent.sentMethod).toBe('in_person');
    expect((await listPackets(staff, app.id))[0]!.sentMethod).toBe('in_person');

    const issued = await recordPassIssued(staff, app.id, { newExpiry: '2027-10-21' });
    expect(issued.status).toBe('pass_issued');
    const st = (await t.db.select().from(students).where(eq(students.profileId, student.id)))[0]!;
    expect(st.passExpiry).toBe('2027-10-21');

    const closed = await closeApplication(staff, app.id);
    expect(closed.status).toBe('closed');
    await expect(closeApplication(staff, app.id)).rejects.toBeInstanceOf(InvalidStateError);

    // Timeline (student view) has the transitions; audit chain intact.
    const detail = await getApplicationDetail(student, app.id);
    const transitions = detail.events.filter((e) => e.type === 'status_changed').map((e) => (e.data as { to: string }).to);
    expect(transitions).toEqual([
      'submitted',
      'under_review',
      'corrections_needed',
      'under_review',
      'approved',
      'sent_to_immigration',
      'pass_issued',
      'closed',
    ]);
    const audits = await t.db.select().from(auditLog).where(and(eq(auditLog.targetType, 'application'), eq(auditLog.targetId, app.id)));
    expect(audits.length).toBeGreaterThanOrEqual(8);
    expect((await verifyAuditChain(t.db)).ok).toBe(true);

    // After closing, the student can start a new application.
    const next = await getOrCreateDraft(student);
    expect(next.id).not.toBe(app.id);
  });

  it('claims expire after 15 minutes and can be released', async () => {
    const { app } = await createSubmittedApplication(t.db);
    const now = new Date();
    await claimApplication(staff, app.id, now);
    await expect(claimApplication(staff2, app.id, new Date(now.getTime() + 14 * 60_000))).rejects.toBeInstanceOf(ConflictError);
    const taken = await claimApplication(staff2, app.id, new Date(now.getTime() + 16 * 60_000));
    expect(taken.claimedBy).toBe(staff2.id);
    await expect(releaseClaim(staff, app.id)).rejects.toBeInstanceOf(ConflictError);
    const released = await releaseClaim(staff2, app.id);
    expect(released.claimedBy).toBeNull();
  });

  it('student can withdraw a submitted application', async () => {
    const { student, app } = await createSubmittedApplication(t.db);
    const w = await withdrawApplication(student, app.id);
    expect(w.status).toBe('withdrawn');
    const evs = await t.db.select().from(applicationEvents).where(eq(applicationEvents.applicationId, app.id));
    expect(evs.some((e) => e.type === 'status_changed' && (e.data as { to: string }).to === 'withdrawn')).toBe(true);
  });
});

describe('rule sets (FR-ADM-1)', () => {
  it('publishing a new version keeps in-flight applications on their version', async () => {
    const { student, app } = await createDraft(t.db, { nationality: 'NG', studentType: 'new' });
    const { createAdmin } = await import('../helpers/db');
    const admin = await createAdmin(t.db);
    const draft = await createRuleSetDraft(admin, {
      ...RULE_SET_V1,
      feeUsd: 120,
      documents: [
        ...RULE_DOCUMENTS_V1,
        {
          code: 'medical_form',
          name: 'Medical form',
          helpText: '',
          whereToGet: '',
          appliesToTypes: null,
          minFiles: 1,
          source: 'notice',
          sort: 10,
        },
      ],
    });
    expect(draft.version).toBe(2);
    await publishRuleSet(admin, draft.id);
    expect((await getActiveRuleSet()).version).toBe(2);
    const c = await getChecklistForApplication(student, app.id);
    expect(c.ruleSetVersion).toBe(1);
    expect(c.items.map((i) => i.item.code)).not.toContain('medical_form');
    // A new student gets v2.
    const s2 = await createStudent(t.db, { nationality: 'NG', studentType: 'new' });
    const app2 = await getOrCreateDraft(s2);
    const c2 = await getChecklistForApplication(s2, app2.id);
    expect(c2.ruleSetVersion).toBe(2);
    expect(c2.items.map((i) => i.item.code)).toContain('medical_form');
    await expect(publishRuleSet(admin, draft.id)).rejects.toBeInstanceOf(InvalidStateError);
    // Uploading all and submitting still works under v1.
    await uploadAllRequired(t.db, student, app.id);
    expect((await submitApplication(student, app.id)).status).toBe('submitted');
  });
});
