import 'server-only';
/**
 * Admin services (FR-ADM-1..5). Same rules as every service: actor first, authorize
 * first, one transaction per call with event + audit rows. Admin-only unless noted.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, like, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ACTIVE_STATUSES, type RiskBand, type RuleSet } from '@/domain/types';
import { addDays, todayInKampala } from '@/domain/dates';
import { riskBand, RISK_RANK } from '@/domain/rules';
import { assertAdmin, type Actor } from '../authz';
import { verifyAuditChain, type AuditVerification } from '../audit';
import { getDb, type DbOrTx } from '../db/client';
import {
  applications,
  auditLog,
  profiles,
  reasonTemplates,
  ruleDocuments,
  ruleSets,
  students,
} from '../db/schema';
import { InvalidStateError, NotFoundError, ValidationError } from '../errors';
import { planRetention, type RetentionPlan } from '../jobs/retention';
import { recentRuns, type JobRun } from '../jobs/runner';
import { syncApplicationDocuments, zodToValidation } from './applications';
import { audit, loadRuleSet, nowIso, recordEvent, withTx } from './internal';
import { createRuleSetDraft, ruleSetInputSchema, type RuleSetInput } from './rules';
import { diffRuleSets, impactSummary, type RuleSetDiff, type RuleSetLike } from './rule-diff';
import { updateSetting, getRetentionDays } from './settings';
import { CacheKeys, invalidateReadCache } from './read-cache';

// ---------------------------------------------------------------- rule sets (FR-ADM-1)

export type RuleSetRow = typeof ruleSets.$inferSelect;
export interface RuleSetFull extends RuleSetLike {
  id: string;
  status: RuleSetRow['status'];
  publishedAt: string | null;
}

export async function loadRuleSetFull(db: DbOrTx, id: string): Promise<RuleSetFull> {
  const row = (await db.select().from(ruleSets).where(eq(ruleSets.id, id)))[0];
  if (!row) throw new NotFoundError('Rule set');
  const rs = await loadRuleSet(db, id);
  return { ...rs, feeNote: row.feeNote, submissionEmail: row.submissionEmail, status: row.status, publishedAt: row.publishedAt };
}

export interface RulesAdminData {
  versions: (RuleSetRow & { applicationCount: number })[];
  published: RuleSetFull | null;
  draft: RuleSetFull | null;
}

export async function getRulesAdminData(actor: Actor): Promise<RulesAdminData> {
  assertAdmin(actor);
  const db = getDb();
  const rows = await db.select().from(ruleSets).orderBy(desc(ruleSets.version));
  const counts = await db
    .select({ ruleSetId: applications.ruleSetId, n: sql<number>`count(*)` })
    .from(applications)
    .where(inArray(applications.status, [...ACTIVE_STATUSES]))
    .groupBy(applications.ruleSetId);
  const versions = rows.map((r) => ({ ...r, applicationCount: Number(counts.find((c) => c.ruleSetId === r.id)?.n ?? 0) }));
  const pub = rows.find((r) => r.status === 'published');
  const draft = rows.find((r) => r.status === 'draft');
  return {
    versions,
    published: pub ? await loadRuleSetFull(db, pub.id) : null,
    draft: draft ? await loadRuleSetFull(db, draft.id) : null,
  };
}

/** Convert a full rule set into editor input (to start a draft from the published one). */
export function toRuleSetInput(rs: RuleSetLike): RuleSetInput {
  return {
    feeUsd: rs.feeUsd,
    feeNote: rs.feeNote ?? null,
    penaltyUsdPerDay: rs.penaltyUsdPerDay,
    applyBeforeDays: rs.applyBeforeDays,
    maxPassMonths: rs.maxPassMonths,
    exemptCountries: [...rs.exemptCountries],
    reminderDays: [...rs.reminderDays],
    noticeDate: rs.noticeDate ?? null,
    submissionEmail: rs.submissionEmail ?? null,
    documents: rs.documents.map((d) => ({ ...d, appliesToTypes: d.appliesToTypes && d.appliesToTypes.length ? [...d.appliesToTypes] : null })),
  };
}

