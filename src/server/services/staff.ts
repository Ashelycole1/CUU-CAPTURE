import 'server-only';
/**
 * Staff services: approval, fees, immigration, outcome (FR-REV, FR-FEE, FR-PKT-3/4),
 * dashboard listing & summary (FR-DOS-1/2), saved views, staff management (FR-ADM-2).
 */
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, gte, or, sql, type SQL } from 'drizzle-orm';
import { addDays, todayInKampala } from '@/domain/dates';
import {
  passIssuedSchema,
  paymentSchema,
  sentToImmigrationSchema,
  staffListFiltersSchema,
  type PaymentInput,
  type StaffListFilters,
  type StaffSort,
} from '@/domain/schemas';
import { applyBy as applyByFn, riskBand, runwaySummary, type RunwaySummary } from '@/domain/rules';
import { diffDays } from '@/domain/dates';
import type { ApplicationStatus, FeeStatus, RiskBand, Role, SentMethod, StudentType } from '@/domain/types';
import { assertAdmin, assertStaff, type Actor } from '../authz';
import { getDb } from '../db/client';
import {
  applicationDocuments,
  applications,
  packets,
  payments,
  profiles,
  runwayFlags,
  ruleSets,
  savedViews,
  students,
} from '../db/schema';
import { ConflictError, InvalidStateError, NotFoundError, ValidationError } from '../errors';
import { queueNotification } from '../notify';
import { revokeAllSessionsFor } from '../auth/session';
import { zodToValidation, type Application } from './applications';
import { audit, loadApplicationOrThrow, nowIso, recordEvent, transition, withTx } from './internal';

// ---------------------------------------------------------------- lifecycle

/** Staff: one-click approve when every required document is approved. Queues `approved:{id}`. */
export async function markApproved(actor: Actor, applicationId: string): Promise<Application> {
  assertStaff(actor);
  return withTx(async (tx) => {
    const app = await loadApplicationOrThrow(tx, applicationId);
    const docs = await tx
      .select()
      .from(applicationDocuments)
      .where(and(eq(applicationDocuments.applicationId, app.id), eq(applicationDocuments.required, true)));
    const notApproved = docs.filter((d) => d.state !== 'approved');
    if (app.status === 'under_review' && (docs.length === 0 || notApproved.length)) {
      throw new InvalidStateError('Every required document must be approved first.', { notApproved: notApproved.map((d) => d.docCode) });
    }
    const now = nowIso();
    const updated = await transition(tx, actor, app, 'approve', { approvedAt: now, approvedBy: actor.id, claimedBy: null, claimedUntil: null });
    await queueNotification(tx, { kind: 'approved', recipientId: app.studentId, applicationId: app.id, dedupeKey: `approved:${app.id}` });
    return updated;
  });
}

/** Staff: record a fee payment (FR-FEE-2); sets fee_status = paid. */
export async function recordPayment(actor: Actor, applicationId: string, input: PaymentInput): Promise<typeof payments.$inferSelect> {
  assertStaff(actor);
  const parsed = paymentSchema.safeParse(input);
  if (!parsed.success) throw zodToValidation(parsed.error);
  return withTx(async (tx) => {
    const app = await loadApplicationOrThrow(tx, applicationId);
    if (app.status === 'draft' || app.status === 'withdrawn') throw new InvalidStateError('Payments can only be recorded for submitted applications.');
    const id = crypto.randomUUID();
    const [payment] = await tx
      .insert(payments)
      .values({ id, applicationId: app.id, ...parsed.data, reference: parsed.data.reference ?? null, receiptKey: parsed.data.receiptKey ?? null, recordedBy: actor.id })
      .returning();
    const now = nowIso();
    await tx.update(applications).set({ feeStatus: 'paid', lastActivityAt: now, updatedAt: now }).where(eq(applications.id, app.id));
    await recordEvent(tx, actor, app.id, 'fee_paid', { paidOn: parsed.data.paidOn });
    await audit(tx, actor, 'payment.recorded', { type: 'payment', id }, { applicationId: app.id, amountUgx: parsed.data.amountUgx });
    return payment!;
  });
}

