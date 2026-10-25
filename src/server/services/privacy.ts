import 'server-only';
/**
 * Account deletion (FR-AUD-3): a student asks for deletion after their cycle ends
 * (no active application); an admin approves, which purges every application's files
 * and personal fields and anonymises the profile right away (same code as the
 * retention sweep). The audit log keeps IDs only.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { ACTIVE_STATUSES } from '@/domain/types';
import { assertAdmin, type Actor } from '../authz';
import { getDb } from '../db/client';
import { deletionRequests, profiles } from '../db/schema';
import { ForbiddenError, InvalidStateError, NotFoundError } from '../errors';
import { anonymiseStudent, applicationIdsFor, purgeApplication } from '../jobs/retention';
import { notifyAdmins } from './applications';
import { audit, nowIso, withTx } from './internal';

export type DeletionRequest = typeof deletionRequests.$inferSelect;

function assertStudent(actor: Actor): void {
  if (actor.role !== 'student') throw new ForbiddenError('Only students can request account deletion');
}

/** Student: request deletion. Idempotent while a request is pending. */
export async function requestAccountDeletion(actor: Actor): Promise<DeletionRequest> {
  assertStudent(actor);
  return withTx(async (tx) => {
    const pending = (await tx.select().from(deletionRequests).where(and(eq(deletionRequests.profileId, actor.id), eq(deletionRequests.status, 'pending'))))[0];
    if (pending) return pending;
    const apps = await applicationIdsFor(tx, actor.id);
    if (apps.some((a) => (ACTIVE_STATUSES as readonly string[]).includes(a.status))) {
      throw new InvalidStateError('You can ask for deletion once your current application is finished or withdrawn.');
    }
    const [row] = await tx.insert(deletionRequests).values({ profileId: actor.id, requestedAt: nowIso() }).returning();
    await audit(tx, actor, 'privacy.deletion_requested', { type: 'deletion_request', id: row!.id });
    await notifyAdmins(tx, `deletion_request:${row!.id}`, null, 'A student asked for their account to be deleted. Review it on the Retention page.');
    return row!;
  });
}

/** Student: their latest request (any status), or null. */
export async function getMyDeletionRequest(actor: Actor): Promise<DeletionRequest | null> {
  assertStudent(actor);
  const rows = await getDb().select().from(deletionRequests).where(eq(deletionRequests.profileId, actor.id)).orderBy(desc(deletionRequests.requestedAt)).limit(1);
  return rows[0] ?? null;
}

/** Student: withdraw a pending request. */
export async function cancelDeletionRequest(actor: Actor): Promise<void> {
  assertStudent(actor);
  await withTx(async (tx) => {
    const pending = (await tx.select().from(deletionRequests).where(and(eq(deletionRequests.profileId, actor.id), eq(deletionRequests.status, 'pending'))))[0];
    if (!pending) throw new NotFoundError('Deletion request');
    await tx.update(deletionRequests).set({ status: 'rejected', decidedBy: actor.id, decidedAt: nowIso() }).where(eq(deletionRequests.id, pending.id));
    await audit(tx, actor, 'privacy.deletion_cancelled', { type: 'deletion_request', id: pending.id });
  });
}

export interface DeletionRequestView extends DeletionRequest {
  email: string;
  fullName: string | null;
}

export async function listDeletionRequests(actor: Actor, opts: { status?: DeletionRequest['status'][] } = {}): Promise<DeletionRequestView[]> {
  assertAdmin(actor);
  const statuses = opts.status ?? ['pending'];
  const rows = await getDb()
    .select({ r: deletionRequests, email: profiles.email, fullName: profiles.fullName })
    .from(deletionRequests)
    .innerJoin(profiles, eq(profiles.id, deletionRequests.profileId))
    .where(inArray(deletionRequests.status, statuses))
    .orderBy(desc(deletionRequests.requestedAt));
  return rows.map((x) => ({ ...x.r, email: x.email, fullName: x.fullName }));
}

/** Admin: approve (purge + anonymise now) or reject a pending request. */
export async function decideDeletionRequest(actor: Actor, requestId: string, decision: 'approve' | 'reject'): Promise<DeletionRequest> {
  assertAdmin(actor);
  const db = getDb();
  const req = (await db.select().from(deletionRequests).where(eq(deletionRequests.id, requestId)))[0];
  if (!req) throw new NotFoundError('Deletion request');
  if (req.status !== 'pending') throw new InvalidStateError('This request was already decided.');

  if (decision === 'reject') {
    await withTx(async (tx) => {
      await tx.update(deletionRequests).set({ status: 'rejected', decidedBy: actor.id, decidedAt: nowIso() }).where(eq(deletionRequests.id, req.id));
      await audit(tx, actor, 'privacy.deletion_rejected', { type: 'deletion_request', id: req.id });
    });
  } else {
    const apps = await applicationIdsFor(db, req.profileId);
    if (apps.some((a) => (ACTIVE_STATUSES as readonly string[]).includes(a.status))) {
      throw new InvalidStateError('The student has an active application. Close or withdraw it first.');
    }
    await withTx(async (tx) => {
      await tx.update(deletionRequests).set({ status: 'approved', decidedBy: actor.id, decidedAt: nowIso() }).where(eq(deletionRequests.id, req.id));
      await audit(tx, actor, 'privacy.deletion_approved', { type: 'deletion_request', id: req.id });
    });
    // Files are deleted outside transactions (network calls); each step is idempotent,
    // so a failure leaves the request `approved` and it can be retried.
    for (const a of apps) await purgeApplication(a.id, 'deletion_request');
    await withTx(async (tx) => {
      await anonymiseStudent(tx, req.profileId, 'deletion_request', actor.id);
      await tx.update(deletionRequests).set({ status: 'completed', completedAt: nowIso() }).where(eq(deletionRequests.id, req.id));
    });
  }
  return (await db.select().from(deletionRequests).where(eq(deletionRequests.id, req.id)))[0]!;
}
