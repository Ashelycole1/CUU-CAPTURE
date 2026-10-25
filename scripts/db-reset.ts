import fs from 'node:fs';
import path from 'node:path';
import { filePathFromUrl, openDb } from '../src/server/db/client';
import { runMigrations } from '../src/server/db/migrate';
import { seedBase, seedDev } from '../src/server/db/seed';
import { config } from '../src/server/config';

/** Dev only: delete the local SQLite file + blobs, re-migrate, re-seed. */
async function main() {
  const c = config();
  if (c.isProd || !c.databaseUrl.startsWith('file:')) throw new Error('db:reset only works on a local file: database outside production');
  const file = filePathFromUrl(c.databaseUrl);
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  fs.rmSync(path.resolve(c.dataDir, 'blobs'), { recursive: true, force: true });
  const h = await openDb(c.databaseUrl);
  await runMigrations(h.db);
  await seedBase(h.db, { allowedDomains: c.allowedEmailDomains });
  await seedDev(h.db);
  console.log('Database reset, migrated and seeded (dev users included).');
  h.client.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