/** Staff: set fee status explicitly (e.g. waive). */
export async function setFeeStatus(actor: Actor, applicationId: string, feeStatus: FeeStatus): Promise<Application> {
  assertStaff(actor);
  return withTx(async (tx) => {
    const app = await loadApplicationOrThrow(tx, applicationId);
    const [updated] = await tx.update(applications).set({ feeStatus, updatedAt: nowIso() }).where(eq(applications.id, app.id)).returning();
    await audit(tx, actor, 'application.fee_status_set', { type: 'application', id: app.id }, { from: app.feeStatus, to: feeStatus });
    return updated!;
  });
}

/** Staff: approved → sent_to_immigration (FR-PKT-3). Records date + method; queues `sent:{id}`. */
export async function markSentToImmigration(actor: Actor, applicationId: string, input: { method: SentMethod; sentOn?: string }): Promise<Application> {
  assertStaff(actor);
  const parsed = sentToImmigrationSchema.safeParse(input);
  if (!parsed.success) throw zodToValidation(parsed.error);
  return withTx(async (tx) => {
    const app = await loadApplicationOrThrow(tx, applicationId);
    const sentAt = parsed.data.sentOn ? `${parsed.data.sentOn}T09:00:00.000Z` : nowIso();
    const updated = await transition(tx, actor, app, 'send_to_immigration', { sentAt, sentMethod: parsed.data.method }, { method: parsed.data.method });
    const latest = (
      await tx.select().from(packets).where(and(eq(packets.applicationId, app.id), eq(packets.status, 'ready'))).orderBy(desc(packets.createdAt)).limit(1)
    )[0];
    if (latest) await tx.update(packets).set({ sentAt, sentMethod: parsed.data.method, sentBy: actor.id }).where(eq(packets.id, latest.id));
    await queueNotification(tx, { kind: 'sent_to_immigration', recipientId: app.studentId, applicationId: app.id, dedupeKey: `sent:${app.id}` });
    return updated;
  });
}

/** Staff: record the outcome (FR-PKT-4). Seeds the student's next Runway. Queues `pass_issued:{id}`. */
export async function recordPassIssued(actor: Actor, applicationId: string, input: { newExpiry: string }): Promise<Application> {
  assertStaff(actor);
  const parsed = passIssuedSchema.safeParse(input);
  if (!parsed.success) throw zodToValidation(parsed.error);
  return withTx(async (tx) => {
    const app = await loadApplicationOrThrow(tx, applicationId);
    const now = nowIso();
    const updated = await transition(tx, actor, app, 'record_pass_issued', { passIssuedAt: now, newExpiry: parsed.data.newExpiry }, { newExpiry: parsed.data.newExpiry });
    await tx.update(students).set({ passExpiry: parsed.data.newExpiry, noPass: false, updatedAt: now }).where(eq(students.profileId, app.studentId));
    await tx.update(runwayFlags).set({ resolvedAt: now }).where(and(eq(runwayFlags.studentId, app.studentId), isNull(runwayFlags.resolvedAt)));
    await queueNotification(tx, {
      kind: 'pass_issued',
      recipientId: app.studentId,
      applicationId: app.id,
      dedupeKey: `pass_issued:${app.id}`,
      payload: { newExpiry: parsed.data.newExpiry },
    });
    return updated;
  });
}

/** Staff: close a finished application (pass_issued or sent_to_immigration). */
export async function closeApplication(actor: Actor, applicationId: string): Promise<Application> {
  assertStaff(actor);
  return withTx(async (tx) => {
    const app = await loadApplicationOrThrow(tx, applicationId);
    return transition(tx, actor, app, 'close', { closedAt: nowIso(), claimedBy: null, claimedUntil: null });
  });
}

// ---------------------------------------------------------------- listing (FR-DOS-1)

export interface StaffListItem {
  id: string;
  ref: string | null;
  status: ApplicationStatus;
  studentId: string;
  studentName: string | null;
  studentEmail: string;
  studentNo: string | null;
  studentType: StudentType | null;
  nationality: string | null;
  currentExpiry: string | null;
  noPass: boolean;
  riskBand: RiskBand;
  daysToExpiry: number | null;
  applyBy: string | null;
  feeStatus: FeeStatus;
  docsRequired: number;
  docsApproved: number;
  docsPending: number;
  docsRejected: number;
  submittedAt: string | null;
  lastActivityAt: string;
  claimedBy: string | null;
  claimedUntil: string | null;
  emailBounced: boolean;
  /** Ready for <RunwayCompact summary={item.runway} /> (uses the application's rule set). */
  runway: RunwaySummary;
}