/**
 * Create (id = null) or replace the content of a DRAFT rule set. Only one draft
 * exists at a time: creating when a draft exists updates that draft instead.
 */
export async function saveRuleSetDraft(actor: Actor, id: string | null, input: RuleSetInput): Promise<RuleSet> {
  assertAdmin(actor);
  const parsed = ruleSetInputSchema.safeParse(input);
  if (!parsed.success) throw zodToValidation(parsed.error);
  const { documents, ...rs } = parsed.data;
  if (new Set(documents.map((d) => d.code)).size !== documents.length) {
    throw new ValidationError('Document codes must be unique.', { documents: 'Document codes must be unique' });
  }
  const existingDraft = id ?? (await getDb().select({ id: ruleSets.id }).from(ruleSets).where(eq(ruleSets.status, 'draft')).limit(1))[0]?.id ?? null;
  if (!existingDraft) return createRuleSetDraft(actor, input);
  await withTx(async (tx) => {
    const row = (await tx.select().from(ruleSets).where(eq(ruleSets.id, existingDraft)))[0];
    if (!row) throw new NotFoundError('Rule set');
    if (row.status !== 'draft') throw new InvalidStateError('Only draft rule sets can be edited. Start a new draft instead.');
    await tx
      .update(ruleSets)
      .set({ ...rs, feeNote: rs.feeNote ?? null, noticeDate: rs.noticeDate ?? null, submissionEmail: rs.submissionEmail ?? null })
      .where(eq(ruleSets.id, row.id));
    await tx.delete(ruleDocuments).where(eq(ruleDocuments.ruleSetId, row.id));
    await tx.insert(ruleDocuments).values(documents.map((d) => ({ ...d, examplePath: d.examplePath ?? null, ruleSetId: row.id })));
    await audit(tx, actor, 'rule_set.draft_updated', { type: 'rule_set', id: row.id }, { version: row.version, documents: documents.length });
  });
  return loadRuleSet(getDb(), existingDraft);
}

export async function deleteRuleSetDraft(actor: Actor, id: string): Promise<void> {
  assertAdmin(actor);
  await withTx(async (tx) => {
    const row = (await tx.select().from(ruleSets).where(eq(ruleSets.id, id)))[0];
    if (!row) throw new NotFoundError('Rule set');
    if (row.status !== 'draft') throw new InvalidStateError('Only drafts can be deleted.');
    const used = await tx.select({ id: applications.id }).from(applications).where(eq(applications.ruleSetId, id)).limit(1);
    if (used.length) throw new InvalidStateError('This draft is in use and cannot be deleted.');
    await tx.delete(ruleSets).where(eq(ruleSets.id, id));
    await audit(tx, actor, 'rule_set.draft_deleted', { type: 'rule_set', id }, { version: row.version });
  });
}

export interface PublishImpact {
  draft: RuleSetFull;
  base: RuleSetFull | null;
  diff: RuleSetDiff;
  summary: string[];
  inFlight: { version: number; count: number }[];
  drafts: number;
}

/** Diff a draft against the published version plus a plain-language impact summary. */
export async function getPublishImpact(actor: Actor, draftId: string): Promise<PublishImpact> {
  assertAdmin(actor);
  const db = getDb();
  const draft = await loadRuleSetFull(db, draftId);
  const pubRow = (await db.select({ id: ruleSets.id }).from(ruleSets).where(eq(ruleSets.status, 'published')).limit(1))[0];
  const base = pubRow ? await loadRuleSetFull(db, pubRow.id) : null;
  const rows = await db
    .select({ version: ruleSets.version, status: applications.status, n: sql<number>`count(*)` })
    .from(applications)
    .innerJoin(ruleSets, eq(ruleSets.id, applications.ruleSetId))
    .where(inArray(applications.status, [...ACTIVE_STATUSES]))
    .groupBy(ruleSets.version, applications.status);
  const inFlightMap = new Map<number, number>();
  let drafts = 0;
  for (const r of rows) {
    if (r.status === 'draft') drafts += Number(r.n);
    else inFlightMap.set(r.version, (inFlightMap.get(r.version) ?? 0) + Number(r.n));
  }
  const inFlight = [...inFlightMap].map(([version, count]) => ({ version, count }));
  const diff = diffRuleSets(base, draft);
  const summary = impactSummary(diff, { baseVersion: base?.version ?? null, nextVersion: draft.version, inFlight, drafts });
  return { draft, base, diff, summary, inFlight, drafts };
}

