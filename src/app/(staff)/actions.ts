'use server';
/**
 * Staff server actions. Every action re-checks the role (staff/admin) and then
 * calls a service, which authorizes again and writes event + audit rows in one
 * transaction. Notifications queued by services are delivered after the response
 * with `after(() => flushNotifications())` (CONTRACTS §4).
 *
 * Return shape: `{ ok: true, ... }` or `{ ok: false, error: { code, message, fieldErrors? } }`.
 */
import { after } from 'next/server';
import { revalidatePath } from 'next/cache';
import { requireActorOrThrow } from '@/server/auth/current';
import { toErrorBody, type ErrorBody } from '@/server/errors';
import { flushNotifications } from '@/server/notify';
import {
  claimApplication,
  closeApplication,
  createSavedView,
  deleteSavedView,
  getApplicationDetail,
  markApproved,
  markSentToImmigration,
  postMessage,
  recordPassIssued,
  releaseClaim,
  reviewDocument,
  setFeeStatus,
  type ReviewResult,
} from '@/server/services';
import { buildPacket } from '@/server/services/packet-builder';
import type { FeeStatus, SentMethod, StaffListFilters, StaffSort } from '@/domain';
import { staffText } from '@/i18n/staff';

const STAFF = ['dos_staff', 'dos_admin'] as const;
const MAX_BULK = 100;
const MAX_BULK_EXPORT = 10;

export type ActionError = { ok: false } & ErrorBody;
export type ActionResult<T extends object = object> = ({ ok: true } & T) | ActionError;

async function staffActor() {
  return requireActorOrThrow(STAFF);
}

function fail(e: unknown): ActionError {
  return { ok: false, ...toErrorBody(e).body };
}

function deliver() {
  after(() => flushNotifications().then(() => undefined));
}

function refresh(applicationId?: string) {
  revalidatePath('/dashboard');
  if (applicationId) revalidatePath(`/applications/${applicationId}`);
}

// ---------------------------------------------------------------- lifecycle

