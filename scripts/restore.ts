/**
 * Restore a dump made by scripts/backup.ts into an EMPTY database (docs/RUNBOOK.md):
 *   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in visadesk-<date>.sql.gz.enc -out backup.sql.gz -pass env:BACKUP_PASSPHRASE
 *   gunzip backup.sql.gz
 *   DATABASE_URL=file:./data/restore-drill.db npx tsx scripts/restore.ts --in backup.sql [--force]
 *   DATABASE_URL=file:./data/restore-drill.db npx tsx --conditions=react-server scripts/verify-audit.ts
 */
import fs from 'node:fs';
import { createClient } from '@libsql/client';
import { restoreDatabase } from './lib/dump';

async function main() {
  const inIdx = process.argv.indexOf('--in');
  const file = inIdx > 0 ? process.argv[inIdx + 1] : undefined;
  if (!file) throw new Error('Usage: restore.ts --in backup.sql [--force]');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN || undefined, intMode: 'bigint' });
  const stats = await restoreDatabase(client, fs.readFileSync(file, 'utf8'), { force: process.argv.includes('--force') });
  client.close();
  console.log(JSON.stringify({ ok: true, perTable: stats.tables }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
