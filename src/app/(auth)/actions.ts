'use server';
import { redirect } from 'next/navigation';
import { requestOtp, verifyOtp } from '@/server/auth/otp';
import { clearSession, getClientIp, getUserAgent, homePathFor, setSessionCookie } from '@/server/auth/current';
import { isServiceError, RateLimitedError, ValidationError } from '@/server/errors';
import { en } from '@/i18n/en';
import { interpolate } from '@/i18n';

export interface AuthFormState {
  error?: string;
  /** For the resend button. */
  sentAt?: number;
}

function messageFor(e: unknown): string {
  if (e instanceof RateLimitedError) return interpolate(en.auth.rateLimited, { seconds: e.retryAfterSeconds });
  if (e instanceof ValidationError) return Object.values(e.fieldErrors)[0] ?? e.message;
  if (isServiceError(e)) return e.message;
  console.error('[auth]', e);
  return en.app.genericError;
}

/** Step 1: email → send code → /verify. */
export async function requestCodeAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  try {
    await requestOtp({ email, ip: await getClientIp() });
  } catch (e) {
    return { error: messageFor(e) };
  }
  redirect(`/verify?email=${encodeURIComponent(email)}`);
}

/** Resend from /verify (stays on the page). */
export async function resendCodeAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  try {
    await requestOtp({ email, ip: await getClientIp() });
    return { sentAt: Date.now() };
  } catch (e) {
    return { error: messageFor(e) };
  }
}

/** Step 2: verify code → session cookie → role home. */
export async function verifyCodeAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = String(formData.get('email') ?? '');
  const code = String(formData.get('code') ?? '');
  let home: string;
  try {
    const r = await verifyOtp({ email, code, ip: await getClientIp(), userAgent: await getUserAgent() });
    await setSessionCookie(r.token);
    home = homePathFor(r.actor);
  } catch (e) {
    return { error: messageFor(e) };
  }
  redirect(home);
}

export async function signOutAction(): Promise<void> {
  await clearSession();
  redirect('/login');
}
