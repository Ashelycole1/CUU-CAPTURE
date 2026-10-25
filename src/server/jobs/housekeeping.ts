import 'server-only';
/** Daily housekeeping run at the end of the daily-runway cron. All steps are idempotent. */
import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { pruneRateLimits } from '../auth/rate-limit';
import { pruneExpiredSessions } from '../auth/session';
import { getDb } from '../db/client';
import { applications, notifications, otpCodes } from '../db/schema';
import { flushNotifications, type NotificationChannel } from '../notify';
import { jobsEnv } from './env';

/** FR-REV-6: clear claims whose 15-minute window has passed (services already ignore them). */
export async function releaseStaleClaims(now: Date = new Date()): Promise<number> {
  const res = await getDb()
    .update(applications)
    .set({ claimedBy: null, claimedUntil: null })
    .where(and(isNotNull(applications.claimedUntil), lt(applications.claimedUntil, now.toISOString())))
    .returning({ id: applications.id });
  return res.length;
}

/** OTP rows hold email addresses: keep them only one day (minimisation). */
export async function pruneOtpCodes(now: Date = new Date()): Promise<void> {
  await getDb()
    .delete(otpCodes)
    .where(lt(otpCodes.expiresAt, new Date(now.getTime() - 86_400_000).toISOString()));
}

/** Emails sent in the last 24 h (for the provider's daily quota). */
export async function sentInLast24h(now: Date = new Date()): Promise<number> {
  const rows = await getDb()
    .select({ n: sql<number>`count(*)` })
    .from(notifications)
    .where(and(eq(notifications.status, 'sent'), gte(notifications.sentAt, new Date(now.getTime() - 86_400_000).toISOString())));
  return Number(rows[0]?.n ?? 0);
}

/**
 * Deliver queued and retry-due notifications without exceeding the daily email cap
 * (Resend free tier: 100/day). Whatever is left waits for the next run.
 */
export async function flushWithinCap(opts: { channel?: NotificationChannel; cap?: number; max?: number } = {}) {
  const cap = opts.cap ?? jobsEnv().emailDailyCap;
  const remaining = Math.max(0, cap - (await sentInLast24h()));
  const limit = Math.min(remaining, opts.max ?? 200);
  if (limit === 0) return { sent: 0, failed: 0, skipped: 0, capped: true };
  const res = await flushNotifications({ limit, channel: opts.channel });
  return { ...res, capped: res.sent + res.failed + res.skipped >= limit };
}

export async function runHousekeeping(now: Date = new Date()) {
  const db = getDb();
  const claimsReleased = await releaseStaleClaims(now);
  await pruneExpiredSessions(db, now);
  await pruneRateLimits(db, 86_400_000, now.getTime());
  await pruneOtpCodes(now);
  return { claimsReleased };
}
