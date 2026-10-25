import { openDb } from '../src/server/db/client';
import { seedBase, seedDev } from '../src/server/db/seed';
import { config } from '../src/server/config';

async function main() {
  const c = config();
  const h = await openDb(c.databaseUrl, c.databaseAuthToken);
  await seedBase(h.db, { allowedDomains: c.allowedEmailDomains });
  const dev = !c.isProd && process.env.SEED_DEV_USERS !== '0';
  if (dev) await seedDev(h.db);
  console.log(`Seeded base data${dev ? ' + dev users' : ''}.`);
  h.client.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
