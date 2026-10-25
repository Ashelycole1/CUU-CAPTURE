import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import type { Role } from '@/domain/types';
import type { Actor } from '../authz';
import type { DbOrTx } from '../db/client';
import { profiles, sessions } from '../db/schema';

/**
 * Sessions: random 32-byte token in an httpOnly cookie; only SHA-256(token) is stored.
 * Sliding idle expiry (FR-AUTH-3): 12 h for staff/admin/liaison, 30 days for students.
 */
export const STAFF_IDLE_MS = 12 * 60 * 60 * 1000;
export const STUDENT_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
/** Avoid a DB write on every request: refresh last_seen at most this often. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export function idleMsForRole(role: Role): number {
  return role === 'student' ? STUDENT_IDLE_MS : STAFF_IDLE_MS;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function createSession(
  db: DbOrTx,
  profile: { id: string; role: Role },
  meta: { ip?: string | null; userAgent?: string | null } = {},
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: string }> {
  const token = newSessionToken();
  const expiresAt = new Date(now.getTime() + idleMsForRole(profile.role)).toISOString();
  await db.insert(sessions).values({
    tokenHash: hashToken(token),
    profileId: profile.id,
    lastSeenAt: now.toISOString(),
    expiresAt,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent?.slice(0, 300) ?? null,
  });
  return { token, expiresAt };
}

export interface ValidatedSession {
  actor: Actor;
  sessionId: string;
  expiresAt: string;
}

/** Returns the actor for a raw token, or null (expired, revoked, disabled, unknown). */
export async function validateSession(db: DbOrTx, token: string | undefined | null, now: Date = new Date()): Promise<ValidatedSession | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const rows = await db
    .select({ s: sessions, p: profiles })
    .from(sessions)
    .innerJoin(profiles, eq(profiles.id, sessions.profileId))
    .where(eq(sessions.tokenHash, hashToken(token)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const { s, p } = row;
  if (new Date(s.expiresAt).getTime() <= now.getTime() || p.status !== 'active' || p.deletedAt) {
    await db.delete(sessions).where(eq(sessions.id, s.id));
    return null;
  }
  let expiresAt = s.expiresAt;
  if (now.getTime() - new Date(s.lastSeenAt).getTime() > TOUCH_INTERVAL_MS) {
    expiresAt = new Date(now.getTime() + idleMsForRole(p.role)).toISOString();
    await db.update(sessions).set({ lastSeenAt: now.toISOString(), expiresAt }).where(eq(sessions.id, s.id));
  }
  return { actor: { id: p.id, role: p.role, email: p.email, fullName: p.fullName }, sessionId: s.id, expiresAt };
}

export async function revokeSession(db: DbOrTx, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

export async function revokeAllSessionsFor(db: DbOrTx, profileId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.profileId, profileId));
}

export async function pruneExpiredSessions(db: DbOrTx, now: Date = new Date()): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, now.toISOString()));
}
