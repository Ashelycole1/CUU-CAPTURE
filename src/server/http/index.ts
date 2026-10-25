import 'server-only';
import { NextResponse } from 'next/server';
import { config } from '../config';
import { ForbiddenError, toErrorBody, UnauthenticatedError } from '../errors';

/**
 * Route-handler helpers.
 *
 *   export const POST = route(async (req) => {
 *     assertSameOrigin(req);                      // CSRF (mutations)
 *     const actor = await requireActorOrThrow();  // from '@/server/auth/current'
 *     const result = await someService(actor, input);
 *     return NextResponse.json(result);
 *   });
 */
export function route<Ctx = unknown>(handler: (req: Request, ctx: Ctx) => Promise<Response>) {
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    try {
      return await handler(req, ctx);
    } catch (e) {
      const { status, body } = toErrorBody(e);
      if (status >= 500) console.error('[route error]', e);
      const res = NextResponse.json(body, { status });
      if (status === 429 && body.error.details?.retryAfterSeconds) {
        res.headers.set('Retry-After', String(body.error.details.retryAfterSeconds));
      }
      return res;
    }
  };
}

/**
 * CSRF protection for mutating route handlers: the Origin (or Referer) must match
 * the request host or APP_URL. Server Actions get Next's built-in origin check;
 * proxy.ts also applies this to all non-GET /api requests except /api/cron.
 */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin') ?? refererOrigin(req.headers.get('referer'));
  if (!origin) return false;
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  const allowed = new Set<string>([new URL(config().appUrl).origin]);
  if (host) {
    allowed.add(`https://${host}`);
    if (!config().isProd) allowed.add(`http://${host}`);
  }
  return allowed.has(origin);
}

function refererOrigin(ref: string | null): string | null {
  if (!ref) return null;
  try {
    return new URL(ref).origin;
  } catch {
    return null;
  }
}

export function assertSameOrigin(req: Request): void {
  if (!isSameOrigin(req)) throw new ForbiddenError('Cross-origin request blocked');
}

/** Cron routes: Vercel sends `Authorization: Bearer $CRON_SECRET`. */
export function assertCronAuth(req: Request): void {
  const secret = config().cronSecret;
  const auth = req.headers.get('authorization');
  if (!secret || auth !== `Bearer ${secret}`) throw new UnauthenticatedError('Invalid cron secret');
}
