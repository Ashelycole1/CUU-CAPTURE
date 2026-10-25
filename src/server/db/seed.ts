import { eq } from 'drizzle-orm';
import type { Db } from './client';
import { profiles, reasonTemplates, ruleDocuments, ruleSets, settings, students } from './schema';
import { DEFAULT_SETTINGS, DEV_USERS, REASON_TEMPLATES, RULE_DOCUMENTS_V1, RULE_SET_V1 } from './seed-data';
import { writeAudit } from '../audit';

/**
 * Base seed (safe for production, idempotent): rule set v1, reason templates, settings.
 * `allowedDomains` overrides the seeded allow-list (from ALLOWED_EMAIL_DOMAINS).
 */
export async function seedBase(db: Db, opts: { allowedDomains?: string[] } = {}): Promise<{ ruleSetId: string }> {
  return db.transaction(async (tx) => {
    const now = new Date().toISOString();
    let rs = (await tx.select().from(ruleSets).where(eq(ruleSets.version, RULE_SET_V1.version)))[0];
    if (!rs) {
      const id = crypto.randomUUID();
      await tx.insert(ruleSets).values({ id, ...RULE_SET_V1, status: 'published', publishedAt: now });
      await tx.insert(ruleDocuments).values(RULE_DOCUMENTS_V1.map((d) => ({ ...d, ruleSetId: id })));
      await writeAudit(tx, {
        actorId: null,
        action: 'rule_set.seeded',
        targetType: 'rule_set',
        targetId: id,
        meta: { version: RULE_SET_V1.version },
      });
      rs = (await tx.select().from(ruleSets).where(eq(ruleSets.id, id)))[0]!;
    }
    await tx
      .insert(reasonTemplates)
      .values(REASON_TEMPLATES.map((r, i) => ({ ...r, sort: i + 1 })))
      .onConflictDoNothing();
    const seedSettings = { ...DEFAULT_SETTINGS };
    if (opts.allowedDomains?.length) seedSettings.allowed_email_domains = opts.allowedDomains;
    await tx
      .insert(settings)
      .values(Object.entries(seedSettings).map(([key, value]) => ({ key, value, updatedAt: now })))
      .onConflictDoNothing();
    return { ruleSetId: rs.id };
  });
}

/** Dev-only users (admin, staff, two students). Never run in production. */
export async function seedDev(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    for (const u of Object.values(DEV_USERS)) {
      await tx
        .insert(profiles)
        .values({ email: u.email, fullName: u.fullName, role: u.role })
        .onConflictDoNothing();
      const p = (await tx.select().from(profiles).where(eq(profiles.email, u.email)))[0]!;
      if ('student' in u) {
        await tx
          .insert(students)
          .values({ profileId: p.id, ...u.student })
          .onConflictDoNothing();
      }
    }
  });
}
