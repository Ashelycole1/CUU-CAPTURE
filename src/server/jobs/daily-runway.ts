import 'server-only';
/**
 * Daily Runway job (FR-RUN-3, FR-RUN-5, architecture §7.3).
 *
 * For every active student who has NOT yet submitted an application (no active
 * application, or only a draft), compute days to pass expiry and the current
 * reminder stage:
 *   - stage D = the smallest configured reminder day (rule set `reminderDays`, e.g.
 *     60/30/14/7/0) with daysToExpiry <= D;
 *   - stage -1 = expired (daysToExpiry < 0): student email + one DOS digest per day.
 * Only the CURRENT stage is flagged (a student first seen with 10 days left gets the
 * 14-day reminder, not the 60- and 30-day ones too).
 *
 * Idempotency: `runway_flags` is UNIQUE (student, expiry, day) and the reminder uses
 * dedupe key `reminder:{studentId}:{expiry}:{day}`, so running twice sends nothing new.
 * Students who submit (or whose expiry changes) get their open flags resolved.
 *
 * Batching: students are read in keyset pages by profile id; flags are written only
 * for students that need a new one (one small transaction each). Progress is saved
 * per page in `job_runs`, and the run stops at the time budget and resumes later.
 */
import { and, asc, eq, gt, gte, inArray, isNull, ne, sql } from 'drizzle-orm';
import { ACTIVE_STATUSES } from '@/domain/types';
import { diffDays, todayInKampala } from '@/domain/dates';
import { applyBy as applyByDate, riskBand } from '@/domain/rules';
import { interpolate } from '@/i18n';
import { jobs as jobsCopy } from '@/i18n/jobs';
import { writeAudit } from '../audit';
import { getDb } from '../db/client';
import { applications, profiles, runwayFlags, students } from '../db/schema';
import { queueNotification } from '../notify';
import { notifyAdmins } from '../services/applications';
import { loadActiveRuleSet, withTx } from '../services/internal';
import { addStats, deadline, finishRun, saveProgress, startOrResumeRun } from './runner';

export const EXPIRED_STAGE = -1;

export interface DailyRunwayOptions {
  /** Kampala date to evaluate (default: today). */
  today?: string;
  /** Stop after this many ms and resume on the next call. */
  budgetMs?: number;
  /** Students per page. */
  chunkSize?: number;
}

export interface DailyRunwayResult {
  runKey: string;
  complete: boolean;
  alreadyDone: boolean;
  stats: Record<string, number>;
}

/** Current reminder stage for a number of days to expiry, or null if none applies yet. */
export function reminderStage(daysToExpiry: number, reminderDays: readonly number[]): number | null {
  if (daysToExpiry < 0) return EXPIRED_STAGE;
  const days = [...new Set(reminderDays.filter((d) => d >= 0))].sort((a, b) => a - b);
  for (const d of days) if (daysToExpiry <= d) return d;
  return null;
}

interface Candidate {
  studentId: string;
  expiry: string;
  stage: number;
  band: string;
  hasDraft: boolean;
}