/** Count draft applications on a version older than the published one. */
export async function countMigratableDrafts(actor: Actor): Promise<{ count: number; toVersion: number | null }> {
  assertAdmin(actor);
  const db = getDb();
  const pub = (await db.select().from(ruleSets).where(eq(ruleSets.status, 'published')).limit(1))[0];
  if (!pub) return { count: 0, toVersion: null };
  const n = await db
    .select({ n: sql<number>`count(*)` })
    .from(applications)
    .where(and(eq(applications.status, 'draft'), ne(applications.ruleSetId, pub.id)));
  return { count: Number(n[0]?.n ?? 0), toVersion: pub.version };
}

/**
 * Optional "migrate in-flight applications" (FR-ADM-1): moves DRAFT applications on
 * older versions to the published version and recomputes their checklist (new items
 * `missing`, dropped items kept as "not required"). Submitted-or-later applications
 * always keep their version (their documents are under review).
 */
export async function migrateDraftApplications(actor: Actor): Promise<{ migrated: number; toVersion: number }> {
  assertAdmin(actor);
  const db = getDb();
  const pub = (await db.select().from(ruleSets).where(eq(ruleSets.status, 'published')).limit(1))[0];
  if (!pub) throw new InvalidStateError('No published rule set.');
  const drafts = await db
    .select({ id: applications.id })
    .from(applications)
    .where(and(eq(applications.status, 'draft'), ne(applications.ruleSetId, pub.id)));
  let migrated = 0;
  for (const d of drafts) {
    const done = await withTx(async (tx) => {
      const app = (await tx.select().from(applications).where(eq(applications.id, d.id)))[0];
      if (!app || app.status !== 'draft' || app.ruleSetId === pub.id) return false;
      const from = (await tx.select({ v: ruleSets.version }).from(ruleSets).where(eq(ruleSets.id, app.ruleSetId)))[0]?.v ?? null;
      const now = nowIso();
      const [updated] = await tx
        .update(applications)
        .set({ ruleSetId: pub.id, updatedAt: now })
        .where(and(eq(applications.id, app.id), eq(applications.status, 'draft')))
        .returning();
      if (!updated) return false;
      const student = (await tx.select().from(students).where(eq(students.profileId, app.studentId)))[0];
      await syncApplicationDocuments(tx, updated, student);
      await recordEvent(tx, actor, app.id, 'rule_set_migrated', { fromVersion: from, toVersion: pub.version });
      await audit(tx, actor, 'application.rule_set_migrated', { type: 'application', id: app.id }, { fromVersion: from, toVersion: pub.version });
      return true;
    });
    if (done) migrated++;
  }
  return { migrated, toVersion: pub.version };
}

// ---------------------------------------------------------------- reason templates (FR-ADM-2)

export const reasonTemplateSchema = z.object({
  code: z.string().regex(/^[a-z0-9_]{2,40}$/, 'Lowercase letters, digits and underscores (2–40)'),
  label: z.string().trim().min(2).max(120),
  body: z.string().max(1000).default(''),
  active: z.boolean().default(true),
  sort: z.number().int().min(0).max(1000).default(0),
});
export type ReasonTemplateInput = z.input<typeof reasonTemplateSchema>;

