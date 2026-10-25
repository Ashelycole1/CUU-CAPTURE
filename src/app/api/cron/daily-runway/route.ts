import { NextResponse, after } from 'next/server';
import { assertCronAuth, route } from '@/server/http';
import { flushWithinCap, jobsEnv, runDailyRunway, runHousekeeping } from '@/server/jobs';
import { continueCron, hopOf, logJob, MAX_HOPS } from '@/server/jobs/continue';

/**
 * Daily Runway (FR-RUN-3/5). Vercel Cron, once a day (vercel.json). Auth: Bearer $CRON_SECRET.
 * Flags + reminders (idempotent), DOS expired digest, then housekeeping and email delivery.
 * If the run hits its time budget it saves a cursor and re-invokes itself (?hop=N).
 */
export const dynamic = 'force-dynamic';
// Hobby allows 60 s (300 s with Fluid compute). The job stops at CRON_BUDGET_MS (40 s default).
export const maxDuration = 60;

export const GET = route(async (req) => {
  assertCronAuth(req);
  const started = Date.now();
  const hop = hopOf(req);
  const env = jobsEnv();
  const runway = await runDailyRunway({ budgetMs: env.cronBudgetMs });
  let housekeeping: Awaited<ReturnType<typeof runHousekeeping>> | null = null;
  let notifications: Awaited<ReturnType<typeof flushWithinCap>> | null = null;
  if (runway.complete) {
    housekeeping = await runHousekeeping();
    notifications = await flushWithinCap();
  } else if (hop < MAX_HOPS) {
    after(() => continueCron('/api/cron/daily-runway', hop + 1));
  }
  const body = { ok: true, job: 'daily-runway', hop, runway, housekeeping, notifications, ms: Date.now() - started };
  logJob('daily-runway', body);
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
});
