/** Verify the audit hash chain of DATABASE_URL (restore drill / incident response). Exit 2 if broken. */
import { openDb } from '../src/server/db/client';
import { verifyAuditChain } from '../src/server/audit';
import { config } from '../src/server/config';

async function main() {
  const c = config();
  const h = await openDb(c.databaseUrl, c.databaseAuthToken);
  const res = await verifyAuditChain(h.db);
  h.client.close();
  console.log(JSON.stringify(res));
  if (!res.ok) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
