import 'server-only';
import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema';
import { config } from '../config';

export type Db = LibSQLDatabase<typeof schema>;
/** A transaction handle. Services accept `DbOrTx` so they can compose inside one transaction. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export interface DbHandle {
  client: Client;
  db: Db;
  url: string;
}

// Module-level singleton, reused across warm serverless invocations.
// Stored on globalThis so Next dev HMR doesn't open a new client per reload.
const g = globalThis as unknown as { __visadeskDb?: DbHandle; __visadeskDbOverride?: DbHandle };

function isFileUrl(url: string): boolean {
  return url.startsWith('file:');
}

/** Local filesystem path of a `file:` URL (`file:./data/x.db` or `file:///C:/x.db`). */
export function filePathFromUrl(url: string): string {
  return url.startsWith('file://') ? fileURLToPath(url) : url.replace(/^file:/, '');
}

function ensureDirFor(url: string): void {
  const dir = path.dirname(filePathFromUrl(url));
  if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Open a libSQL client + drizzle instance for a URL (file: or libsql:/https:). */
export async function openDb(url: string, authToken?: string): Promise<DbHandle> {
  if (isFileUrl(url)) ensureDirFor(url);
  const client = createClient(isFileUrl(url) ? { url, timeout: 5000 } : { url, authToken });
  if (isFileUrl(url)) {
    // journal_mode is persistent per database file; synchronous/foreign_keys are per
    // connection. libSQL enables foreign_keys by default on every pooled connection
    // (asserted in tests) and `timeout` sets busy_timeout on each connection.
    await client.execute('PRAGMA journal_mode=WAL');
    await client.execute('PRAGMA synchronous=NORMAL');
  }
  await client.execute('PRAGMA foreign_keys=ON');
  return { client, db: drizzle(client, { schema }), url };
}

/**
 * The process-wide database. Lazily created from DATABASE_URL.
 * Synchronous accessor: the client connects lazily on first query.
 */
export function getDb(): Db {
  if (g.__visadeskDbOverride) return g.__visadeskDbOverride.db;
  if (!g.__visadeskDb) {
    const { databaseUrl, databaseAuthToken } = config();
    if (isFileUrl(databaseUrl)) ensureDirFor(databaseUrl);
    const client = createClient(
      isFileUrl(databaseUrl) ? { url: databaseUrl, timeout: 5000 } : { url: databaseUrl, authToken: databaseAuthToken },
    );
    g.__visadeskDb = { client, db: drizzle(client, { schema }), url: databaseUrl };
  }
  return g.__visadeskDb.db;
}

export function getClient(): Client {
  getDb();
  return (g.__visadeskDbOverride ?? g.__visadeskDb)!.client;
}

/** Test hook: route `getDb()` to a specific database (see tests/helpers/db.ts). */
export function setDbOverride(handle: DbHandle | null): void {
  g.__visadeskDbOverride = handle ?? undefined;
}

export { schema };
