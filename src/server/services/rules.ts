import 'server-only';
/** Rule sets (FR-ADM-1): read, draft, publish. In-flight applications keep their version. */
import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { STUDENT_TYPES, type RuleSet } from '@/domain/types';
import { countryCodeSchema } from '@/domain/schemas';
import { assertAdmin, assertStaff, type Actor } from '../authz';
import { getDb } from '../db/client';
import { applications, reasonTemplates, ruleDocuments, ruleSets } from '../db/schema';
import { InvalidStateError, NotFoundError } from '../errors';
import { zodToValidation } from './applications';
import { audit, loadActiveRuleSet, loadRuleSet, nowIso, withTx } from './internal';
import { CacheKeys, cachedRead, invalidateReadCache, READ_CACHE_TTL_MS } from './read-cache';

/** Current published rule set (any signed-in user may read policy). */
export async function getActiveRuleSet(): Promise<RuleSet> {
  return loadActiveRuleSet(getDb());
}

export async function getRuleSet(id: string): Promise<RuleSet> {
  return loadRuleSet(getDb(), id);
}

export async function listRuleSets(actor: Actor): Promise<(typeof ruleSets.$inferSelect & { applicationCount: number })[]> {
  assertStaff(actor);
  const db = getDb();
  const rows = await db.select().from(ruleSets).orderBy(desc(ruleSets.version));
  const counts = await db
    .select({ ruleSetId: applications.ruleSetId, n: sql<number>`count(*)` })
    .from(applications)
    .where(inArray(applications.status, ['draft', 'submitted', 'under_review', 'corrections_needed', 'approved', 'sent_to_immigration']))
    .groupBy(applications.ruleSetId);
  return rows.map((r) => ({ ...r, applicationCount: Number(counts.find((c) => c.ruleSetId === r.id)?.n ?? 0) }));
}

export const ruleSetInputSchema = z.object({
  feeUsd: z.number().int().min(0),
  feeNote: z.string().max(500).nullable().optional(),
  penaltyUsdPerDay: z.number().int().min(0),
  applyBeforeDays: z.number().int().min(0).max(365),
  maxPassMonths: z.number().int().min(1).max(60),
  exemptCountries: z.array(countryCodeSchema),
  reminderDays: z.array(z.number().int().min(0).max(365)),
  noticeDate: z.string().nullable().optional(),
  submissionEmail: z.string().email().nullable().optional(),
  documents: z
    .array(
      z.object({
        code: z.string().regex(/^[a-z0-9_]{2,40}$/),
        name: z.string().min(2).max(160),
        helpText: z.string().max(1000).default(''),
        whereToGet: z.string().max(500).default(''),
        examplePath: z.string().max(300).nullable().optional(),
        appliesToTypes: z.array(z.enum(STUDENT_TYPES)).nullable(),
        minFiles: z.number().int().min(1).max(10),
        source: z.enum(['notice', 'student_addition']),
        sort: z.number().int(),
      }),
    )
    .min(1),
});
export type RuleSetInput = z.input<typeof ruleSetInputSchema>;

/** Admin: create a new DRAFT rule set version (next version number). */
export async function createRuleSetDraft(actor: Actor, input: RuleSetInput): Promise<RuleSet> {
  assertAdmin(actor);
  const parsed = ruleSetInputSchema.safeParse(input);
  if (!parsed.success) throw zodToValidation(parsed.error);
  const { documents, ...rs } = parsed.data;
  const codes = new Set(documents.map((d) => d.code));
  if (codes.size !== documents.length) throw zodToValidation({ issues: [{ path: ['documents'], message: 'Document codes must be unique' }] });
  const id = await withTx(async (tx) => {
    const maxV = (await tx.select({ v: ruleSets.version }).from(ruleSets).orderBy(desc(ruleSets.version)).limit(1))[0]?.v ?? 0;
    const id = crypto.randomUUID();
    await tx.insert(ruleSets).values({ id, ...rs, version: maxV + 1, status: 'draft', createdBy: actor.id });
    await tx.insert(ruleDocuments).values(documents.map((d) => ({ ...d, examplePath: d.examplePath ?? null, ruleSetId: id })));
    await audit(tx, actor, 'rule_set.draft_created', { type: 'rule_set', id }, { version: maxV + 1 });
    return id;
  });
  return getRuleSet(id);
}

/**
 * Admin: publish a draft. The previously published set becomes `retired`.
 * Existing applications keep their `rule_set_id`; only new drafts use the new set.
 */
export async function publishRuleSet(actor: Actor, ruleSetId: string): Promise<RuleSet> {
  assertAdmin(actor);
  await withTx(async (tx) => {
    const rs = (await tx.select().from(ruleSets).where(eq(ruleSets.id, ruleSetId)))[0];
    if (!rs) throw new NotFoundError('Rule set');
    if (rs.status !== 'draft') throw new InvalidStateError('Only draft rule sets can be published.');
    const now = nowIso();
    await tx.update(ruleSets).set({ status: 'retired' }).where(eq(ruleSets.status, 'published'));
    await tx.update(ruleSets).set({ status: 'published', publishedAt: now, publishedBy: actor.id }).where(eq(ruleSets.id, rs.id));
    await audit(tx, actor, 'rule_set.published', { type: 'rule_set', id: rs.id }, { version: rs.version });
  });
  // New drafts on THIS instance use the new version immediately; other warm instances
  // pick it up within READ_CACHE_TTL_MS (read-cache.ts).
  invalidateReadCache(CacheKeys.activeRuleSetId);
  return getRuleSet(ruleSetId);
}

export type ReasonTemplate = typeof reasonTemplates.$inferSelect;

/** Active reason templates for the reject picker (staff). */
export async function listReasonTemplates(actor: Actor, opts: { includeInactive?: boolean } = {}): Promise<ReasonTemplate[]> {
  assertStaff(actor);
  const rows = await loadReasonTemplatesCached();
  return opts.includeInactive ? [...rows] : rows.filter((r) => r.active);
}

/**
 * All reason templates (global, non-personal), cached per instance for
 * READ_CACHE_TTL_MS and invalidated by `saveReasonTemplate`. Callers authorize first.
 * The returned array and rows are frozen.
 */
export function loadReasonTemplatesCached(): Promise<readonly ReasonTemplate[]> {
  return cachedRead(CacheKeys.reasonTemplates, READ_CACHE_TTL_MS, () => getDb().select().from(reasonTemplates).orderBy(asc(reasonTemplates.sort)));
}
