/**
 * libSQL client instrumentation for performance tests and scripts.
 *
 * Wraps a `@libsql/client` Client IN PLACE (Drizzle holds the same object) and counts
 * what each operation would cost against Turso over HTTP (the transport
 * `@libsql/client` uses for `libsql://` URLs in Node):
 *   - `client.execute`          → 1 round trip
 *   - `client.batch`            → 1 round trip (all statements in one request)
 *   - `tx.execute` / `tx.batch` → 1 round trip each (BEGIN is pipelined with the first one)
 *   - `tx.commit` / `rollback`  → 1 round trip
 * Optionally injects an artificial network delay (`rttMs`) before every round trip so
 * wall-clock time with a remote database can be SIMULATED on a local file, including
 * the effect of parallel queries (Promise.all) and of a write transaction holding the
 * single write lock while it waits on the network.
 */
import type { Client, InStatement, Transaction, TransactionMode } from '@libsql/client';

export interface QueryCounter {
  /** SQL statements executed. */
  statements: number;
  /** Network round trips this would cost on Turso (HTTP). */
  roundTrips: number;
  /** Interactive transactions opened (`db.transaction` / `withTx`). */
  transactions: number;
  /** Of which write (BEGIN IMMEDIATE) transactions. */
  writeTransactions: number;
  /** Statement log (first 120 chars of SQL), in order. */
  log: string[];
}

export interface Instrumented {
  counter: QueryCounter;
  reset(): void;
  setRtt(ms: number): void;
  restore(): void;
}

/** Precise async delay (Windows timers have ~15 ms granularity): coarse timer, then yield-spin. */
export async function preciseDelay(ms: number): Promise<void> {
  if (ms <= 0) return;
  const end = performance.now() + ms;
  if (ms > 20) await new Promise((r) => setTimeout(r, ms - 17));
  while (performance.now() < end) await new Promise((r) => setImmediate(r));
}

function sqlOf(stmt: InStatement | string): string {
  const s = typeof stmt === 'string' ? stmt : stmt.sql;
  return s.replace(/\s+/g, ' ').slice(0, 120);
}

function fresh(): QueryCounter {
  return { statements: 0, roundTrips: 0, transactions: 0, writeTransactions: 0, log: [] };
}

export function instrumentClient(client: Client, opts: { rttMs?: number } = {}): Instrumented {
  const counter = fresh();
  let rtt = opts.rttMs ?? 0;
  const c = client as unknown as Record<string, unknown>;
  const orig = { execute: client.execute, batch: client.batch, transaction: client.transaction };
  const execute = client.execute.bind(client);
  const batch = client.batch.bind(client);
  const transaction = client.transaction.bind(client);

  c.execute = async (stmt: InStatement, args?: unknown) => {
    counter.statements++;
    counter.roundTrips++;
    counter.log.push(sqlOf(stmt));
    await preciseDelay(rtt);
    return (execute as (s: InStatement, a?: unknown) => ReturnType<Client['execute']>)(stmt, args);
  };
  c.batch = async (stmts: InStatement[], mode?: TransactionMode) => {
    counter.statements += stmts.length;
    counter.roundTrips++;
    counter.log.push(`BATCH[${stmts.length}] ${stmts.map(sqlOf).join(' ; ').slice(0, 200)}`);
    await preciseDelay(rtt);
    return batch(stmts, mode);
  };
  c.transaction = async (mode?: TransactionMode) => {
    counter.transactions++;
    if ((mode ?? 'write') === 'write') counter.writeTransactions++;
    counter.log.push(`BEGIN ${mode ?? 'write'}`);
    const tx: Transaction = await transaction(mode);
    const t = tx as unknown as Record<string, unknown>;
    const txExecute = tx.execute.bind(tx);
    const txBatch = tx.batch.bind(tx);
    const txCommit = tx.commit.bind(tx);
    const txRollback = tx.rollback.bind(tx);
    t.execute = async (stmt: InStatement) => {
      counter.statements++;
      counter.roundTrips++;
      counter.log.push(`  tx: ${sqlOf(stmt)}`);
      await preciseDelay(rtt);
      return txExecute(stmt);
    };
    t.batch = async (stmts: InStatement[]) => {
      counter.statements += stmts.length;
      counter.roundTrips++;
      await preciseDelay(rtt);
      return txBatch(stmts);
    };
    t.commit = async () => {
      counter.roundTrips++;
      counter.log.push('COMMIT');
      await preciseDelay(rtt);
      return txCommit();
    };
    t.rollback = async () => {
      counter.roundTrips++;
      counter.log.push('ROLLBACK');
      await preciseDelay(rtt);
      return txRollback();
    };
    return tx;
  };

  return {
    counter,
    reset() {
      Object.assign(counter, fresh());
    },
    setRtt(ms: number) {
      rtt = ms;
    },
    restore() {
      c.execute = orig.execute;
      c.batch = orig.batch;
      c.transaction = orig.transaction;
    },
  };
}

/** Run `fn` and return the round trips / statements it cost. */
export async function measure<T>(inst: Instrumented, fn: () => Promise<T>): Promise<{ result: T; counter: QueryCounter; ms: number }> {
  inst.reset();
  const t0 = performance.now();
  const result = await fn();
  const ms = performance.now() - t0;
  return { result, counter: { ...inst.counter, log: [...inst.counter.log] }, ms };
}
