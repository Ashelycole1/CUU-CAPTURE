import 'server-only';
/**
 * Internal helpers shared by services. NOT for use outside src/server/services.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { assertTransition, TransitionError, type ApplicationAction } from '@/domain/state';
import { todayInKampala } from '@/domain/dates';
import type { RuleSet } from '@/domain/types';
import { actorIdOf, type Actor } from '../authz';
import { writeAudit, type AuditMeta } from '../audit';
import { getDb, type DbOrTx, type Tx } from '../db/client';
import { applicationEvents, applications, refCounters, ruleDocuments, ruleSets } from '../db/schema';
import { InvalidStateError, NotFoundError } from '../errors';

export type ApplicationRow = typeof applications.$inferSelect;

/**
 * Run `fn` in ONE write transaction (libSQL BEGIN IMMEDIATE). Retries a few times on
 * SQLITE_BUSY or an audit-chain fork (UNIQUE prev_hash) from a concurrent writer.
 */
export async function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const db = getDb();
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await db.transaction(fn);
    } catch (e) {
      lastErr = e;
      const msg = String((e as Error)?.message ?? '') + String((e as { cause?: Error })?.cause?.message ?? '');
      const retryable = /SQLITE_BUSY|database is locked|audit_log\.prev_hash|audit_log_prev_hash_uq/i.test(msg);
      if (!retryable) throw e;
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1) + Math.random() * 25));
    }
  }
  throw lastErr;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function loadApplication(tx: DbOrTx, id: string): Promise<ApplicationRow | undefined> {
  return (await tx.select().from(applications).where(eq(applications.id, id)))[0];
}

export async function loadApplicationOrThrow(tx: DbOrTx, id: string): Promise<ApplicationRow> {
  const app = await loadApplication(tx, id);
  if (!app) throw new NotFoundError('Application');
  return app;
}

export async function recordEvent(
  tx: DbOrTx,
  actor: Actor,
  applicationId: string,
  type: string,
  data: Record<string, unknown> = {},
  opts: { visibleToStudent?: boolean; at?: string } = {},
): Promise<void> {
  await tx.insert(applicationEvents).values({
    applicationId,
    type,
    data,
    actorId: actorIdOf(actor),
    visibleToStudent: opts.visibleToStudent ?? true,
    at: opts.at ?? nowIso(),
  });
}

export async function audit(
  tx: DbOrTx,
  actor: Actor,
  action: string,
  target: { type: string; id: string },
  meta: AuditMeta = {},
): Promise<void> {
  await writeAudit(tx, { actorId: actorIdOf(actor), action, targetType: target.type, targetId: target.id, meta });
}

/**
 * Apply a state-machine transition with an optimistic guard on the current status,
 * writing the timeline event and audit row in the same transaction.
 */
export async function transition(
  tx: Tx,
  actor: Actor,
  app: ApplicationRow,
  action: ApplicationAction,
  extra: Partial<typeof applications.$inferInsert> = {},
  eventData: Record<string, unknown> = {},
): Promise<ApplicationRow> {
  let to;
  try {
    to = assertTransition(app.status, action);
  } catch (e) {
    if (e instanceof TransitionError) throw new InvalidStateError(e.message, { from: app.status, action });
    throw e;
  }
  const now = nowIso();
  const updated = await tx
    .update(applications)
    .set({ ...extra, status: to, updatedAt: now, lastActivityAt: now })
    .where(and(eq(applications.id, app.id), eq(applications.status, app.status)))
    .returning();
  if (updated.length === 0) throw new InvalidStateError('The application changed while you were working. Reload and try again.');
  await recordEvent(tx, actor, app.id, 'status_changed', { from: app.status, to, action, ...eventData }, { at: now });
  await audit(tx, actor, `application.${action}`, { type: 'application', id: app.id }, { from: app.status, to });
  return updated[0]!;
}

export async function touchApplication(tx: DbOrTx, id: string): Promise<void> {
  const now = nowIso();
  await tx.update(applications).set({ lastActivityAt: now, updatedAt: now }).where(eq(applications.id, id));
}

/** Atomically allocate the next `VD-YYYY-NNNNN` reference for the Kampala year. */
export async function allocateRef(tx: DbOrTx, now: Date = new Date()): Promise<string> {
  const year = Number(todayInKampala(now).slice(0, 4));
  const rows = await tx
    .insert(refCounters)
    .values({ year, last: 1 })
    .onConflictDoUpdate({ target: refCounters.year, set: { last: sql`${refCounters.last} + 1` } })
    .returning({ last: refCounters.last });
  return `VD-${year}-${String(rows[0]!.last).padStart(5, '0')}`;
}

// ---------------------------------------------------------------- rule sets

export async function loadRuleSet(tx: DbOrTx, id: string): Promise<RuleSet> {
  const rs = (await tx.select().from(ruleSets).where(eq(ruleSets.id, id)))[0];
  if (!rs) throw new NotFoundError('Rule set');
  const docs = await tx.select().from(ruleDocuments).where(eq(ruleDocuments.ruleSetId, id)).orderBy(asc(ruleDocuments.sort));
  return {
    id: rs.id,
    version: rs.version,
    feeUsd: rs.feeUsd,
    penaltyUsdPerDay: rs.penaltyUsdPerDay,
    applyBeforeDays: rs.applyBeforeDays,
    maxPassMonths: rs.maxPassMonths,
    exemptCountries: rs.exemptCountries,
    reminderDays: rs.reminderDays,
    noticeDate: rs.noticeDate,
    documents: docs.map((d) => ({
      code: d.code,
      name: d.name,
      helpText: d.helpText,
      whereToGet: d.whereToGet,
      examplePath: d.examplePath,
      appliesToTypes: d.appliesToTypes,
      minFiles: d.minFiles,
      source: d.source,
      sort: d.sort,
    })),
  };
}

/** The current published rule set (highest published version). */
export async function loadActiveRuleSet(tx: DbOrTx): Promise<RuleSet> {
  const rs = (
    await tx.select({ id: ruleSets.id }).from(ruleSets).where(eq(ruleSets.status, 'published')).orderBy(desc(ruleSets.version)).limit(1)
  )[0];
  if (!rs) throw new InvalidStateError('No published rule set. Run the seed.');
  return loadRuleSet(tx, rs.id);
}
