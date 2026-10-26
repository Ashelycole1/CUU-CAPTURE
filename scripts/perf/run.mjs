#!/usr/bin/env node
/**
 * Cross-platform runner for the performance checks (docs/PERFORMANCE.md §3).
 *
 *   node scripts/perf/run.mjs roundtrips   # round-trip budgets + per-path table (PERF_REPORT=1)
 *   node scripts/perf/run.mjs log          # same, plus every statement per path
 *   node scripts/perf/run.mjs sim [out.md] # simulated latency vs Turso RTT (slow, ~5 min)
 *   node scripts/perf/run.mjs js           # first-load JS budgets (after `next build`)
 *
 * The round-trip budgets also run in `npm test`; this only adds the reports.
 */
import { spawnSync } from 'node:child_process';

const [mode = 'roundtrips', out] = process.argv.slice(2);
const env = { ...process.env };
let cmd;
let args;
switch (mode) {
  case 'roundtrips':
  case 'log':
    env.PERF_REPORT = mode === 'log' ? 'log' : '1';
    [cmd, args] = ['npx', ['vitest', 'run', 'tests/perf/roundtrips.test.ts']];
    break;
  case 'sim':
    env.PERF_SIM = '1';
    if (out) env.PERF_OUT = out;
    [cmd, args] = ['npx', ['vitest', 'run', 'tests/perf/rtt-sim.test.ts']];
    break;
  case 'js':
    [cmd, args] = ['node', ['scripts/perf/js-budget.mjs', ...process.argv.slice(3)]];
    break;
  default:
    console.error(`Unknown mode "${mode}". Use roundtrips | log | sim | js.`);
    process.exit(2);
}
const r = spawnSync(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
process.exit(r.status ?? 1);
