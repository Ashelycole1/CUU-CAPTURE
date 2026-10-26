#!/usr/bin/env node
/**
 * HTTP load test against a PRODUCTION build (`next build && next start -p 3100`) seeded
 * with scripts/perf/seed-perf.ts (docs/PERFORMANCE.md §3.3).
 *
 *   node scripts/perf/load.mjs [--duration 10] [--connections 10] [--json]
 *
 * Reads `${DATA_DIR:-./data-perf}/perf-fixture.json` for session tokens and ids. Every
 * request is authenticated (the cookie is the real session token), so each one pays
 * the session lookup and the page's full database work — on a LOCAL SQLite file, so
 * the numbers show server CPU cost per request, not Turso latency (see rtt-sim).
 * Read-only: no uploads or writes (except the audited staff file views).
 */
import fs from 'node:fs';
import path from 'node:path';
import autocannon from 'autocannon';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const duration = opt('duration', 10);
const connections = opt('connections', 10);
const asJson = args.includes('--json');

const dataDir = process.env.DATA_DIR ?? './data-perf';
const fx = JSON.parse(fs.readFileSync(path.resolve(dataDir, 'perf-fixture.json'), 'utf8'));
const base = process.env.BASE_URL ?? fx.baseUrl;
const cookie = (token) => `${fx.cookieName}=${token}`;

const studentCookie = cookie(fx.student.token);
const staffCookie = cookie(fx.staff[1] ?? fx.staff[0]);
const reviewApp = fx.reviewDocs[0]?.applicationId;
const staffVersion = fx.staffVersionIds[0];

/** name → { path, cookie } */
const SCENARIOS = [
  { name: 'GET /api/health (no auth, no DB)', path: '/api/health', cookie: null },
  { name: 'student /apply', path: '/apply', cookie: studentCookie },
  { name: 'student /status', path: '/status', cookie: studentCookie },
  { name: 'staff /dashboard', path: '/dashboard', cookie: staffCookie },
  { name: 'staff /applications/[id]', path: `/applications/${reviewApp}`, cookie: staffCookie },
  { name: 'staff thumb /api/files/[id]', path: `/api/files/${staffVersion}?variant=thumb`, cookie: staffCookie },
];

async function run(s) {
  // Warm-up (JIT, read cache, connection pool), then measure.
  await fetch(base + s.path, { headers: s.cookie ? { cookie: s.cookie } : {} }).then((r) => r.arrayBuffer());
  const r = await autocannon({
    url: base + s.path,
    connections,
    duration,
    headers: s.cookie ? { cookie: s.cookie } : {},
  });
  return {
    name: s.name,
    rps: Math.round(r.requests.average),
    p50: r.latency.p50,
    p90: r.latency.p90,
    p99: r.latency.p99,
    non2xx: r.non2xx,
    errors: r.errors + r.timeouts,
  };
}

const rows = [];
for (const s of SCENARIOS) rows.push(await run(s));
if (asJson) console.log(JSON.stringify({ base, duration, connections, rows }, null, 2));
else {
  console.log(`${base}: ${connections} connections × ${duration} s per scenario (local SQLite)`);
  console.log('| Scenario | req/s | p50 ms | p90 ms | p99 ms | non-2xx | errors |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.name} | ${r.rps} | ${r.p50} | ${r.p90} | ${r.p99} | ${r.non2xx} | ${r.errors} |`);
}
