import 'server-only';
import { lt, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { rateLimits } from '../db/schema';
import { RateLimitedError } from '../errors';

/**
 * DB-backed fixed-window rate limiter (works across serverless instances).
 * Usage: `await enforceRateLimit(db, `otp:email:${email}`, 5, 15 * 60_000)`.
 */
export interface RateLimitResult {
  allowed: boolean;
  count: number;
  remaining: number;
  retryAfterSeconds: number;
}

export async function hitRateLimit(
  db: DbOrTx,
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const rows = await db
    .insert(rateLimits)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({ target: [rateLimits.key, rateLimits.windowStart], set: { count: sql`${rateLimits.count} + 1` } })
    .returning({ count: rateLimits.count });
  const count = rows[0]?.count ?? 1;
  return {
    allowed: count <= limit,
    count,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: Math.ceil((windowStart + windowMs - now) / 1000),
  };
}

export async function enforceRateLimit(db: DbOrTx, key: string, limit: number, windowMs: number, now?: number): Promise<void> {
  const r = await hitRateLimit(db, key, limit, windowMs, now);
  if (!r.allowed) throw new RateLimitedError(r.retryAfterSeconds);
}

/** Housekeeping (call from a cron): drop windows older than `olderThanMs`. */
export async function pruneRateLimits(db: DbOrTx, olderThanMs = 86_400_000, now: number = Date.now()): Promise<void> {
  await db.delete(rateLimits).where(lt(rateLimits.windowStart, now - olderThanMs));
}

export const RATE_LIMITS = {
  otpPerEmail: { limit: 5, windowMs: 15 * 60_000 },
  otpPerIp: { limit: 20, windowMs: 15 * 60_000 },
  verifyPerIp: { limit: 30, windowMs: 15 * 60_000 },
  uploadPerUser: { limit: 60, windowMs: 10 * 60_000 },
} as const;
