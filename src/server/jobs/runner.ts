import 'server-only';
/**
 * Job bookkeeping (NFR-REL). Each logical run (job + run key, e.g. the Kampala date)
 * has one `job_runs` row holding a keyset cursor, so a run that Vercel cuts off at
 * `maxDuration` resumes where it stopped on the next invocation. Work inside a run is
 * idempotent anyway (UNIQUE flags, notification dedupe keys, `purged_at`), so the
 * cursor is an optimisation, never a correctness requirement.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { jobRuns } from '../db/schema';

export type JobName = 'daily-runway' | 'retention-sweep';
export type JobRun = typeof jobRuns.$inferSelect;

/** Get or create the run row; increments `attempts` on resume. */
export async function startOrResumeRun(db: DbOrTx, job: JobName, runKey: string, now: Date = new Date()): Promise<JobRun> {
  const ts = now.toISOString();
  await db
    .insert(jobRuns)
    .values({ job, runKey, status: 'running', stats: {}, startedAt: ts, updatedAt: ts })
    .onConflictDoUpdate({
      target: [jobRuns.job, jobRuns.runKey],
      set: { attempts: sql`${jobRuns.attempts} + 1`, updatedAt: ts },
      setWhere: sql`${jobRuns.status} != 'done'`,
    });
  return (await db.select().from(jobRuns).where(and(eq(jobRuns.job, job), eq(jobRuns.runKey, runKey))))[0]!;
}

export async function saveProgress(db: DbOrTx, runId: string, cursor: string | null, stats: Record<string, number>): Promise<void> {
  await db.update(jobRuns).set({ cursor, stats, updatedAt: new Date().toISOString() }).where(eq(jobRuns.id, runId));
}

export async function finishRun(db: DbOrTx, runId: string, stats: Record<string, number>): Promise<void> {
  const ts = new Date().toISOString();
  await db.update(jobRuns).set({ status: 'done', stats, finishedAt: ts, updatedAt: ts, lastError: null }).where(eq(jobRuns.id, runId));
}

export async function failRun(db: DbOrTx, runId: string, error: unknown): Promise<void> {
  await db
    .update(jobRuns)
    .set({ status: 'failed', lastError: String((error as Error)?.message ?? error).slice(0, 500), updatedAt: new Date().toISOString() })
    .where(eq(jobRuns.id, runId));
}

export async function recentRuns(db: DbOrTx, limit = 20): Promise<JobRun[]> {
  return db.select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(limit);
}

/** Wall-clock budget so a run stops cleanly before the function limit. */
export function deadline(budgetMs: number, start = Date.now()): () => boolean {
  return () => Date.now() - start >= budgetMs;
}

/** Merge numeric stats. */
export function addStats(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
}
