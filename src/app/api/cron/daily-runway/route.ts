import { NextResponse } from 'next/server';
import { assertCronAuth, route } from '@/server/http';
import { flushNotifications } from '@/server/notify';

/**
 * Vercel Cron (vercel.json, 03:00 UTC = 06:00 Kampala). Auth: Authorization: Bearer $CRON_SECRET.
 * STUB (foundation): the jobs agent implements the body (must be idempotent).
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const GET = route(async (req) => {
  assertCronAuth(req);
  // TODO(jobs agent): implement daily-runway.
  const notifications = await flushNotifications();
  return NextResponse.json({ ok: true, job: 'daily-runway', implemented: false, notifications });
});