export async function approveApplicationAction(applicationId: string): Promise<ActionResult> {
  try {
    const actor = await staffActor();
    await markApproved(actor, applicationId);
    deliver();
    refresh(applicationId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function markSentAction(applicationId: string, input: { method: SentMethod; sentOn?: string }): Promise<ActionResult> {
  try {
    const actor = await staffActor();
    await markSentToImmigration(actor, applicationId, { method: input.method, sentOn: input.sentOn || undefined });
    deliver();
    refresh(applicationId);
    revalidatePath('/packets');
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function recordPassIssuedAction(applicationId: string, input: { newExpiry: string }): Promise<ActionResult> {
  try {
    const actor = await staffActor();
    await recordPassIssued(actor, applicationId, { newExpiry: input.newExpiry });
    deliver();
    refresh(applicationId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function closeApplicationAction(applicationId: string): Promise<ActionResult> {
  try {
    const actor = await staffActor();
    await closeApplication(actor, applicationId);
    refresh(applicationId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function setFeeStatusAction(applicationId: string, feeStatus: FeeStatus): Promise<ActionResult> {
  try {
    const actor = await staffActor();
    await setFeeStatus(actor, applicationId, feeStatus);
    refresh(applicationId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------- claims

export async function claimAction(applicationId: string): Promise<ActionResult<{ claimedUntil: string | null }>> {
  try {
    const actor = await staffActor();
    const app = await claimApplication(actor, applicationId);
    return { ok: true, claimedUntil: app.claimedUntil };
  } catch (e) {
    return fail(e);
  }
}

export async function releaseClaimAction(applicationId: string): Promise<ActionResult> {
  try {
    const actor = await staffActor();
    await releaseClaim(actor, applicationId);
    refresh(applicationId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------- review

export async function reviewDocumentAction(input: {
  documentId: string;
  decision: 'approve' | 'reject';
  reasonCode?: string | null;
  note?: string | null;
}): Promise<ActionResult<{ result: Pick<ReviewResult, 'allDecided' | 'correctionsNotified'> & { status: string; claimedUntil: string | null } }>> {
  try {
    const actor = await staffActor();
    const r = await reviewDocument(actor, {
      documentId: input.documentId,
      decision: input.decision,
      reasonCode: input.decision === 'reject' ? input.reasonCode : null,
      note: input.note?.trim() || null,
    });
    deliver(); // FR-REV-5: the batched corrections email (if this was the last pending doc)
    refresh(r.application.id);
    return {
      ok: true,
      result: { allDecided: r.allDecided, correctionsNotified: r.correctionsNotified, status: r.application.status, claimedUntil: r.application.claimedUntil },
    };
  } catch (e) {
    return fail(e);
  }
}

export interface ReviewContext {
  applicationId: string;
  ref: string | null;
  status: string;
  claimedBy: string | null;
  claimedUntil: string | null;
  student: {
    fullName: string | null;
    email: string;
    studentNo: string | null;
    nationality: string | null;
    studentType: string | null;
    programme: string | null;
  };
  currentExpiry: string | null;
  noPass: boolean;
  requestedMonths: number | null;
  submittedAt: string | null;
}

/** Read-only: the student's entered data for side-by-side comparison (FR-REV-2). */
export async function getReviewContextAction(applicationId: string): Promise<ActionResult<{ context: ReviewContext }>> {
  try {
    const actor = await staffActor();
    const d = await getApplicationDetail(actor, applicationId);
    const a = d.application;
    return {
      ok: true,
      context: {
        applicationId: a.id,
        ref: a.ref,
        status: a.status,
        claimedBy: a.claimedBy,
        claimedUntil: a.claimedUntil,
        student: {
          fullName: d.student.fullName,
          email: d.student.email,
          studentNo: d.student.studentNo,
          nationality: d.student.nationality,
          studentType: d.student.studentType,
          programme: d.student.programme,
        },
        currentExpiry: a.currentExpiry,
        noPass: a.noPass,
        requestedMonths: a.requestedMonths,
        submittedAt: a.submittedAt,
      },
    };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------- messages

export async function postMessageAction(applicationId: string, input: { body: string; internal: boolean }): Promise<ActionResult> {
  try {
    const actor = await staffActor();
    await postMessage(actor, applicationId, { body: input.body, internal: !!input.internal });
    if (!input.internal) deliver();
    refresh(applicationId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------- saved views

export async function createSavedViewAction(input: {
  name: string;
  filters: StaffListFilters & { sort?: StaffSort };
  shared?: boolean;
}): Promise<ActionResult<{ id: string }>> {
  try {
    const actor = await staffActor();
    const view = await createSavedView(actor, input);
    revalidatePath('/dashboard');
    return { ok: true, id: view.id };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteSavedViewAction(id: string): Promise<ActionResult> {
  try {
    const actor = await staffActor();
    await deleteSavedView(actor, id);
    revalidatePath('/dashboard');
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------- bulk (FR-DOS-3)

export interface BulkOutcome {
  done: string[];
  skipped: string[];
  failed: string[];
}

function cleanIds(ids: string[], max: number): string[] {
  return [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && x.length > 0 && x.length < 100))].slice(0, max);
}

/**
 * "Send reminder": posts a (non-internal) message to each student, which emails
 * them through the normal message notification (`message:{id}` dedupe) and shows
 * in their in-app thread. See DECISIONS (Staff UI) for why this reuses messages.
 */
export async function bulkRemindAction(ids: string[]): Promise<ActionResult<{ outcome: BulkOutcome }>> {
  try {
    const actor = await staffActor();
    const outcome: BulkOutcome = { done: [], skipped: [], failed: [] };
    for (const id of cleanIds(ids, MAX_BULK)) {
      try {
        await postMessage(actor, id, { body: staffText.dashboard.bulk.reminderBody, internal: false });
        outcome.done.push(id);
      } catch (e) {
        (toErrorBody(e).status < 500 ? outcome.skipped : outcome.failed).push(id);
      }
    }
    if (outcome.done.length) deliver();
    revalidatePath('/dashboard');
    return { ok: true, outcome };
  } catch (e) {
    return fail(e);
  }
}

/** "Mark fee paid" without a payment record (manual override, audited `application.fee_status_set`). */
export async function bulkMarkFeePaidAction(ids: string[]): Promise<ActionResult<{ outcome: BulkOutcome }>> {
  try {
    const actor = await staffActor();
    const outcome: BulkOutcome = { done: [], skipped: [], failed: [] };
    for (const id of cleanIds(ids, MAX_BULK)) {
      try {
        await setFeeStatus(actor, id, 'paid');
        outcome.done.push(id);
      } catch (e) {
        (toErrorBody(e).status < 500 ? outcome.skipped : outcome.failed).push(id);
      }
    }
    revalidatePath('/dashboard');
    return { ok: true, outcome };
  } catch (e) {
    return fail(e);
  }
}

/** "Export packets": builds a packet for each approved/sent application (max 10 per call). */
export async function bulkExportPacketsAction(
  ids: string[],
): Promise<ActionResult<{ outcome: BulkOutcome; packets: { applicationId: string; packetId: string; ref: string | null }[] }>> {
  try {
    const actor = await staffActor();
    const outcome: BulkOutcome = { done: [], skipped: [], failed: [] };
    const packets: { applicationId: string; packetId: string; ref: string | null }[] = [];
    const all = cleanIds(ids, MAX_BULK);
    outcome.skipped.push(...all.slice(MAX_BULK_EXPORT));
    for (const id of all.slice(0, MAX_BULK_EXPORT)) {
      try {
        const p = await buildPacket(actor, id);
        const ref = typeof p.manifest?.applicationRef === 'string' ? p.manifest.applicationRef : null;
        packets.push({ applicationId: id, packetId: p.id, ref });
        outcome.done.push(id);
      } catch (e) {
        (toErrorBody(e).status < 500 ? outcome.skipped : outcome.failed).push(id);
      }
    }
    revalidatePath('/packets');
    return { ok: true, outcome, packets };
  } catch (e) {
    return fail(e);
  }
}
