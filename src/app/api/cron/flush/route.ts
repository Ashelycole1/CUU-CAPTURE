import { NextResponse } from 'next/server';
import { assertCronAuth, route } from '@/server/http';
import { flushWithinCap, releaseStaleClaims } from '@/server/jobs';
import { logJob } from '@/server/jobs/continue';

/**
 * Light intra-day retry of queued/failed emails (with backoff) and stale-claim cleanup.
 * Vercel Hobby crons run once a day, so this is called by the optional GitHub Actions
 * workflow `.github/workflows/health.yml` (free) with the same CRON_SECRET.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const GET = route(async (req) => {
  assertCronAuth(req);
  const started = Date.now();
  const notifications = await flushWithinCap({ max: 100 });
  const claimsReleased = await releaseStaleClaims();
  const body = { ok: true, job: 'flush', notifications, claimsReleased, ms: Date.now() - started };
  logJob('flush', body);
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
});
