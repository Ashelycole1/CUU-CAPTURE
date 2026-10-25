/**
 * Logical SQL dump / restore for libSQL (local file or Turso) using only
 * `@libsql/client` — no Turso CLI or sqlite3 binary needed (NFR-REL backups).
 *
 * Dump order: CREATE TABLE → INSERT rows → CREATE INDEX / TRIGGER / VIEW, so the
 * append-only audit triggers are created after the data is loaded.
 */
import type { Client } from '@libsql/client';

export const DUMP_HEADER = '-- VisaDesk libSQL dump';

interface SchemaObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

function isInternal(name: string): boolean {
  return name.startsWith('sqlite_') || name.startsWith('libsql_') || name.startsWith('_litestream') || name.startsWith('_cf_');
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
    const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return `X'${Buffer.from(bytes).toString('hex')}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

export interface DumpStats {
  tables: Record<string, number>;
}

/** Produce a self-contained SQL script that recreates the database. */
export async function dumpDatabase(client: Client, opts: { pageSize?: number } = {}): Promise<{ sql: string; stats: DumpStats }> {
  const pageSize = opts.pageSize ?? 500;
  const res = await client.execute(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, name",
  );
  const objs: SchemaObject[] = res.rows.map((r) => ({ type: String(r[0]), name: String(r[1]), tbl_name: String(r[2]), sql: r[3] === null ? null : String(r[3]) }));
  const tables = objs.filter((o) => o.type === 'table' && !isInternal(o.name));
  const rest = objs.filter((o) => o.type !== 'table' && !isInternal(o.name) && !isInternal(o.tbl_name));
  const out: string[] = [DUMP_HEADER, `-- created ${new Date().toISOString()}`, 'PRAGMA foreign_keys=OFF;', 'BEGIN;'];
  const stats: DumpStats = { tables: {} };
  for (const t of tables) out.push(`${t.sql};`);
  for (const t of tables) {
    let count = 0;
    for (let offset = 0; ; offset += pageSize) {
      const page = await client.execute({ sql: `SELECT * FROM ${quoteIdent(t.name)} ORDER BY rowid LIMIT ? OFFSET ?`, args: [pageSize, offset] });
      if (page.rows.length === 0) break;
      const cols = page.columns.map(quoteIdent).join(', ');
      for (const row of page.rows) {
        const values = page.columns.map((_, i) => sqlLiteral(row[i]));
        out.push(`INSERT INTO ${quoteIdent(t.name)} (${cols}) VALUES (${values.join(', ')});`);
        count++;
      }
      if (page.rows.length < pageSize) break;
    }
    stats.tables[t.name] = count;
  }
  for (const o of rest) out.push(`${o.sql};`);
  out.push('COMMIT;', 'PRAGMA foreign_keys=ON;', '');
  return { sql: out.join('\n'), stats };
}

export async function tableNames(client: Client): Promise<string[]> {
  const res = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
  return res.rows.map((r) => String(r[0])).filter((n) => !isInternal(n));
}

/** Load a dump into an EMPTY database (refuses otherwise unless `force`). */
export async function restoreDatabase(client: Client, sql: string, opts: { force?: boolean } = {}): Promise<DumpStats> {
  if (!sql.startsWith(DUMP_HEADER)) throw new Error('Not a VisaDesk dump (missing header).');
  const existing = await tableNames(client);
  if (existing.length && !opts.force) {
    throw new Error(`Target database is not empty (${existing.length} tables). Restore into a new database, or pass --force.`);
  }
  await client.executeMultiple(sql);
  const stats: DumpStats = { tables: {} };
  for (const name of await tableNames(client)) {
    const r = await client.execute(`SELECT count(*) FROM ${quoteIdent(name)}`);
    stats.tables[name] = Number(r.rows[0]![0]);
  }
  return stats;
}