export interface StaffListOptions {
  filters?: StaffListFilters;
  sort?: StaffSort;
  cursor?: string | null;
  limit?: number;
  /** Kampala date used for risk bands (default: today). */
  today?: string;
}

export interface StaffListResult {
  items: StaffListItem[];
  nextCursor: string | null;
  total: number;
}

function riskBounds(today: string) {
  return { d7: addDays(today, 7), d30: addDays(today, 30), d60: addDays(today, 60) };
}

/** SQL expression: risk rank (lower = more urgent), mirrors RISK_RANK in domain/rules. */
function riskRankExpr(today: string): SQL<number> {
  const { d7, d30, d60 } = riskBounds(today);
  const exp = sql`(case when ${applications.noPass} = 1 then null else ${applications.currentExpiry} end)`;
  return sql<number>`(case
    when ${exp} is null then 3
    when ${exp} < ${today} then 0
    when ${exp} <= ${d7} then 1
    when ${exp} <= ${d30} then 2
    when ${exp} <= ${d60} then 4
    else 5 end)`;
}

function riskBandCondition(band: RiskBand, today: string): SQL {
  const { d7, d30, d60 } = riskBounds(today);
  const hasExp = and(eq(applications.noPass, false), isNotNull(applications.currentExpiry))!;
  switch (band) {
    case 'no_pass':
      return or(eq(applications.noPass, true), isNull(applications.currentExpiry))!;
    case 'expired':
      return and(hasExp, lt(applications.currentExpiry, today))!;
    case 'critical':
      return and(hasExp, gte(applications.currentExpiry, today), lte(applications.currentExpiry, d7))!;
    case 'urgent':
      return and(hasExp, gt(applications.currentExpiry, d7), lte(applications.currentExpiry, d30))!;
    case 'plan':
      return and(hasExp, gt(applications.currentExpiry, d30), lte(applications.currentExpiry, d60))!;
    case 'safe':
      return and(hasExp, gt(applications.currentExpiry, d60))!;
  }
}

function encodeCursor(values: (string | number)[]): string {
  return Buffer.from(JSON.stringify(values)).toString('base64url');
}
function decodeCursor(cursor: string): (string | number)[] {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v)) return v as (string | number)[];
  } catch {
    /* fallthrough */
  }
  throw new ValidationError('Invalid cursor');
}

/**
 * Staff: paginated application table (FR-DOS-1, NFR-PERF). Default sort: risk band
 * then expiry date. Drafts excluded unless `includeDrafts` or a status filter asks.
 * Keyset pagination: pass back `nextCursor` with the same filters/sort.
 */