export async function saveReasonTemplate(actor: Actor, input: ReasonTemplateInput): Promise<typeof reasonTemplates.$inferSelect> {
  assertAdmin(actor);
  const parsed = reasonTemplateSchema.safeParse(input);
  if (!parsed.success) throw zodToValidation(parsed.error);
  const v = parsed.data;
  const saved = await withTx(async (tx) => {
    const existed = (await tx.select({ code: reasonTemplates.code }).from(reasonTemplates).where(eq(reasonTemplates.code, v.code))).length > 0;
    await tx
      .insert(reasonTemplates)
      .values(v)
      .onConflictDoUpdate({ target: reasonTemplates.code, set: { label: v.label, body: v.body, active: v.active, sort: v.sort } });
    await audit(tx, actor, existed ? 'reason_template.updated' : 'reason_template.created', { type: 'reason_template', id: v.code }, { active: v.active });
    return (await tx.select().from(reasonTemplates).where(eq(reasonTemplates.code, v.code)))[0]!;
  });
  invalidateReadCache(CacheKeys.reasonTemplates);
  return saved;
}

export async function listAllReasonTemplates(actor: Actor) {
  assertAdmin(actor);
  return getDb().select().from(reasonTemplates).orderBy(asc(reasonTemplates.sort), asc(reasonTemplates.code));
}

// ---------------------------------------------------------------- retention (FR-ADM-3)

export const RETENTION_MIN_DAYS = 7;
export const RETENTION_MAX_DAYS = 3650;

export async function setRetentionDays(actor: Actor, days: number): Promise<void> {
  assertAdmin(actor);
  if (!Number.isInteger(days) || days < RETENTION_MIN_DAYS || days > RETENTION_MAX_DAYS) {
    throw new ValidationError(`Enter a whole number of days between ${RETENTION_MIN_DAYS} and ${RETENTION_MAX_DAYS}.`, { days: 'Out of range' });
  }
  await updateSetting(actor, 'retention_days', days);
}

export interface RetentionReport {
  retentionDays: number;
  plan: RetentionPlan;
  runs: JobRun[];
}

/** The dry-run report: exactly what the next sweep will delete (shared code path). */
export async function getRetentionReport(actor: Actor, now: Date = new Date()): Promise<RetentionReport> {
  assertAdmin(actor);
  const db = getDb();
  const [retentionDays, plan, runs] = await Promise.all([getRetentionDays(db), planRetention({ now, db }), recentRuns(db, 14)]);
  return { retentionDays, plan, runs };
}

// ---------------------------------------------------------------- audit (FR-ADM-4)

export interface AuditFilters {
  action?: string;
  actor?: string;
  targetType?: string;
  targetId?: string;
  /** Inclusive Kampala dates YYYY-MM-DD. */
  from?: string;
  to?: string;
  beforeId?: number;
  limit?: number;
}

export interface AuditRowView {
  id: number;
  at: string;
  actorId: string | null;
  actorLabel: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  meta: string;
  hash: string;
  prevHash: string;
}

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

async function auditWhere(db: DbOrTx, f: AuditFilters): Promise<SQL | undefined> {
  const conds: SQL[] = [];
  if (f.action) conds.push(f.action.endsWith('.') || f.action.endsWith('*') ? like(auditLog.action, `${f.action.replace(/\*$/, '')}%`) : eq(auditLog.action, f.action));
  if (f.actor) {
    if (f.actor === 'system') conds.push(isNull(auditLog.actorId));
    else if (f.actor.includes('@')) {
      const p = (await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.email, f.actor.trim().toLowerCase())))[0];
      conds.push(eq(auditLog.actorId, p?.id ?? '__none__'));
    } else conds.push(eq(auditLog.actorId, f.actor.trim()));
  }
  if (f.targetType) conds.push(eq(auditLog.targetType, f.targetType));
  if (f.targetId) conds.push(eq(auditLog.targetId, f.targetId.trim()));
  // Kampala is UTC+3 all year: a Kampala day starts at 21:00 UTC the previous day.
  if (f.from && isoDate.test(f.from)) conds.push(gte(auditLog.at, `${addDays(f.from, -1)}T21:00:00.000Z`));
  if (f.to && isoDate.test(f.to)) conds.push(lt(auditLog.at, `${f.to}T21:00:00.000Z`));
  if (f.beforeId) conds.push(lt(auditLog.id, f.beforeId));
  return conds.length ? and(...conds) : undefined;
}

