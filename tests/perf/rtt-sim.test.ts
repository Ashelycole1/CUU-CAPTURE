/**
 * Simulated production latency with a remote database (docs/PERFORMANCE.md §3).
 *
 * Runs each hot path against a local SQLite file while injecting an artificial network
 * delay before every database round trip (see instrument.ts). Parallel queries overlap
 * exactly as they would against Turso, so the result reflects the real critical path,
 * not a naive `round trips × RTT`:
 *   - local compute  = median wall time with no injected delay;
 *   - critical path  = (time at a 100 ms probe RTT − local) / 100, rounded: the number
 *                      of round trips that cannot overlap;
 *   - modelled time  = local + critical path × RTT, for RTT 2 / 15 / 40 / 80 ms.
 * (Measuring the depth with a large probe keeps the result stable on a busy machine.)
 *
 * Opt-in (slow): PERF_SIM=1 [PERF_OUT=file.md] npx vitest run tests/perf/rtt-sim.test.ts
 */
import fs from 'node:fs';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db';
import { instrumentClient, type Instrumented } from './instrument';
import { buildFixture, documentJpeg, packet, reviewDecision, SCENARIOS, sessionAuthMock, uploadRequest, authState, type Fixture } from './scenarios';

vi.mock('@/server/auth/current', () => sessionAuthMock());
const { POST: uploadPOST } = await import('@/app/api/uploads/route');

/** Modelled RTTs: same AWS region, nearby region, cross-continent, poor. */
const RTTS = [2, 15, 40, 80];
const PROBE_MS = 100;
const RUNS = 5;
const enabled = !!process.env.PERF_SIM;
// Model production (Turso over HTTP): independent reads overlap (services/internal.ts
// `parallelReads`). Locally they are sequential by default; see docs/PERFORMANCE.md §6.
if (enabled) process.env.DB_PARALLEL_READS = process.env.DB_PARALLEL_READS ?? '1';

let t: TestDb;
let fx: Fixture;
let inst: Instrumented;
const rows: { name: string; rt: number; depth: number; local: number }[] = [];

beforeAll(async () => {
  if (!enabled) return;
  t = await createTestDb();
  fx = await buildFixture(t.db);
  inst = instrumentClient(t.handle.client);
}, 180_000);
afterAll(async () => {
  if (!enabled) return;
  inst.restore();
  const lines = [
    `| Hot path | Round trips | On critical path | Local compute | ${RTTS.map((r) => `RTT ${r} ms`).join(' | ')} |`,
    `|---|---|---|---|${RTTS.map(() => '---').join('|')}|`,
  ];
  for (const r of rows) {
    lines.push(`| ${r.name} | ${r.rt} | ${r.depth} | ${Math.round(r.local)} ms | ${RTTS.map((x) => `${Math.round(r.local + r.depth * x)} ms`).join(' | ')} |`);
  }
  console.log(`\n${lines.join('\n')}`);
  if (process.env.PERF_OUT) fs.writeFileSync(process.env.PERF_OUT, `${lines.join('\n')}\n`);
  await t.cleanup();
});

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

async function sim(name: string, fn: (i: number) => Promise<unknown>, runs = RUNS) {
  await fn(-1); // warm (per-instance caches, JIT)
  let rt = 0;
  const timed = async (rtt: number, n: number) => {
    inst.setRtt(rtt);
    const samples: number[] = [];
    for (let i = 0; i < n; i++) {
      inst.reset();
      const t0 = performance.now();
      await fn(i);
      samples.push(performance.now() - t0);
      rt = inst.counter.roundTrips;
    }
    return median(samples);
  };
  const local = await timed(0, runs);
  const probe = await timed(PROBE_MS, Math.min(3, runs));
  inst.setRtt(0);
  const depth = Math.min(rt, Math.max(0, Math.round((probe - local) / PROBE_MS)));
  rows.push({ name, rt, depth, local });
}

describe.skipIf(!enabled)('simulated latency vs database RTT', () => {
  for (const [name, fn] of Object.entries(SCENARIOS)) {
    it(name, () => sim(name, () => fn(fx)), 120_000);
  }

  it('POST /api/uploads (~1 MB JPEG)', async () => {
    const imgs = await Promise.all([1, 2].map((s) => documentJpeg(2000, 1500, 20 + s)));
    let n = 0;
    await sim(
      `POST /api/uploads (${Math.round(imgs[0]!.byteLength / 1024)} KB JPEG)`,
      async () => {
        authState.token = fx.studentToken;
        const res = await uploadPOST(uploadRequest({ applicationId: fx.draftAppId, docCode: fx.uploadDocCode }, imgs[n++ % 2]!), undefined as never);
        if (res.status !== 201) throw new Error(`upload ${res.status}: ${await res.text()}`);
      },
      3,
    );
  }, 300_000);

  it('review decision (action only)', async () => {
    // Each sample approves a different, still-uploaded document.
    const docs = [...fx.reviewDocIds];
    await sim('review decision (action only)', async () => {
      const id = docs.shift();
      if (id) await reviewDecision(fx, id);
    }, 1);
  }, 120_000);

  it('packet generation', () => sim('packet generation', () => packet(fx), 2), 300_000);
});