export async function listApplicationsForStaff(actor: Actor, opts: StaffListOptions = {}): Promise<StaffListResult> {
  assertStaff(actor);
  const parsed = staffListFiltersSchema.safeParse(opts.filters ?? {});
  if (!parsed.success) throw zodToValidation(parsed.error);
  const f = parsed.data;
  const today = opts.today ?? todayInKampala();
  const sort: StaffSort = opts.sort ?? 'risk';
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const db = getDb();

  const conds: SQL[] = [];
  if (f.status?.length) conds.push(inArray(applications.status, f.status));
  else if (!f.includeDrafts) conds.push(sql`${applications.status} <> 'draft'`);
  if (f.studentType?.length) conds.push(inArray(students.studentType, f.studentType));
  if (f.nationality?.length) conds.push(inArray(students.nationality, f.nationality));
  if (f.feeStatus?.length) conds.push(inArray(applications.feeStatus, f.feeStatus));
  if (f.riskBand?.length) conds.push(or(...f.riskBand.map((b) => riskBandCondition(b, today)))!);
  if (f.submittedFrom) conds.push(gte(applications.submittedAt, `${f.submittedFrom}T00:00:00.000Z`));
  if (f.submittedTo) conds.push(lt(applications.submittedAt, `${addDays(f.submittedTo, 1)}T00:00:00.000Z`));
  if (f.claimedByMe) conds.push(and(eq(applications.claimedBy, actor.id), gt(applications.claimedUntil, nowIso()))!);
  if (f.q) {
    const like = `%${f.q.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conds.push(
      sql`(lower(coalesce(${profiles.fullName}, '')) like ${like} escape '\\' or lower(${profiles.email}) like ${like} escape '\\' or lower(coalesce(${students.studentNo}, '')) like ${like} escape '\\' or lower(coalesce(${applications.ref}, '')) like ${like} escape '\\')`,
    );
  }

  const rank = riskRankExpr(today);
  const expiryKey = sql<string>`coalesce(case when ${applications.noPass} = 1 then null else ${applications.currentExpiry} end, '9999-12-31')`;
  const submittedKey = sql<string>`coalesce(${applications.submittedAt}, '')`;
  const nameKey = sql<string>`lower(coalesce(${profiles.fullName}, ''))`;
  const sortSpec: { keys: SQL[]; dir: 'asc' | 'desc' } = (() => {
    switch (sort) {
      case 'expiry':
        return { keys: [expiryKey], dir: 'asc' as const };
      case 'submitted':
        return { keys: [submittedKey], dir: 'desc' as const };
      case 'activity':
        return { keys: [sql`${applications.lastActivityAt}`], dir: 'desc' as const };
      case 'name':
        return { keys: [nameKey], dir: 'asc' as const };
      case 'risk':
      default:
        return { keys: [rank, expiryKey], dir: 'asc' as const };
    }
  })();
  const keyCols = [...sortSpec.keys, sql`${applications.id}`];
  const whereBase = conds.length ? and(...conds) : undefined;
  const pageConds = [...conds];
  if (opts.cursor) {
    const vals = decodeCursor(opts.cursor);
    if (vals.length !== keyCols.length) throw new ValidationError('Invalid cursor');
    const lhs = sql.join(keyCols, sql`, `);
    const rhs = sql.join(vals.map((v) => sql`${v}`), sql`, `);
    pageConds.push(sortSpec.dir === 'asc' ? sql`(${lhs}) > (${rhs})` : sql`(${lhs}) < (${rhs})`);
  }

  const docAgg = db
    .select({
      applicationId: applicationDocuments.applicationId,
      required: sql<number>`sum(case when ${applicationDocuments.required} = 1 then 1 else 0 end)`.as('required'),
      approved: sql<number>`sum(case when ${applicationDocuments.required} = 1 and ${applicationDocuments.state} = 'approved' then 1 else 0 end)`.as('approved'),
      pending: sql<number>`sum(case when ${applicationDocuments.required} = 1 and ${applicationDocuments.state} = 'uploaded' then 1 else 0 end)`.as('pending'),
      rejected: sql<number>`sum(case when ${applicationDocuments.required} = 1 and ${applicationDocuments.state} = 'rejected' then 1 else 0 end)`.as('rejected'),
    })
    .from(applicationDocuments)
    .groupBy(applicationDocuments.applicationId)
    .as('doc_agg');

  const orderBy = keyCols.map((k) => (sortSpec.dir === 'asc' ? asc(k) : desc(k)));
  const rows = await db
    .select({
      a: applications,
      fullName: profiles.fullName,
      email: profiles.email,
      emailStatus: profiles.emailStatus,
      studentNo: students.studentNo,
      studentType: students.studentType,
      nationality: students.nationality,
      required: docAgg.required,
      approved: docAgg.approved,
      pending: docAgg.pending,
      rejected: docAgg.rejected,
      applyBeforeDays: ruleSets.applyBeforeDays,
      penaltyUsdPerDay: ruleSets.penaltyUsdPerDay,
      k0: keyCols[0]!,
      k1: keyCols[1] ?? sql`null`,
      k2: keyCols[2] ?? sql`null`,
    })
    .from(applications)
    .innerJoin(profiles, eq(profiles.id, applications.studentId))
    .leftJoin(students, eq(students.profileId, applications.studentId))
    .innerJoin(ruleSets, eq(ruleSets.id, applications.ruleSetId))
    .leftJoin(docAgg, eq(docAgg.applicationId, applications.id))
    .where(pageConds.length ? and(...pageConds) : undefined)
    .orderBy(...orderBy)
    .limit(limit + 1);

  const totalRow = await db
    .select({ n: sql<number>`count(*)` })
    .from(applications)
    .innerJoin(profiles, eq(profiles.id, applications.studentId))
    .leftJoin(students, eq(students.profileId, applications.studentId))
    .where(whereBase);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last ? encodeCursor([last.k0, last.k1, last.k2].slice(0, keyCols.length) as (string | number)[]) : null;

  return {
    items: page.map((r) => {
      const expiry = r.a.noPass ? null : r.a.currentExpiry;
      return {
        id: r.a.id,
        ref: r.a.ref,
        status: r.a.status,
        studentId: r.a.studentId,
        studentName: r.fullName,
        studentEmail: r.email,
        studentNo: r.studentNo,
        studentType: r.studentType,
        nationality: r.nationality,
        currentExpiry: r.a.currentExpiry,
        noPass: r.a.noPass,
        riskBand: riskBand(expiry, today),
        daysToExpiry: expiry ? diffDays(expiry, today) : null,
        applyBy: expiry ? applyByFn(expiry, r.applyBeforeDays) : null,
        feeStatus: r.a.feeStatus,
        docsRequired: Number(r.required ?? 0),
        docsApproved: Number(r.approved ?? 0),
        docsPending: Number(r.pending ?? 0),
        docsRejected: Number(r.rejected ?? 0),
        submittedAt: r.a.submittedAt,
        lastActivityAt: r.a.lastActivityAt,
        claimedBy: r.a.claimedBy,
        claimedUntil: r.a.claimedUntil,
        emailBounced: r.emailStatus === 'bounced',
        runway: runwaySummary(expiry, today, { applyBeforeDays: r.applyBeforeDays, penaltyUsdPerDay: r.penaltyUsdPerDay }),
      };
    }),
    nextCursor,
    total: Number(totalRow[0]?.n ?? 0),
  };
}

export interface DashboardSummary {
  needsReview: number;
  correctionsPending: number;
  criticalOrExpired: number;
  readyForImmigration: number;
  feesUnpaid: number;
  /** Students flagged by the daily runway job without an active application (FR-RUN-3). */
  openRunwayFlags: number;
}

/** Staff: the five summary tiles (FR-DOS-2) + open runway flags. */
export async function getDashboardSummary(actor: Actor, today: string = todayInKampala()): Promise<DashboardSummary> {
  assertStaff(actor);
  const db = getDb();
  const d7 = addDays(today, 7);
  const count = (expr: SQL) => sql<number>`sum(case when ${expr} then 1 else 0 end)`;
  const row = (
    await db
      .select({
        needsReview: count(sql`${applications.status} in ('submitted','under_review')`),
        correctionsPending: count(sql`${applications.status} = 'corrections_needed'`),
        criticalOrExpired: count(
          sql`${applications.status} in ('draft','submitted','under_review','corrections_needed','approved') and ${applications.noPass} = 0 and ${applications.currentExpiry} is not null and ${applications.currentExpiry} <= ${d7}`,
        ),
        readyForImmigration: count(sql`${applications.status} = 'approved'`),
        feesUnpaid: count(sql`${applications.feeStatus} = 'unpaid' and ${applications.status} not in ('draft','withdrawn','closed')`),
      })
      .from(applications)
  )[0];
  const flags = await db.select({ n: sql<number>`count(*)` }).from(runwayFlags).where(isNull(runwayFlags.resolvedAt));
  return {
    needsReview: Number(row?.needsReview ?? 0),
    correctionsPending: Number(row?.correctionsPending ?? 0),
    criticalOrExpired: Number(row?.criticalOrExpired ?? 0),
    readyForImmigration: Number(row?.readyForImmigration ?? 0),
    feesUnpaid: Number(row?.feesUnpaid ?? 0),
    openRunwayFlags: Number(flags[0]?.n ?? 0),
  };
}

// ---------------------------------------------------------------- saved views (FR-DOS-1)

export type SavedView = typeof savedViews.$inferSelect;

export async function listSavedViews(actor: Actor): Promise<SavedView[]> {
  assertStaff(actor);
  return getDb()
    .select()
    .from(savedViews)
    .where(or(eq(savedViews.ownerId, actor.id), eq(savedViews.shared, true)))
    .orderBy(asc(savedViews.name));
}

export async function createSavedView(
  actor: Actor,
  input: { name: string; filters: StaffListFilters & { sort?: StaffSort }; shared?: boolean },
): Promise<SavedView> {
  assertStaff(actor);
  const name = input.name?.trim();
  if (!name || name.length > 80) throw new ValidationError('Give the view a name (up to 80 characters).', { name: 'Required' });
  const { sort, ...filters } = input.filters ?? {};
  const parsed = staffListFiltersSchema.safeParse(filters);
  if (!parsed.success) throw zodToValidation(parsed.error);
  return withTx(async (tx) => {
    const [view] = await tx
      .insert(savedViews)
      .values({ ownerId: actor.id, name, filters: { ...parsed.data, ...(sort ? { sort } : {}) }, shared: !!input.shared })
      .returning();
    await audit(tx, actor, 'saved_view.created', { type: 'saved_view', id: view!.id });
    return view!;
  });
}

export async function deleteSavedView(actor: Actor, id: string): Promise<void> {
  assertStaff(actor);
  await withTx(async (tx) => {
    const view = (await tx.select().from(savedViews).where(eq(savedViews.id, id)))[0];
    if (!view) throw new NotFoundError('Saved view');
    if (view.ownerId !== actor.id && actor.role !== 'dos_admin') throw new NotFoundError('Saved view');
    await tx.delete(savedViews).where(eq(savedViews.id, id));
    await audit(tx, actor, 'saved_view.deleted', { type: 'saved_view', id });
  });
}

// ---------------------------------------------------------------- staff management (FR-AUTH-2, FR-ADM-2)

/**
 * Admin: invite a staff member (or change an existing profile's role). Role is
 * assigned server-side only. Invited emails may be outside the student domain list.
 */
export async function inviteStaff(actor: Actor, input: { email: string; fullName?: string; role: Exclude<Role, 'student'> }): Promise<typeof profiles.$inferSelect> {
  assertAdmin(actor);
  const email = String(input.email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ValidationError('Enter a valid email address.', { email: 'Invalid' });
  if (!['dos_staff', 'dos_admin', 'liaison'].includes(input.role)) throw new ValidationError('Invalid role', { role: 'Invalid' });
  return withTx(async (tx) => {
    const existing = (await tx.select().from(profiles).where(eq(profiles.email, email)))[0];
    let id: string;
    if (existing) {
      if (existing.role === 'student') {
        const hasApps = await tx.select({ id: applications.id }).from(applications).where(eq(applications.studentId, existing.id)).limit(1);
        if (hasApps.length) throw new ConflictError('This person has student applications and cannot become staff.');
      }
      id = existing.id;
      await tx
        .update(profiles)
        .set({ role: input.role, fullName: input.fullName ?? existing.fullName, status: 'active', updatedAt: nowIso() })
        .where(eq(profiles.id, id));
      await revokeAllSessionsFor(tx, id);
    } else {
      id = crypto.randomUUID();
      await tx.insert(profiles).values({ id, email, fullName: input.fullName ?? null, role: input.role, invitedBy: actor.id });
    }
    await audit(tx, actor, 'staff.invited', { type: 'profile', id }, { role: input.role, previousRole: existing?.role ?? null });
    return (await tx.select().from(profiles).where(eq(profiles.id, id)))[0]!;
  });
}

/** Admin: enable/disable an account (disabling revokes sessions). */
export async function setProfileStatus(actor: Actor, profileId: string, status: 'active' | 'disabled'): Promise<void> {
  assertAdmin(actor);
  if (profileId === actor.id && status === 'disabled') throw new ValidationError('You cannot disable your own account.');
  await withTx(async (tx) => {
    const p = (await tx.select().from(profiles).where(eq(profiles.id, profileId)))[0];
    if (!p) throw new NotFoundError('Profile');
    await tx.update(profiles).set({ status, updatedAt: nowIso() }).where(eq(profiles.id, profileId));
    if (status === 'disabled') await revokeAllSessionsFor(tx, profileId);
    await audit(tx, actor, 'profile.status_set', { type: 'profile', id: profileId }, { status });
  });
}

/** Admin: list staff/admin/liaison accounts. */
export async function listStaff(actor: Actor): Promise<(typeof profiles.$inferSelect)[]> {
  assertAdmin(actor);
  return getDb()
    .select()
    .from(profiles)
    .where(inArray(profiles.role, ['dos_staff', 'dos_admin', 'liaison']))
    .orderBy(asc(profiles.email));
}
