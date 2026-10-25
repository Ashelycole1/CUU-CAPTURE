import 'server-only';
/**
 * Retention sweep (FR-AUD-2, FR-ADM-3, NFR-PRIV).
 *
 * An application is eligible when it ended (`closed_at`, or `withdrawn_at` for a
 * withdrawn one) more than `retention_days` ago (setting, default 90) and has not been
 * purged. Purging:
 *   1. deletes every stored file of the application (document versions + thumbnails,
 *      packets, fee receipts) from the blob store;
 *   2. marks versions deleted and blanks their keys; nulls packet manifests (they hold
 *      file names with surnames), receipt keys and payment references; replaces
 *      message bodies; drops reviewer notes (row and timeline) and notification payloads;
 *      nulls the application's notes; sets `applications.purged_at`.
 * The application row itself (status, dates, rule-set version, fee status, review
 * rounds) stays as an anonymised aggregate for analytics.
 *
 * A student is anonymised when they have no active application, every application is
 * purged, and they have not signed in within the retention period: email replaced,
 * name/student number/phone/programme/nationality/pass expiry nulled, sessions, OTPs
 * and Runway flags removed, account disabled.
 *
 * `audit_log` is NEVER touched: by design it holds only IDs and codes (D-07), so the
 * hash chain still verifies after a sweep.
 *
 * `planRetention()` is the single source of truth for both the admin dry-run report and
 * the sweep, so "dry run == actual" holds by construction.
 */
import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { ACTIVE_STATUSES } from '@/domain/types';
import { writeAudit } from '../audit';
import { getDb, type DbOrTx, type Tx } from '../db/client';
import {
  applicationDocuments,
  applicationEvents,
  applications,
  documentVersions,
  messages,
  notifications,
  otpCodes,
  packets,
  payments,
  profiles,
  runwayFlags,
  sessions,
  students,
} from '../db/schema';
import { getRetentionDays } from '../services/settings';
import { withTx } from '../services/internal';
import { getBlobStore } from '../storage';
import { addStats, deadline, finishRun, saveProgress, startOrResumeRun } from './runner';

export const REMOVED_MESSAGE = '[removed by retention policy]';

export interface RetentionApplication {
  applicationId: string;
  ref: string | null;
  status: string;
  endedAt: string;
  /** Number of stored files that will be deleted. */
  files: number;
  versions: number;
  messages: number;
}

export interface RetentionStudent {
  profileId: string;
}

export interface RetentionPlan {
  retentionDays: number;
  /** Applications that ended before this instant are eligible. */
  cutoff: string;
  applications: RetentionApplication[];
  students: RetentionStudent[];
  totals: { applications: number; files: number; versions: number; messages: number; students: number };
}

function cutoffFor(now: Date, retentionDays: number): string {
  return new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
}

/** Storage keys of every file belonging to an application that is still present. */
export async function storedKeysFor(db: DbOrTx, applicationId: string): Promise<string[]> {
  const versions = await db
    .select({ key: documentVersions.storageKey, thumb: documentVersions.thumbKey })
    .from(documentVersions)
    .where(and(eq(documentVersions.applicationId, applicationId), isNull(documentVersions.deletedAt)));
  const pk = await db
    .select({ key: packets.storageKey })
    .from(packets)
    .where(and(eq(packets.applicationId, applicationId), isNotNull(packets.storageKey)));
  const rk = await db
    .select({ key: payments.receiptKey })
    .from(payments)
    .where(and(eq(payments.applicationId, applicationId), isNotNull(payments.receiptKey)));
  const keys = [
    ...versions.flatMap((v) => [v.key, v.thumb]),
    ...pk.map((p) => p.key),
    ...rk.map((r) => r.key),
  ].filter((k): k is string => typeof k === 'string' && k.length > 0);
  return [...new Set(keys)];
}

