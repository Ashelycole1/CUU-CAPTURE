import fs from 'node:fs';
import { E2E_BASE_URL } from './env';

/**
 * Routes the suite visits. `next dev` compiles each on first request (10-40 s on a slow
 * disk), which would otherwise eat into per-step timeouts. Auth is enforced in layouts
 * and handlers, not the proxy, so an anonymous GET still compiles the route; the
 * response (redirect/401/404) is ignored.
 */
const WARM_ROUTES = [
  '/login',
  '/verify',
  '/profile',
  '/apply',
  '/documents/passport_data_page',
  '/review',
  '/status',
  '/messages',
  '/dashboard',
  '/applications/00000000-0000-0000-0000-000000000000',
  '/review-mode',
  '/packets',
  '/retention',
  '/api/files/00000000-0000-0000-0000-000000000000',
  '/api/packets/00000000-0000-0000-0000-000000000000/00000000-0000-0000-0000-000000000000',
];

async function warm(path: string): Promise<void> {
  try {
    const res = await fetch(`${E2E_BASE_URL}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(180_000) });
    await res.arrayBuffer();
  } catch {
    // Warm-up is best effort.
  }
}

/** Fail fast with a clear message if the e2e server/database is not the dedicated one; then warm routes. */
export default async function globalSetup(): Promise<void> {
  if (!fs.existsSync('./data-e2e/visadesk.db')) {
    throw new Error('data-e2e/visadesk.db is missing. Start the server with `npm run e2e:server` (it resets ./data-e2e).');
  }
  const res = await fetch(`${E2E_BASE_URL}/api/health`);
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  if (process.env.E2E_SKIP_WARMUP === '1') return;
  // A few at a time: Turbopack compiles in parallel, but too many at once starves a small CI runner.
  const queue = [...WARM_ROUTES];
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      for (let p = queue.shift(); p; p = queue.shift()) await warm(p);
    }),
  );
}
