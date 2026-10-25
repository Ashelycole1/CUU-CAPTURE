/**
 * Nightly backup (see .github/workflows/backup.yml and docs/RUNBOOK.md).
 *   DATABASE_URL=libsql://… DATABASE_AUTH_TOKEN=… npx tsx scripts/backup.ts --out backup.sql
 * Writes a plain SQL dump. The workflow compresses and encrypts it (openssl) before upload.
 */
import fs from 'node:fs';
import { createClient } from '@libsql/client';
import { dumpDatabase } from './lib/dump';

async function main() {
  const outIdx = process.argv.indexOf('--out');
  const out = (outIdx > 0 ? process.argv[outIdx + 1] : undefined) ?? 'backup.sql';
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN || undefined, intMode: 'bigint' });
  const { sql, stats } = await dumpDatabase(client);
  fs.writeFileSync(out, sql);
  client.close();
  const rows = Object.values(stats.tables).reduce((s, n) => s + n, 0);
  console.log(JSON.stringify({ ok: true, out, bytes: Buffer.byteLength(sql), tables: Object.keys(stats.tables).length, rows }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
