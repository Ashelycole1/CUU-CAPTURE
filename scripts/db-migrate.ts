import { openDb } from '../src/server/db/client';
import { runMigrations } from '../src/server/db/migrate';
import { config } from '../src/server/config';

async function main() {
  const c = config();
  const h = await openDb(c.databaseUrl, c.databaseAuthToken);
  await runMigrations(h.db);
  console.log(`Migrations applied to ${c.databaseUrl.startsWith('file:') ? c.databaseUrl : '(remote libSQL)'}`);
  h.client.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