export async function runDailyRunway(opts: DailyRunwayOptions = {}): Promise<DailyRunwayResult> {
  const db = getDb();
  const today = opts.today ?? todayInKampala();
  const chunkSize = opts.chunkSize ?? 200;
  const outOfTime = deadline(opts.budgetMs ?? 40_000);
  const ruleSet = await loadActiveRuleSet(db);

  const run = await startOrResumeRun(db, 'daily-runway', today);
  if (run.status === 'done') return { runKey: today, complete: true, alreadyDone: true, stats: run.stats };

  let cursor = run.cursor ?? '';
  let stats = { ...run.stats };

  for (;;) {
    const page = await db
      .select({
        studentId: profiles.id,
        passExpiry: students.passExpiry,
        noPass: students.noPass,
        appId: applications.id,
        appStatus: applications.status,
        appExpiry: applications.currentExpiry,
        appNoPass: applications.noPass,
      })
      .from(profiles)
      .leftJoin(students, eq(students.profileId, profiles.id))
      .leftJoin(applications, and(eq(applications.studentId, profiles.id), inArray(applications.status, [...ACTIVE_STATUSES])))
      .where(and(eq(profiles.role, 'student'), eq(profiles.status, 'active'), isNull(profiles.deletedAt), gt(profiles.id, cursor)))
      .orderBy(asc(profiles.id))
      .limit(chunkSize);
    if (page.length === 0) break;

    const candidates: Candidate[] = [];
    const applied: string[] = [];
    const currentExpiry = new Map<string, string | null>();
    for (const r of page) {
      if (r.appId && r.appStatus !== 'draft') {
        applied.push(r.studentId);
        continue;
      }
      const expiry = r.appId ? (r.appNoPass ? null : r.appExpiry) : r.noPass ? null : r.passExpiry;
      currentExpiry.set(r.studentId, expiry ?? null);
      if (!expiry) continue;
      const stage = reminderStage(diffDays(expiry, today), ruleSet.reminderDays);
      if (stage === null) continue;
      candidates.push({ studentId: r.studentId, expiry, stage, band: riskBand(expiry, today), hasDraft: r.appStatus === 'draft' });
    }

    let flagged = 0;
    let reminders = 0;
    let resolved = 0;
    let expired = 0;

    // Resolve open flags for students who have applied, or whose expiry changed.
    const now = new Date().toISOString();
    if (applied.length) {
      const res = await db
        .update(runwayFlags)
        .set({ resolvedAt: now })
        .where(and(inArray(runwayFlags.studentId, applied), isNull(runwayFlags.resolvedAt)))
        .returning({ id: runwayFlags.id });
      resolved += res.length;
    }
    const others = [...currentExpiry.keys()];
    if (others.length) {
      const open = await db
        .select({ id: runwayFlags.id, studentId: runwayFlags.studentId, expiry: runwayFlags.expiry })
        .from(runwayFlags)
        .where(and(inArray(runwayFlags.studentId, others), isNull(runwayFlags.resolvedAt)));
      const stale = open.filter((f) => f.expiry !== currentExpiry.get(f.studentId)).map((f) => f.id);
      if (stale.length) {
        await db.update(runwayFlags).set({ resolvedAt: now }).where(inArray(runwayFlags.id, stale));
        resolved += stale.length;
      }
    }

    // Which candidates already have their stage flagged? (one query per page)
    const existing = candidates.length
      ? await db
          .select({ studentId: runwayFlags.studentId, expiry: runwayFlags.expiry, day: runwayFlags.day })
          .from(runwayFlags)
          .where(inArray(runwayFlags.studentId, candidates.map((c) => c.studentId)))
      : [];
    const seen = new Set(existing.map((f) => `${f.studentId}|${f.expiry}|${f.day}`));

    for (const c of candidates) {
      if (seen.has(`${c.studentId}|${c.expiry}|${c.stage}`)) continue;
      const result = await withTx(async (tx) => {
        const inserted = await tx
          .insert(runwayFlags)
          .values({ studentId: c.studentId, expiry: c.expiry, day: c.stage, band: c.band, flaggedAt: new Date().toISOString() })
          .onConflictDoNothing()
          .returning({ id: runwayFlags.id });
        if (inserted.length === 0) return { flagged: false, queued: false };
        // Older stages for the same expiry are superseded by this one.
        await tx
          .update(runwayFlags)
          .set({ resolvedAt: new Date().toISOString() })
          .where(
            and(
              eq(runwayFlags.studentId, c.studentId),
              eq(runwayFlags.expiry, c.expiry),
              ne(runwayFlags.id, inserted[0]!.id),
              isNull(runwayFlags.resolvedAt),
            ),
          );
        const queued = await queueNotification(tx, {
          kind: 'reminder',
          recipientId: c.studentId,
          applicationId: null,
          dedupeKey: `reminder:${c.studentId}:${c.expiry}:${c.stage}`,
          payload: {
            day: c.stage,
            expiry: c.expiry,
            applyBy: applyByDate(c.expiry, ruleSet.applyBeforeDays),
            hasDraft: c.hasDraft,
            penaltyUsdPerDay: ruleSet.penaltyUsdPerDay,
          },
        });
        await writeAudit(tx, {
          actorId: null,
          action: 'runway.flagged',
          targetType: 'profile',
          targetId: c.studentId,
          meta: { day: c.stage, band: c.band, reminderQueued: queued },
        });
        return { flagged: true, queued };
      });
      if (result.flagged) flagged++;
      if (result.queued) reminders++;
      if (result.flagged && c.stage === EXPIRED_STAGE) expired++;
    }

    cursor = page[page.length - 1]!.studentId;
    stats = addStats(stats, { scanned: page.length, flagged, reminders, resolved, expired });
    await saveProgress(db, run.id, cursor, stats);
    if (page.length < chunkSize) break;
    if (outOfTime()) return { runKey: today, complete: false, alreadyDone: false, stats };
  }

  // One DOS digest per day for students newly flagged as expired (any page of this run).
  const expiredToday = await db
    .select({ n: sql<number>`count(*)` })
    .from(runwayFlags)
    .where(and(eq(runwayFlags.day, EXPIRED_STAGE), gte(runwayFlags.flaggedAt, run.startedAt)));
  const expiredCount = Number(expiredToday[0]?.n ?? 0);
  await withTx(async (tx) => {
    if (expiredCount > 0) {
      await notifyAdmins(tx, `expired_digest:${today}`, null, interpolate(jobsCopy.runway.expiredDigest, { count: expiredCount }));
    }
    await writeAudit(tx, {
      actorId: null,
      action: 'job.daily_runway',
      targetType: 'job',
      targetId: today,
      meta: { flagged: stats.flagged ?? 0, reminders: stats.reminders ?? 0, resolved: stats.resolved ?? 0, expired: expiredCount },
    });
    await finishRun(tx, run.id, { ...stats, expiredDigest: expiredCount });
  });
  return { runKey: today, complete: true, alreadyDone: false, stats: { ...stats, expiredDigest: expiredCount } };
}
