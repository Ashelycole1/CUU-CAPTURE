import 'server-only';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { emailSchema } from '@/domain/schemas';
import { en } from '@/i18n/en';
import { interpolate } from '@/i18n';
import type { Actor } from '../authz';
import { writeAudit } from '../audit';
import { config } from '../config';
import { getDb, type Db } from '../db/client';
import { otpCodes, profiles } from '../db/schema';
import { ForbiddenError, ValidationError } from '../errors';
import { sendEmailNow } from '../notify';
import { getAllowedEmailDomains } from '../services/settings';
import { RATE_LIMITS, enforceRateLimit } from './rate-limit';
import { createSession } from './session';

/**
 * Email OTP (FR-AUTH-1): 6 digits, stored as HMAC-SHA256, 10-minute expiry,
 * max 5 attempts, rate-limited per email and per IP.
 * Student self-sign-up only for allow-listed domains; staff must be invited (FR-AUTH-2).
 */
export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;

export function hashOtp(email: string, code: string): string {
  return createHmac('sha256', config().sessionSecret).update(`${email}:${code}`).digest('hex');
}

function domainOf(email: string): string {
  return email.split('@')[1] ?? '';
}

function parseEmail(raw: string): string {
  const r = emailSchema.safeParse(raw);
  if (!r.success) throw new ValidationError(en.auth.invalidEmail, { email: en.auth.invalidEmail });
  return r.data;
}

export async function requestOtp(input: { email: string; ip?: string | null }, db: Db = getDb()): Promise<{ sent: true }> {
  const email = parseEmail(input.email);
  await enforceRateLimit(db, `otp:email:${email}`, RATE_LIMITS.otpPerEmail.limit, RATE_LIMITS.otpPerEmail.windowMs);
  if (input.ip) await enforceRateLimit(db, `otp:ip:${input.ip}`, RATE_LIMITS.otpPerIp.limit, RATE_LIMITS.otpPerIp.windowMs);

  const existing = (await db.select().from(profiles).where(eq(profiles.email, email)))[0];
  const allowed = await getAllowedEmailDomains(db);
  if (!existing && !allowed.includes(domainOf(email))) {
    const msg = interpolate(en.auth.domainNotAllowed, { domain: allowed[0] ?? 'cavendish.ac.ug' });
    throw new ValidationError(msg, { email: msg });
  }
  if (existing && (existing.status !== 'active' || existing.deletedAt)) throw new ForbiddenError(en.auth.accountDisabled);

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const now = new Date();
  await db.transaction(async (tx) => {
    // Invalidate older unconsumed codes for this email.
    await tx
      .update(otpCodes)
      .set({ consumedAt: now.toISOString() })
      .where(and(eq(otpCodes.email, email), isNull(otpCodes.consumedAt)));
    await tx.insert(otpCodes).values({
      email,
      codeHash: hashOtp(email, code),
      expiresAt: new Date(now.getTime() + OTP_TTL_MS).toISOString(),
      ip: input.ip ?? null,
    });
  });
  const app = config().appName;
  await sendEmailNow({
    to: email,
    subject: interpolate(en.auth.otpEmailSubject, { app, code }),
    text: interpolate(en.auth.otpEmailBody, { code }),
    kind: 'otp',
  });
  return { sent: true };
}

export type VerifyFailure = 'invalid' | 'expired' | 'too_many_attempts';

export class OtpError extends ValidationError {
  constructor(readonly reason: VerifyFailure) {
    const msg = reason === 'expired' ? en.auth.codeExpired : reason === 'too_many_attempts' ? en.auth.tooManyAttempts : en.auth.codeInvalid;
    super(msg, { code: msg });
  }
}

export interface VerifyResult {
  token: string;
  expiresAt: string;
  actor: Actor;
  isNewUser: boolean;
}

export async function verifyOtp(
  input: { email: string; code: string; ip?: string | null; userAgent?: string | null },
  db: Db = getDb(),
  now: Date = new Date(),
): Promise<VerifyResult> {
  const email = parseEmail(input.email);
  const code = (input.code ?? '').replace(/\s+/g, '');
  if (input.ip) await enforceRateLimit(db, `verify:ip:${input.ip}`, RATE_LIMITS.verifyPerIp.limit, RATE_LIMITS.verifyPerIp.windowMs);
  if (!/^\d{6}$/.test(code)) throw new OtpError('invalid');

  const row = (
    await db
      .select()
      .from(otpCodes)
      .where(and(eq(otpCodes.email, email), isNull(otpCodes.consumedAt)))
      .orderBy(desc(otpCodes.createdAt))
      .limit(1)
  )[0];
  if (!row) throw new OtpError('invalid');
  if (new Date(row.expiresAt).getTime() <= now.getTime()) throw new OtpError('expired');
  if (row.attempts >= OTP_MAX_ATTEMPTS) throw new OtpError('too_many_attempts');

  const expected = Buffer.from(row.codeHash, 'hex');
  const actual = Buffer.from(hashOtp(email, code), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    const attempts = row.attempts + 1;
    await db
      .update(otpCodes)
      .set({ attempts, consumedAt: attempts >= OTP_MAX_ATTEMPTS ? now.toISOString() : null })
      .where(eq(otpCodes.id, row.id));
    throw new OtpError(attempts >= OTP_MAX_ATTEMPTS ? 'too_many_attempts' : 'invalid');
  }

  return db.transaction(async (tx) => {
    // Consume atomically (guards against double use in a race).
    const consumed = await tx
      .update(otpCodes)
      .set({ consumedAt: now.toISOString(), attempts: row.attempts + 1 })
      .where(and(eq(otpCodes.id, row.id), isNull(otpCodes.consumedAt)))
      .returning({ id: otpCodes.id });
    if (consumed.length === 0) throw new OtpError('invalid');

    let profile = (await tx.select().from(profiles).where(eq(profiles.email, email)))[0];
    let isNewUser = false;
    if (!profile) {
      const allowed = await getAllowedEmailDomains(tx);
      if (!allowed.includes(domainOf(email))) throw new ValidationError(en.auth.domainNotAllowed);
      const id = crypto.randomUUID();
      await tx.insert(profiles).values({ id, email, role: 'student' });
      profile = (await tx.select().from(profiles).where(eq(profiles.id, id)))[0]!;
      isNewUser = true;
      await writeAudit(tx, { actorId: id, action: 'auth.signup', targetType: 'profile', targetId: id, meta: { role: 'student' } }, now.toISOString());
    }
    if (profile.status !== 'active' || profile.deletedAt) throw new ForbiddenError(en.auth.accountDisabled);
    await tx.update(profiles).set({ lastLoginAt: now.toISOString() }).where(eq(profiles.id, profile.id));
    const session = await createSession(tx, profile, { ip: input.ip, userAgent: input.userAgent }, now);
    await writeAudit(
      tx,
      { actorId: profile.id, action: 'auth.login', targetType: 'profile', targetId: profile.id, meta: { role: profile.role } },
      now.toISOString(),
    );
    return {
      ...session,
      actor: { id: profile.id, role: profile.role, email: profile.email, fullName: profile.fullName },
      isNewUser,
    };
  });
}
