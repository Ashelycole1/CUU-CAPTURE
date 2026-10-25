import 'server-only';
import { eq } from 'drizzle-orm';
import { config } from '../config';
import type { DbOrTx } from '../db/client';
import { settings } from '../db/schema';
import { writeAudit } from '../audit';
import { assertAdmin, type Actor } from '../authz';
import { getDb } from '../db/client';

export interface FeatureFlags {
  sso: boolean;
  ocr: boolean;
  sms: boolean;
  liaison: boolean;
}

export async function getSetting<T>(db: DbOrTx, key: string, fallback: T): Promise<T> {
  const row = (await db.select().from(settings).where(eq(settings.key, key)))[0];
  return row ? (row.value as T) : fallback;
}

/** Domains allowed to self-register as students: settings first, env fallback. */
export async function getAllowedEmailDomains(db: DbOrTx): Promise<string[]> {
  const v = await getSetting<string[] | null>(db, 'allowed_email_domains', null);
  return (v && v.length ? v : config().allowedEmailDomains).map((d) => d.toLowerCase());
}

export async function getRetentionDays(db: DbOrTx): Promise<number> {
  return getSetting<number>(db, 'retention_days', 90);
}

export async function getFeatureFlags(db: DbOrTx): Promise<FeatureFlags> {
  return getSetting<FeatureFlags>(db, 'feature_flags', { sso: false, ocr: false, sms: false, liaison: false });
}

/** Admin: upsert a setting (audited; value must not contain PII). */
export async function updateSetting(actor: Actor, key: string, value: unknown): Promise<void> {
  assertAdmin(actor);
  const db = getDb();
  await db.transaction(async (tx) => {
    const now = new Date().toISOString();
    await tx
      .insert(settings)
      .values({ key, value, updatedAt: now, updatedBy: actor.id })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now, updatedBy: actor.id } });
    await writeAudit(tx, { actorId: actor.id, action: 'settings.updated', targetType: 'setting', targetId: key });
  });
}
