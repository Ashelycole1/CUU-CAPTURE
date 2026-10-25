/**
 * Create (or promote) the first DOS admin in a fresh production database.
 *   DATABASE_URL=libsql://… DATABASE_AUTH_TOKEN=… npx tsx --conditions=react-server scripts/bootstrap-admin.ts --email dos.admin@cavendish.ac.ug --name "Jane Doe"
 * Refuses to promote someone who has student applications. Audited as `staff.bootstrapped`.
 * After the first admin exists, invite everyone else from /staff.
 */
import { eq } from 'drizzle-orm';
import { openDb } from '../src/server/db/client';
import { config } from '../src/server/config';
import { applications, profiles } from '../src/server/db/schema';
import { writeAudit } from '../src/server/audit';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg('--email')?.trim().toLowerCase();
  const name = arg('--name')?.trim() || null;
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Usage: bootstrap-admin.ts --email someone@cavendish.ac.ug [--name "Full Name"]');
  const c = config();
  const h = await openDb(c.databaseUrl, c.databaseAuthToken);
  const id = await h.db.transaction(async (tx) => {
    const existing = (await tx.select().from(profiles).where(eq(profiles.email, email)))[0];
    if (existing) {
      const apps = await tx.select({ id: applications.id }).from(applications).where(eq(applications.studentId, existing.id)).limit(1);
      if (apps.length) throw new Error('This account has student applications and cannot become an admin.');
      await tx.update(profiles).set({ role: 'dos_admin', status: 'active', fullName: name ?? existing.fullName, updatedAt: new Date().toISOString() }).where(eq(profiles.id, existing.id));
      await writeAudit(tx, { actorId: null, action: 'staff.bootstrapped', targetType: 'profile', targetId: existing.id, meta: { role: 'dos_admin', previousRole: existing.role } });
      return existing.id;
    }
    const newId = crypto.randomUUID();
    await tx.insert(profiles).values({ id: newId, email, fullName: name, role: 'dos_admin' });
    await writeAudit(tx, { actorId: null, action: 'staff.bootstrapped', targetType: 'profile', targetId: newId, meta: { role: 'dos_admin', previousRole: null } });
    return newId;
  });
  h.client.close();
  console.log(JSON.stringify({ ok: true, profileId: id, email, role: 'dos_admin' }));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