/** Dry run: what the next sweep would delete. Read-only. */
export async function planRetention(opts: { now?: Date; db?: DbOrTx } = {}): Promise<RetentionPlan> {
  const db = opts.db ?? getDb();
  const now = opts.now ?? new Date();
  const retentionDays = await getRetentionDays(db);
  const cutoff = cutoffFor(now, retentionDays);

  const apps = await db
    .select({
      id: applications.id,
      ref: applications.ref,
      status: applications.status,
      closedAt: applications.closedAt,
      withdrawnAt: applications.withdrawnAt,
    })
    .from(applications)
    .where(
      and(
        isNull(applications.purgedAt),
        or(
          and(eq(applications.status, 'closed'), lt(applications.closedAt, cutoff)),
          and(eq(applications.status, 'withdrawn'), lt(applications.withdrawnAt, cutoff)),
        ),
      ),
    )
    .orderBy(applications.id);

  const out: RetentionApplication[] = [];
  for (const a of apps) {
    const files = (await storedKeysFor(db, a.id)).length;
    const v = await db
      .select({ n: sql<number>`count(*)` })
      .from(documentVersions)
      .where(and(eq(documentVersions.applicationId, a.id), isNull(documentVersions.deletedAt)));
    const m = await db
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .where(and(eq(messages.applicationId, a.id), sql`${messages.body} != ${REMOVED_MESSAGE}`));
    out.push({
      applicationId: a.id,
      ref: a.ref,
      status: a.status,
      endedAt: (a.status === 'closed' ? a.closedAt : a.withdrawnAt) ?? '',
      files,
      versions: Number(v[0]?.n ?? 0),
      messages: Number(m[0]?.n ?? 0),
    });
  }

  const studentRows = await studentsToAnonymise(db, cutoff, new Set(out.map((a) => a.applicationId)));
  return {
    retentionDays,
    cutoff,
    applications: out,
    students: studentRows,
    totals: {
      applications: out.length,
      files: out.reduce((s, a) => s + a.files, 0),
      versions: out.reduce((s, a) => s + a.versions, 0),
      messages: out.reduce((s, a) => s + a.messages, 0),
      students: studentRows.length,
    },
  };
}

/**
 * Students whose every application is purged (or about to be, per `pendingPurge`),
 * with no active application and no sign-in since the cutoff.
 */
async function studentsToAnonymise(db: DbOrTx, cutoff: string, pendingPurge: Set<string>): Promise<RetentionStudent[]> {
  const rows = await db
    .select({ profileId: profiles.id, lastLoginAt: profiles.lastLoginAt, appId: applications.id, status: applications.status, purgedAt: applications.purgedAt })
    .from(profiles)
    .innerJoin(applications, eq(applications.studentId, profiles.id))
    .where(and(eq(profiles.role, 'student'), isNull(profiles.deletedAt)))
    .orderBy(profiles.id);
  const byStudent = new Map<string, { lastLoginAt: string | null; apps: { id: string; status: string; purged: boolean }[] }>();
  for (const r of rows) {
    const s = byStudent.get(r.profileId) ?? { lastLoginAt: r.lastLoginAt, apps: [] };
    s.apps.push({ id: r.appId, status: r.status, purged: !!r.purgedAt || pendingPurge.has(r.appId) });
    byStudent.set(r.profileId, s);
  }
  const out: RetentionStudent[] = [];
  for (const [profileId, s] of byStudent) {
    if (s.lastLoginAt && s.lastLoginAt >= cutoff) continue;
    if (s.apps.some((a) => (ACTIVE_STATUSES as readonly string[]).includes(a.status))) continue;
    if (s.apps.every((a) => a.purged)) out.push({ profileId });
  }
  return out;
}

/** Delete one application's files (outside any transaction: network calls). */
export async function deleteApplicationFiles(db: DbOrTx, applicationId: string): Promise<number> {
  const keys = await storedKeysFor(db, applicationId);
  const store = getBlobStore();
  for (const key of keys) await store.delete(key);
  return keys.length;
}

/** Null personal fields of one application (inside the caller's transaction). */
export async function scrubApplication(tx: Tx, applicationId: string, reason: 'retention' | 'deletion_request', files: number): Promise<void> {
  const now = new Date().toISOString();
  await tx
    .update(documentVersions)
    .set({ deletedAt: now, storageKey: '', thumbKey: null, quality: null })
    .where(and(eq(documentVersions.applicationId, applicationId), isNull(documentVersions.deletedAt)));
  await tx.update(packets).set({ storageKey: null, manifest: null, error: null }).where(eq(packets.applicationId, applicationId));
  await tx.update(payments).set({ receiptKey: null, reference: null }).where(eq(payments.applicationId, applicationId));
  await tx.update(messages).set({ body: REMOVED_MESSAGE }).where(eq(messages.applicationId, applicationId));
  await tx.update(applicationDocuments).set({ reviewerNote: null }).where(eq(applicationDocuments.applicationId, applicationId));
  // Timeline entries may carry a free-text reviewer note.
  await tx
    .update(applicationEvents)
    .set({ data: sql`json_remove(${applicationEvents.data}, '$.note')` })
    .where(and(eq(applicationEvents.applicationId, applicationId), sql`json_extract(${applicationEvents.data}, '$.note') IS NOT NULL`));
  await tx.update(notifications).set({ payload: {} }).where(eq(notifications.applicationId, applicationId));
  await tx.update(applications).set({ notes: null, purgedAt: now, updatedAt: now }).where(eq(applications.id, applicationId));
  await tx.insert(applicationEvents).values({ applicationId, type: 'purged', data: { reason }, actorId: null, visibleToStudent: false, at: now });
  await writeAudit(tx, { actorId: null, action: 'retention.application_purged', targetType: 'application', targetId: applicationId, meta: { reason, files } });
}