async function labelActors(db: DbOrTx, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, string>();
  if (!unique.length) return out;
  const rows = await db.select({ id: profiles.id, email: profiles.email, role: profiles.role, deletedAt: profiles.deletedAt }).from(profiles).where(inArray(profiles.id, unique));
  for (const r of rows) out.set(r.id, r.deletedAt ? `(deleted ${r.role})` : `${r.email} (${r.role})`);
  return out;
}

export async function listAuditLog(actor: Actor, filters: AuditFilters = {}): Promise<{ rows: AuditRowView[]; nextBeforeId: number | null }> {
  assertAdmin(actor);
  const db = getDb();
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const where = await auditWhere(db, filters);
  const rows = await db.select().from(auditLog).where(where).orderBy(desc(auditLog.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const labels = await labelActors(db, page.map((r) => r.actorId));
  return {
    rows: page.map((r) => ({ ...r, actorLabel: r.actorId ? (labels.get(r.actorId) ?? r.actorId) : 'system' })),
    nextBeforeId: rows.length > limit ? page[page.length - 1]!.id : null,
  };
}

export async function listAuditActions(actor: Actor): Promise<string[]> {
  assertAdmin(actor);
  const rows = await getDb().selectDistinct({ action: auditLog.action }).from(auditLog).orderBy(asc(auditLog.action));
  return rows.map((r) => r.action);
}

export async function getAuditChainStatus(actor: Actor): Promise<AuditVerification> {
  assertAdmin(actor);
  return verifyAuditChain(getDb());
}

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const AUDIT_EXPORT_MAX_ROWS = 50_000;

/** CSV export (FR-ADM-4). The export itself is audited. */
export async function exportAuditCsv(actor: Actor, filters: AuditFilters = {}): Promise<{ csv: string; rows: number }> {
  assertAdmin(actor);
  const db = getDb();
  const where = await auditWhere(db, { ...filters, beforeId: undefined });
  const rows = await db.select().from(auditLog).where(where).orderBy(asc(auditLog.id)).limit(AUDIT_EXPORT_MAX_ROWS);
  const labels = await labelActors(db, rows.map((r) => r.actorId));
  const header = ['id', 'at', 'actor_id', 'actor', 'action', 'target_type', 'target_id', 'meta', 'prev_hash', 'hash'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [r.id, r.at, r.actorId, r.actorId ? (labels.get(r.actorId) ?? '') : 'system', r.action, r.targetType, r.targetId, r.meta, r.prevHash, r.hash]
        .map(csvCell)
        .join(','),
    );
  }
  await withTx(async (tx) => {
    await audit(tx, actor, 'audit.exported', { type: 'audit_log', id: 'export' }, {
      rows: rows.length,
      action: filters.action ?? null,
      targetType: filters.targetType ?? null,
    });
  });
  return { csv: lines.join('\r\n') + '\r\n', rows: rows.length };
}

// ---------------------------------------------------------------- analytics (FR-ADM-5)

export interface Analytics {
  weeks: number;
  submissionsPerWeek: { weekStart: string; count: number }[];
  firstPass: { decided: number; approvedFirstPass: number; rate: number | null };
  reviewTime: { count: number; meanHours: number | null; medianHours: number | null };
  rejectionReasons: { code: string; label: string; count: number }[];
  riskBands: { band: RiskBand; count: number }[];
}

/** Monday of the week containing `date` (YYYY-MM-DD). */
export function weekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return addDays(date, -dow);
}

function kampalaDate(iso: string): string {
  return todayInKampala(new Date(iso));
}

