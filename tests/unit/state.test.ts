import { describe, expect, it } from 'vitest';
import {
  APPLICATION_TRANSITIONS,
  assertTransition,
  canStudentUpload,
  canTransition,
  nextDocumentState,
  TransitionError,
} from '@/domain/state';
import { APPLICATION_STATUSES } from '@/domain/types';
import { studentStatusCopy, documentStateChip } from '@/domain/status';
import { profileSchema, applicationFieldsSchema, reviewDecisionSchema } from '@/domain/schemas';
import { t } from '@/i18n';

describe('application state machine (PRD §2)', () => {
  it('follows the golden path', () => {
    expect(assertTransition('draft', 'submit')).toBe('submitted');
    expect(assertTransition('submitted', 'start_review')).toBe('under_review');
    expect(assertTransition('under_review', 'request_corrections')).toBe('corrections_needed');
    expect(assertTransition('corrections_needed', 'corrections_resubmitted')).toBe('under_review');
    expect(assertTransition('under_review', 'approve')).toBe('approved');
    expect(assertTransition('approved', 'send_to_immigration')).toBe('sent_to_immigration');
    expect(assertTransition('sent_to_immigration', 'record_pass_issued')).toBe('pass_issued');
    expect(assertTransition('pass_issued', 'close')).toBe('closed');
  });
  it('rejects invalid transitions', () => {
    expect(() => assertTransition('draft', 'approve')).toThrow(TransitionError);
    expect(canTransition('submitted', 'approve')).toBe(false);
    expect(canTransition('approved', 'withdraw')).toBe(false);
    expect(canTransition('closed', 'submit')).toBe(false);
    expect(canTransition('withdrawn', 'submit')).toBe(false);
  });
  it('terminal states have no exits', () => {
    expect(Object.keys(APPLICATION_TRANSITIONS.closed)).toHaveLength(0);
    expect(Object.keys(APPLICATION_TRANSITIONS.withdrawn)).toHaveLength(0);
  });
  it('every status has student-facing copy (design §13)', () => {
    for (const s of APPLICATION_STATUSES) expect(studentStatusCopy(s).label).toBeTruthy();
    expect(studentStatusCopy('pass_issued', { newExpiry: '2027-10-23' }).explanation).toBe('Your new pass expires on 23 Oct 2027.');
    expect(studentStatusCopy('corrections_needed').label).toBe('Needs your attention');
  });
});

describe('document state machine', () => {
  it('missing → uploaded → approved|rejected → uploaded', () => {
    expect(nextDocumentState('missing', 'upload')).toBe('uploaded');
    expect(nextDocumentState('uploaded', 'approve')).toBe('approved');
    expect(nextDocumentState('uploaded', 'reject')).toBe('rejected');
    expect(nextDocumentState('rejected', 'upload')).toBe('uploaded');
    expect(nextDocumentState('approved', 'upload')).toBeNull();
    expect(nextDocumentState('missing', 'approve')).toBeNull();
  });
  it('students can only change rejected docs after submit (FR-SUB-4)', () => {
    expect(canStudentUpload('draft', 'missing')).toBe(true);
    expect(canStudentUpload('draft', 'uploaded')).toBe(true);
    expect(canStudentUpload('submitted', 'uploaded')).toBe(false);
    expect(canStudentUpload('corrections_needed', 'rejected')).toBe(true);
    expect(canStudentUpload('corrections_needed', 'uploaded')).toBe(false);
    expect(canStudentUpload('draft', 'approved')).toBe(false);
    expect(canStudentUpload('approved', 'rejected')).toBe(false);
  });
  it('chips carry text labels', () => {
    expect(documentStateChip('rejected').label).toBe('Needs fixing');
    expect(documentStateChip('approved', false).label).toBe('Not required');
  });
});

describe('shared schemas', () => {
  it('validates a profile and normalises nationality', () => {
    const r = profileSchema.parse({ fullName: 'Amani W', studentNo: 'cuu-1', nationality: 'ke', studentType: 'continuing', programme: 'BSc CS', phone: '' });
    expect(r.nationality).toBe('KE');
    expect(r.studentNo).toBe('CUU-1');
    expect(r.phone).toBeUndefined();
  });
  it('requires an expiry unless no pass', () => {
    expect(applicationFieldsSchema.safeParse({ requestedMonths: 12 }).success).toBe(false);
    expect(applicationFieldsSchema.safeParse({ requestedMonths: 12, noPass: true }).success).toBe(true);
    expect(applicationFieldsSchema.safeParse({ requestedMonths: 5, noPass: true }).success).toBe(false);
  });
  it('rejection requires a reason; other requires a note (FR-REV-3)', () => {
    expect(reviewDecisionSchema.safeParse({ documentId: 'd', decision: 'reject' }).success).toBe(false);
    expect(reviewDecisionSchema.safeParse({ documentId: 'd', decision: 'reject', reasonCode: 'other' }).success).toBe(false);
    expect(reviewDecisionSchema.safeParse({ documentId: 'd', decision: 'reject', reasonCode: 'glare' }).success).toBe(true);
    expect(reviewDecisionSchema.safeParse({ documentId: 'd', decision: 'approve' }).success).toBe(true);
  });
  it('i18n interpolates', () => {
    expect(t('auth.codeSentTo', { email: 'a@b.c' })).toBe('We sent a 6-digit code to a@b.c.');
  });
});
