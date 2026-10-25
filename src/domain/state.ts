/**
 * Application and document state machines (PRD §2). Pure.
 * Services call `assertTransition` before every status change.
 */
import type { ApplicationStatus, DocumentState } from './types';

export type ApplicationAction =
  | 'submit'
  | 'start_review'
  | 'request_corrections'
  | 'corrections_resubmitted'
  | 'approve'
  | 'send_to_immigration'
  | 'record_pass_issued'
  | 'close'
  | 'withdraw';

/** from -> action -> to */
export const APPLICATION_TRANSITIONS: Record<ApplicationStatus, Partial<Record<ApplicationAction, ApplicationStatus>>> = {
  draft: { submit: 'submitted', withdraw: 'withdrawn' },
  submitted: { start_review: 'under_review', withdraw: 'withdrawn' },
  under_review: { request_corrections: 'corrections_needed', approve: 'approved', withdraw: 'withdrawn' },
  corrections_needed: { corrections_resubmitted: 'under_review', withdraw: 'withdrawn' },
  approved: { send_to_immigration: 'sent_to_immigration' },
  sent_to_immigration: { record_pass_issued: 'pass_issued', close: 'closed' },
  pass_issued: { close: 'closed' },
  closed: {},
  withdrawn: {},
};

export function nextStatus(from: ApplicationStatus, action: ApplicationAction): ApplicationStatus | null {
  return APPLICATION_TRANSITIONS[from][action] ?? null;
}

export function canTransition(from: ApplicationStatus, action: ApplicationAction): boolean {
  return nextStatus(from, action) !== null;
}

export class TransitionError extends Error {
  constructor(
    readonly from: ApplicationStatus,
    readonly action: ApplicationAction,
  ) {
    super(`Cannot ${action.replace(/_/g, ' ')} an application that is ${from.replace(/_/g, ' ')}`);
    this.name = 'TransitionError';
  }
}

export function assertTransition(from: ApplicationStatus, action: ApplicationAction): ApplicationStatus {
  const to = nextStatus(from, action);
  if (!to) throw new TransitionError(from, action);
  return to;
}

/** Statuses in which the student may edit profile/application fields (FR-SUB-4 freezes after submit). */
export const STUDENT_EDITABLE_STATUSES: readonly ApplicationStatus[] = ['draft'];

/** Statuses in which staff may review documents. */
export const REVIEWABLE_STATUSES: readonly ApplicationStatus[] = ['submitted', 'under_review', 'corrections_needed'];

export const TERMINAL_STATUSES: readonly ApplicationStatus[] = ['closed', 'withdrawn'];

// ------------------------------------------------------------- documents

export type DocumentAction = 'upload' | 'approve' | 'reject';

export const DOCUMENT_TRANSITIONS: Record<DocumentState, Partial<Record<DocumentAction, DocumentState>>> = {
  missing: { upload: 'uploaded' },
  uploaded: { upload: 'uploaded', approve: 'approved', reject: 'rejected' },
  rejected: { upload: 'uploaded' },
  approved: {},
};

export function nextDocumentState(from: DocumentState, action: DocumentAction): DocumentState | null {
  return DOCUMENT_TRANSITIONS[from][action] ?? null;
}

/**
 * May the student upload a (new version of a) document right now?
 * - draft: any document that is not approved
 * - after submit: only documents the DOS rejected (FR-SUB-4, PRD story 3)
 */
export function canStudentUpload(appStatus: ApplicationStatus, docState: DocumentState): boolean {
  if (docState === 'approved') return false;
  if (appStatus === 'draft') return true;
  if (appStatus === 'under_review' || appStatus === 'corrections_needed') return docState === 'rejected';
  return false;
}