export async function getAnalytics(actor: Actor, opts: { weeks?: number; today?: string } = {}): Promise<Analytics> {
  assertAdmin(actor);
  const db = getDb();
  const weeks = Math.min(Math.max(opts.weeks ?? 12, 1), 104);
  const today = opts.today ?? todayInKampala();
  const firstWeek = addDays(weekStart(today), -7 * (weeks - 1));
  const sinceIso = `${addDays(firstWeek, -1)}T21:00:00.000Z`;

  // Submissions per week.
  const subs = await db.select({ at: applications.submittedAt }).from(applications).where(and(isNotNull(applications.submittedAt), gte(applications.submittedAt, sinceIso)));
  const buckets = new Map<string, number>();
  for (let i = 0; i < weeks; i++) buckets.set(addDays(firstWeek, 7 * i), 0);
  for (const s of subs) {
    const w = weekStart(kampalaDate(s.at!));
    if (buckets.has(w)) buckets.set(w, buckets.get(w)! + 1);
  }

  // Decided = approved (approvedAt set) or sent back at least once, submitted in the window.
  const decidedRows = await db
    .select({ approvedAt: applications.approvedAt, submittedAt: applications.submittedAt, rounds: applications.correctionsRound })
    .from(applications)
    .where(and(isNotNull(applications.submittedAt), gte(applications.submittedAt, sinceIso), or(isNotNull(applications.approvedAt), sql`${applications.correctionsRound} > 0`)));
  const approvedFirstPass = decidedRows.filter((r) => r.approvedAt && r.rounds === 0).length;

  const durations = decidedRows
    .filter((r) => r.approvedAt && r.submittedAt)
    .map((r) => (Date.parse(r.approvedAt!) - Date.parse(r.submittedAt!)) / 3_600_000)
    .filter((h) => h >= 0)
    .sort((a, b) => a - b);
  const mean = durations.length ? durations.reduce((s, h) => s + h, 0) / durations.length : null;
  const median = durations.length
    ? durations.length % 2
      ? durations[(durations.length - 1) / 2]!
      : (durations[durations.length / 2 - 1]! + durations[durations.length / 2]!) / 2
    : null;

  // Rejection reasons from the audit log (meta holds codes only).
  const rej = await db
    .select({ code: sql<string>`json_extract(${auditLog.meta}, '$.reasonCode')`, n: sql<number>`count(*)` })
    .from(auditLog)
    .where(and(eq(auditLog.action, 'document.reviewed'), sql`json_extract(${auditLog.meta}, '$.decision') = 'reject'`, gte(auditLog.at, sinceIso)))
    .groupBy(sql`json_extract(${auditLog.meta}, '$.reasonCode')`);
  const tpls = await db.select().from(reasonTemplates);
  const rejectionReasons = rej
    .map((r) => ({ code: r.code ?? 'unknown', label: tpls.find((t) => t.code === r.code)?.label ?? r.code ?? 'Unknown', count: Number(r.n) }))
    .sort((a, b) => b.count - a.count);

  // Current risk band of active students (same source as the daily job).
  const studs = await db
    .select({ passExpiry: students.passExpiry, noPass: students.noPass, appExpiry: applications.currentExpiry, appNoPass: applications.noPass, appId: applications.id })
    .from(profiles)
    .innerJoin(students, eq(students.profileId, profiles.id))
    .leftJoin(applications, and(eq(applications.studentId, profiles.id), inArray(applications.status, [...ACTIVE_STATUSES])))
    .where(and(eq(profiles.role, 'student'), eq(profiles.status, 'active'), isNull(profiles.deletedAt)));
  const bandCounts = new Map<RiskBand, number>();
  for (const s of studs) {
    const expiry = s.appId ? (s.appNoPass ? null : s.appExpiry) : s.noPass ? null : s.passExpiry;
    if (!expiry && !(s.appId ? s.appNoPass : s.noPass)) continue; // unknown: profile not filled in yet
    const b = riskBand(expiry, today);
    bandCounts.set(b, (bandCounts.get(b) ?? 0) + 1);
  }
  const riskBands = (Object.keys(RISK_RANK) as RiskBand[])
    .sort((a, b) => RISK_RANK[a] - RISK_RANK[b])
    .map((band) => ({ band, count: bandCounts.get(band) ?? 0 }));

  return {
    weeks,
    submissionsPerWeek: [...buckets].map(([weekStart, count]) => ({ weekStart, count })),
    firstPass: { decided: decidedRows.length, approvedFirstPass, rate: decidedRows.length ? approvedFirstPass / decidedRows.length : null },
    reviewTime: { count: durations.length, meanHours: mean, medianHours: median },
    rejectionReasons,
    riskBands,
  };
}
