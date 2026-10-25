import { NextResponse, after } from 'next/server';
import { assertCronAuth, route } from '@/server/http';
import { jobsEnv, runRetentionSweep } from '@/server/jobs';
import { continueCron, hopOf, logJob, MAX_HOPS } from '@/server/jobs/continue';

/**
 * Retention sweep (FR-AUD-2). Vercel Cron, once a day (vercel.json). Auth: Bearer $CRON_SECRET.
 * Executes exactly the plan shown on /retention (dry run). Never touches audit_log.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const GET = route(async (req) => {
  assertCronAuth(req);
  const started = Date.now();
  const hop = hopOf(req);
  const result = await runRetentionSweep({ budgetMs: jobsEnv().cronBudgetMs });
  if (!result.complete && hop < MAX_HOPS) after(() => continueCron('/api/cron/retention-sweep', hop + 1));
  const body = { ok: true, job: 'retention-sweep', hop, ...result, ms: Date.now() - started };
  logJob('retention-sweep', body);
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
});