/** Anonymise a student profile (inside the caller's transaction). */
export async function anonymiseStudent(tx: Tx, profileId: string, reason: 'retention' | 'deletion_request', actorId: string | null = null): Promise<void> {
  const now = new Date().toISOString();
  const p = (await tx.select({ email: profiles.email }).from(profiles).where(eq(profiles.id, profileId)))[0];
  if (!p) return;
  await tx.delete(sessions).where(eq(sessions.profileId, profileId));
  await tx.delete(otpCodes).where(eq(otpCodes.email, p.email));
  await tx.delete(runwayFlags).where(eq(runwayFlags.studentId, profileId));
  await tx.update(notifications).set({ payload: {} }).where(eq(notifications.recipientId, profileId));
  await tx
    .update(students)
    .set({ studentNo: null, phone: null, programme: null, nationality: null, passExpiry: null, updatedAt: now })
    .where(eq(students.profileId, profileId));
  await tx
    .update(profiles)
    .set({ email: `deleted+${profileId}@invalid.invalid`, fullName: null, status: 'disabled', deletedAt: now, updatedAt: now })
    .where(eq(profiles.id, profileId));
  await writeAudit(tx, { actorId, action: 'privacy.profile_anonymised', targetType: 'profile', targetId: profileId, meta: { reason } });
}

/** Purge one application completely: files first, then fields. Idempotent. */
export async function purgeApplication(applicationId: string, reason: 'retention' | 'deletion_request'): Promise<{ files: number }> {
  const db = getDb();
  const files = await deleteApplicationFiles(db, applicationId);
  await withTx((tx) => scrubApplication(tx, applicationId, reason, files));
  return { files };
}

export interface RetentionResult {
  complete: boolean;
  alreadyDone: boolean;
  dryRun: RetentionPlan['totals'];
  done: { applications: number; files: number; versions: number; messages: number; students: number; errors: number };
}

/** Execute the plan (the same plan the admin dry-run shows), within a time budget. */
export async function runRetentionSweep(opts: { now?: Date; runKey?: string; budgetMs?: number } = {}): Promise<RetentionResult> {
  const db = getDb();
  const now = opts.now ?? new Date();
  const runKey = opts.runKey ?? now.toISOString().slice(0, 10);
  const run = await startOrResumeRun(db, 'retention-sweep', runKey, now);
  const plan = await planRetention({ now, db });
  const zero = { applications: 0, files: 0, versions: 0, messages: 0, students: 0, errors: 0 };
  if (run.status === 'done') return { complete: true, alreadyDone: true, dryRun: plan.totals, done: { ...zero, ...run.stats } };

  const outOfTime = deadline(opts.budgetMs ?? 40_000);
  let stats: Record<string, number> = { ...zero, ...run.stats };
  for (const a of plan.applications) {
    try {
      const { files } = await purgeApplication(a.applicationId, 'retention');
      stats = addStats(stats, { applications: 1, files, versions: a.versions, messages: a.messages });
    } catch (e) {
      console.error('[retention] purge failed', a.applicationId, e);
      stats = addStats(stats, { errors: 1 });
    }
    await saveProgress(db, run.id, a.applicationId, stats);
    if (outOfTime()) return { complete: false, alreadyDone: false, dryRun: plan.totals, done: stats as RetentionResult['done'] };
  }
  // Re-evaluate students now that applications are purged.
  const studentsNow = await studentsToAnonymise(db, plan.cutoff, new Set());
  for (const s of studentsNow) {
    await withTx((tx) => anonymiseStudent(tx, s.profileId, 'retention'));
    stats = addStats(stats, { students: 1 });
  }
  await withTx(async (tx) => {
    await writeAudit(tx, {
      actorId: null,
      action: 'job.retention_sweep',
      targetType: 'job',
      targetId: runKey,
      meta: { applications: stats.applications ?? 0, files: stats.files ?? 0, students: stats.students ?? 0, errors: stats.errors ?? 0 },
    });
    await finishRun(tx, run.id, stats);
  });
  return { complete: true, alreadyDone: false, dryRun: plan.totals, done: stats as RetentionResult['done'] };
}

/** Ids of applications for a student (deletion requests purge all of them). */
export async function applicationIdsFor(db: DbOrTx, profileId: string): Promise<{ id: string; status: string }[]> {
  return db.select({ id: applications.id, status: applications.status }).from(applications).where(eq(applications.studentId, profileId));
}
