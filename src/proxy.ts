import { NextResponse, type NextRequest } from 'next/server';

/**
 * Edge of the app (Next 16 "proxy", formerly middleware), Node.js runtime.
 * 1. Strict nonce-based CSP for every page (NFR-SEC). Pages are dynamic, so Next
 *    applies the nonce to its own scripts automatically.
 * 2. CSRF: non-GET /api requests must come from our own origin (except /api/cron,
 *    which authenticates with CRON_SECRET). Server Actions also get Next's own check.
 * Auth is NOT enforced here; route-group layouts and services do that.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function buildCsp(nonce: string, isDev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    // Inline style attributes (e.g. Runway widths) need 'unsafe-inline' for styles only.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (!host) return false;
  const candidates = [origin, req.headers.get('referer')].filter(Boolean) as string[];
  if (candidates.length === 0) return false;
  try {
    return new URL(candidates[0]!).host === host;
  } catch {
    return false;
  }
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith('/api/') && !SAFE_METHODS.has(req.method) && !pathname.startsWith('/api/cron/')) {
    if (!sameOrigin(req)) {
      return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'Cross-origin request blocked' } }, { status: 403 });
    }
  }
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = buildCsp(nonce, process.env.NODE_ENV === 'development');
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set('Content-Security-Policy', csp);
  return res;
}

export const config = {
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon.ico|icons/|robots.txt).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
