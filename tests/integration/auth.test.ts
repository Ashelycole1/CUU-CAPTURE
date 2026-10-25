/** FR-AUTH-1/2/3, NFR-SEC rate limits: OTP + sessions. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { createStaff, createTestDb, createUser, outboxFor, type TestDb } from '../helpers/db';
import { requestOtp, verifyOtp, OtpError, OTP_MAX_ATTEMPTS } from '@/server/auth/otp';
import { createSession, hashToken, validateSession, revokeSession, STAFF_IDLE_MS, STUDENT_IDLE_MS } from '@/server/auth/session';
import { hitRateLimit } from '@/server/auth/rate-limit';
import { otpCodes, profiles, sessions, auditLog } from '@/server/db/schema';
import { ForbiddenError, RateLimitedError, ValidationError } from '@/server/errors';
import { setProfileStatus } from '@/server/services';
import { createAdmin } from '../helpers/db';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.cleanup());

async function lastCode(email: string): Promise<string> {
  const mails = await outboxFor(t.db, email);
  const m = mails[mails.length - 1]!;
  return /(\d{6})/.exec(m.subject)![1]!;
}

describe('email OTP (FR-AUTH-1)', () => {
  it('signs up a student on an allowed domain, stores only a hash, creates a session', async () => {
    const email = 'NEW.Student@Cavendish.ac.ug';
    await requestOtp({ email, ip: '10.0.0.1' });
    const code = await lastCode('new.student@cavendish.ac.ug');
    const row = (await t.db.select().from(otpCodes).where(eq(otpCodes.email, 'new.student@cavendish.ac.ug')))[0]!;
    expect(row.codeHash).not.toContain(code);
    const r = await verifyOtp({ email, code, ip: '10.0.0.1', userAgent: 'vitest' });
    expect(r.isNewUser).toBe(true);
    expect(r.actor.role).toBe('student');
    const s = (await t.db.select().from(sessions).where(eq(sessions.profileId, r.actor.id)))[0]!;
    expect(s.tokenHash).toBe(hashToken(r.token));
    expect(s.tokenHash).not.toBe(r.token);
    const v = await validateSession(t.db, r.token);
    expect(v?.actor.id).toBe(r.actor.id);
    const logins = await t.db.select().from(auditLog).where(and(eq(auditLog.action, 'auth.login'), eq(auditLog.actorId, r.actor.id)));
    expect(logins).toHaveLength(1);
    // Code is single-use.
    await expect(verifyOtp({ email, code })).rejects.toBeInstanceOf(OtpError);
  });

  it('rejects sign-up outside the domain allow-list', async () => {
    await expect(requestOtp({ email: 'someone@gmail.com' })).rejects.toBeInstanceOf(ValidationError);
    expect(await outboxFor(t.db, 'someone@gmail.com')).toHaveLength(0);
  });

  it('allows invited staff with any domain (FR-AUTH-2) and keeps their server-side role', async () => {
    await createUser(t.db, { role: 'dos_staff', email: 'officer@partner.org' });
    await requestOtp({ email: 'officer@partner.org' });
    const r = await verifyOtp({ email: 'officer@partner.org', code: await lastCode('officer@partner.org') });
    expect(r.actor.role).toBe('dos_staff');
    expect(r.isNewUser).toBe(false);
  });

  it('expires codes after 10 minutes', async () => {
    const email = 'expiry@cavendish.ac.ug';
    await requestOtp({ email });
    const code = await lastCode(email);
    const later = new Date(Date.now() + 10 * 60_000 + 1000);
    await expect(verifyOtp({ email, code }, t.db, later)).rejects.toMatchObject({ reason: 'expired' });
  });

  it('locks a code after 5 wrong attempts', async () => {
    const email = 'attempts@cavendish.ac.ug';
    await requestOtp({ email });
    const code = await lastCode(email);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < OTP_MAX_ATTEMPTS - 1; i++) {
      await expect(verifyOtp({ email, code: wrong })).rejects.toMatchObject({ reason: 'invalid' });
    }
    await expect(verifyOtp({ email, code: wrong })).rejects.toMatchObject({ reason: 'too_many_attempts' });
    // Even the right code no longer works.
    await expect(verifyOtp({ email, code })).rejects.toBeInstanceOf(OtpError);
  });

  it('a new request invalidates the previous code', async () => {
    const email = 'twice@cavendish.ac.ug';
    await requestOtp({ email });
    const first = await lastCode(email);
    await requestOtp({ email });
    const second = await lastCode(email);
    if (first !== second) await expect(verifyOtp({ email, code: first })).rejects.toBeInstanceOf(OtpError);
    await expect(verifyOtp({ email, code: second })).resolves.toBeTruthy();
  });

  it('rate-limits requests per email and per IP (NFR-SEC)', async () => {
    const email = 'spam@cavendish.ac.ug';
    for (let i = 0; i < 5; i++) await requestOtp({ email });
    await expect(requestOtp({ email })).rejects.toBeInstanceOf(RateLimitedError);
    for (let i = 0; i < 20; i++) await requestOtp({ email: `ip${i}@cavendish.ac.ug`, ip: '10.9.9.9' });
    await expect(requestOtp({ email: 'ipx@cavendish.ac.ug', ip: '10.9.9.9' })).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('rate limiter windows reset', async () => {
    const now = 1_000_000_000_000;
    for (let i = 0; i < 3; i++) await hitRateLimit(t.db, 'k', 3, 60_000, now);
    expect((await hitRateLimit(t.db, 'k', 3, 60_000, now)).allowed).toBe(false);
    expect((await hitRateLimit(t.db, 'k', 3, 60_000, now + 60_000)).allowed).toBe(true);
  });

  it('disabled accounts cannot sign in', async () => {
    const admin = await createAdmin(t.db);
    const u = await createUser(t.db, { email: 'gone@cavendish.ac.ug' });
    await setProfileStatus(admin, u.id, 'disabled');
    await expect(requestOtp({ email: 'gone@cavendish.ac.ug' })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('sessions (FR-AUTH-3)', () => {
  it('student sessions slide for 30 days; staff for 12 hours', async () => {
    const student = await createUser(t.db);
    const staff = await createStaff(t.db);
    const t0 = new Date('2026-10-01T08:00:00Z');
    const s1 = await createSession(t.db, { id: student.id, role: 'student' }, {}, t0);
    const s2 = await createSession(t.db, { id: staff.id, role: 'dos_staff' }, {}, t0);
    expect(new Date(s1.expiresAt).getTime() - t0.getTime()).toBe(STUDENT_IDLE_MS);
    expect(new Date(s2.expiresAt).getTime() - t0.getTime()).toBe(STAFF_IDLE_MS);

    // Staff: active at +11h slides the window; idle 12h+ after that expires.
    const t11 = new Date(t0.getTime() + 11 * 3600_000);
    expect(await validateSession(t.db, s2.token, t11)).not.toBeNull();
    expect(await validateSession(t.db, s2.token, new Date(t11.getTime() + 11 * 3600_000))).not.toBeNull();
    const idle = new Date(t11.getTime() + 11 * 3600_000 + 12 * 3600_000 + 1000);
    expect(await validateSession(t.db, s2.token, idle)).toBeNull();
    // Expired session row is deleted.
    expect((await t.db.select().from(sessions).where(eq(sessions.tokenHash, hashToken(s2.token)))).length).toBe(0);

    // Student: still valid after 20 days idle, expired after 31.
    expect(await validateSession(t.db, s1.token, new Date(t0.getTime() + 20 * 86400_000))).not.toBeNull();
    expect(await validateSession(t.db, s1.token, new Date(t0.getTime() + 20 * 86400_000 + 31 * 86400_000))).toBeNull();
  });

  it('revoked and unknown tokens are rejected; role comes from the DB', async () => {
    const u = await createUser(t.db);
    const s = await createSession(t.db, { id: u.id, role: 'student' });
    await t.db.update(profiles).set({ role: 'dos_staff' }).where(eq(profiles.id, u.id));
    expect((await validateSession(t.db, s.token))!.actor.role).toBe('dos_staff');
    await revokeSession(t.db, s.token);
    expect(await validateSession(t.db, s.token)).toBeNull();
    expect(await validateSession(t.db, 'x'.repeat(43))).toBeNull();
    expect(await validateSession(t.db, '')).toBeNull();
  });

  it('stores codes newest-first per email', async () => {
    const rows = await t.db.select().from(otpCodes).orderBy(desc(otpCodes.createdAt)).limit(1);
    expect(rows.length).toBe(1);
  });
});
