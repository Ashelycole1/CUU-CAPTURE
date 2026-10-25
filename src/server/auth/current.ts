import 'server-only';
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE } from '@/config/app';
import type { Role } from '@/domain/types';
import { isStaff, type Actor } from '../authz';
import { config } from '../config';
import { getDb } from '../db/client';
import { ForbiddenError, UnauthenticatedError } from '../errors';
import { revokeSession, validateSession } from './session';

/**
 * Current-actor helpers for Server Components, Route Handlers and Server Actions.
 * The role always comes from the DB (via the session join), never from the client.
 */

/** The signed-in actor or null. Deduplicated per request. */
export const getActor = cache(async (): Promise<Actor | null> => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const v = await validateSession(getDb(), token);
  return v?.actor ?? null;
});

/** Pages/layouts: redirect to /login when signed out, or to the role home when the role is wrong. */
export async function requireActor(roles?: readonly Role[]): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (roles && !roles.includes(actor.role as Role)) redirect(homePathFor(actor));
  return actor;
}

/** Route handlers / server actions: throw typed errors instead of redirecting. */
export async function requireActorOrThrow(roles?: readonly Role[]): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new UnauthenticatedError();
  if (roles && !roles.includes(actor.role as Role)) throw new ForbiddenError();
  return actor;
}

export function homePathFor(actor: Pick<Actor, 'role'>): string {
  if (isStaff(actor as Actor)) return '/dashboard';
  if (actor.role === 'liaison') return '/dashboard';
  return '/apply';
}

const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60; // DB enforces the role-specific idle expiry.

export async function setSessionCookie(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config().isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE_S,
  });
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await revokeSession(getDb(), token);
  jar.delete(SESSION_COOKIE);
}

/** Best-effort client IP (Vercel sets x-forwarded-for). */
export async function getClientIp(): Promise<string | null> {
  const h = await headers();
  return h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip') || null;
}

export async function getUserAgent(): Promise<string | null> {
  return (await headers()).get('user-agent');
}
