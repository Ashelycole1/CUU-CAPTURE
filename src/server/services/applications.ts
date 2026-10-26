import 'server-only';
/**
 * Student-side application services (FR-APP, FR-CHK, FR-SUB).
 */
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { computeChecklist, runwaySummary, type ChecklistItem, type RunwaySummary } from '@/domain/rules';
import {
  applicationFieldsPatchSchema,
  applicationFieldsSchema,
  profilePatchSchema,
  profileSchema,
  type ApplicationFieldsPatch,
  type ProfilePatch,
} from '@/domain/schemas';
import { todayInKampala } from '@/domain/dates';
import { canStudentUpload } from '@/domain/state';
import { ACTIVE_STATUSES, type FeeStatus, type RuleSet, type StudentType } from '@/domain/types';
import { en } from '@/i18n/en';
import { interpolate } from '@/i18n';
import {
  assertCanReadApplication,
  assertRole,
  assertStudentOwns,
  canSeeInternalNotes,
  isStaff,
  isStudent,
  type Actor,
} from '../authz';
import { getDb, type DbOrTx, type Tx } from '../db/client';
import {
  applicationDocuments,
  applicationEvents,
  applications,
  documentVersions,
  messages,
  packets,
  payments,
  profiles,
  students,
} from '../db/schema';
import { InvalidStateError, NotFoundError, ValidationError } from '../errors';
import { queueNotification } from '../notify';
import {
  allocateRef,
  audit,
  loadActiveRuleSet,
  loadApplication,
  loadRuleSet,
  nowIso,
  parallelReads,
  recordEvent,
  transition,
  withTx,
  type ApplicationRow,
} from './internal';

export type Application = ApplicationRow;
export type ApplicationDocument = typeof applicationDocuments.$inferSelect;
export type DocumentVersion = typeof documentVersions.$inferSelect;
export type StudentRow = typeof students.$inferSelect;
export type ProfileRow = typeof profiles.$inferSelect;

const ACTIVE = ACTIVE_STATUSES as unknown as ApplicationRow['status'][];

// ---------------------------------------------------------------- helpers

async function loadStudent(tx: DbOrTx, profileId: string): Promise<{ profile: ProfileRow; student: StudentRow | undefined }> {
  const loadProfile = () => tx.select().from(profiles).where(eq(profiles.id, profileId)).then((r) => r[0]);
  // Outside a transaction both lookups go out together (one round trip on the critical
  // path); inside an interactive transaction statements stay sequential.
  const [profile, student] =
    tx === getDb() ? await parallelReads(loadProfile, () => loadStudentRow(tx, profileId)) : [await loadProfile(), await loadStudentRow(tx, profileId)];
  if (!profile) throw new NotFoundError('Profile');
  return { profile, student };
}

async function loadStudentRow(tx: DbOrTx, profileId: string): Promise<StudentRow | undefined> {
  return (await tx.select().from(students).where(eq(students.profileId, profileId)))[0];
}

async function ensureStudentRow(tx: DbOrTx, profileId: string): Promise<StudentRow> {
  await tx.insert(students).values({ profileId }).onConflictDoNothing();
  return (await tx.select().from(students).where(eq(students.profileId, profileId)))[0]!;
}

async function findActiveApplication(tx: DbOrTx, studentId: string): Promise<ApplicationRow | undefined> {
  return (
    await tx
      .select()
      .from(applications)
      .where(and(eq(applications.studentId, studentId), inArray(applications.status, ACTIVE)))
      .limit(1)
  )[0];
}

function feeStatusFor(ruleSet: RuleSet, nationality: string | null | undefined, current: FeeStatus): FeeStatus {
  if (current === 'paid') return 'paid';
  if (!nationality) return current;
  const checklist = computeChecklist(ruleSet, { studentType: 'new', nationality });
  return checklist.feeRequired ? 'unpaid' : 'not_required';
}

/**
 * Bring application_documents in line with the checklist for the student's
 * type/nationality. New items are added as `missing`; items no longer applicable
 * are kept with required=false (PRD §7: orphaned docs kept, marked not required).
 */
export async function syncApplicationDocuments(tx: DbOrTx, app: ApplicationRow, student: StudentRow | undefined): Promise<void> {
  if (!student?.studentType || !student.nationality) return;
  const ruleSet = await loadRuleSet(tx, app.ruleSetId);
  const checklist = computeChecklist(ruleSet, { studentType: student.studentType, nationality: student.nationality });
  const existing = await tx.select().from(applicationDocuments).where(eq(applicationDocuments.applicationId, app.id));
  const now = nowIso();
  const wanted = new Map(checklist.items.map((i) => [i.code, i]));
  for (const item of checklist.items) {
    const doc = existing.find((d) => d.docCode === item.code);
    if (!doc) {
      await tx.insert(applicationDocuments).values({
        applicationId: app.id,
        docCode: item.code,
        required: true,
        minFiles: item.minFiles,
        state: 'missing',
        updatedAt: now,
      });
    } else if (!doc.required || doc.minFiles !== item.minFiles) {
      await tx.update(applicationDocuments).set({ required: true, minFiles: item.minFiles, updatedAt: now }).where(eq(applicationDocuments.id, doc.id));
    }
  }
  for (const doc of existing) {
    if (!wanted.has(doc.docCode) && doc.required) {
      await tx.update(applicationDocuments).set({ required: false, updatedAt: now }).where(eq(applicationDocuments.id, doc.id));
    }
  }
  const fee = feeStatusFor(ruleSet, student.nationality, app.feeStatus);
  if (fee !== app.feeStatus) await tx.update(applications).set({ feeStatus: fee }).where(eq(applications.id, app.id));
}

// ---------------------------------------------------------------- services

/**
 * Student: return the active application, creating a draft under the current
 * published rule set if none exists (FR-APP-3/4). Idempotent and race-safe.
 */
export async function getOrCreateDraft(actor: Actor): Promise<Application> {
  assertRole(actor, ['student']);
  // Fast path (every /apply and /profile view): a plain read, no write lock. Only a
  // student WITHOUT an active application pays for the write transaction below.
  const current = await findActiveApplication(getDb(), actor.id);
  if (current) return current;
  try {
    return await withTx(async (tx) => {
      const existing = await findActiveApplication(tx, actor.id);
      if (existing) return existing;
      const student = await ensureStudentRow(tx, actor.id);
      const ruleSet = await loadActiveRuleSet(tx);
      const id = crypto.randomUUID();
      const now = nowIso();
      await tx.insert(applications).values({
        id,
        studentId: actor.id,
        ruleSetId: ruleSet.id,
        status: 'draft',
        currentExpiry: student.passExpiry,
        noPass: student.noPass,
        feeStatus: 'unpaid',
        lastActivityAt: now,
        createdAt: now,
      });
      const app = (await tx.select().from(applications).where(eq(applications.id, id)))[0]!;
      await syncApplicationDocuments(tx, app, student);
      await recordEvent(tx, actor, id, 'created', { ruleSetVersion: ruleSet.version }, { at: now });
      await audit(tx, actor, 'application.created', { type: 'application', id }, { ruleSetVersion: ruleSet.version });
      return (await tx.select().from(applications).where(eq(applications.id, id)))[0]!;
    });
  } catch (e) {
    // Lost a race on the one-active-application unique index: return the winner.
    if (/applications_one_active_uq|UNIQUE constraint failed: applications\.student_id/i.test(String((e as Error).message) + String((e as { cause?: Error }).cause?.message ?? ''))) {
      const app = await findActiveApplication(getDb(), actor.id);
      if (app) return app;
    }
    throw e;
  }
}

/** Student's applications, newest first (previous ones are read-only history; FR-APP-4). */
export async function listMyApplications(actor: Actor): Promise<Application[]> {
  assertRole(actor, ['student']);
  return getDb().select().from(applications).where(eq(applications.studentId, actor.id)).orderBy(desc(applications.createdAt));
}

/** Student: the active application, or null (does not create one). */
export async function getMyActiveApplication(actor: Actor): Promise<Application | null> {
  assertRole(actor, ['student']);
  return (await findActiveApplication(getDb(), actor.id)) ?? null;
}

export interface StudentProfileView {
  profileId: string;
  email: string;
  fullName: string | null;
  studentNo: string | null;
  nationality: string | null;
  studentType: StudentType | null;
  programme: string | null;
  phone: string | null;
  passExpiry: string | null;
  noPass: boolean;
  /** A permanent bounce or complaint was recorded (D-J10): show "Student unreachable". */
  emailBounced: boolean;
}

function toProfileView(profile: ProfileRow, student: StudentRow | undefined): StudentProfileView {
  return {
    profileId: profile.id,
    email: profile.email,
    fullName: profile.fullName,
    studentNo: student?.studentNo ?? null,
    nationality: student?.nationality ?? null,
    studentType: student?.studentType ?? null,
    programme: student?.programme ?? null,
    phone: student?.phone ?? null,
    passExpiry: student?.passExpiry ?? null,
    noPass: student?.noPass ?? false,
    emailBounced: profile.emailStatus === 'bounced',
  };
}

export async function getStudentProfile(actor: Actor, profileId: string = actor.id): Promise<StudentProfileView> {
  if (isStudent(actor) && profileId !== actor.id) throw new NotFoundError('Profile');
  if (!isStudent(actor) && !isStaff(actor)) throw new NotFoundError('Profile');
  const { profile, student } = await loadStudent(getDb(), profileId);
  return toProfileView(profile, student);
}

/**
 * Student: autosave profile fields (FR-APP-1/3). Recomputes the checklist of the
 * draft. Locked once the active application has been submitted (FR-SUB-4).
 */
export async function updateStudentProfile(actor: Actor, patch: ProfilePatch): Promise<StudentProfileView> {
  assertRole(actor, ['student']);
  const parsed = profilePatchSchema.safeParse(patch);
  if (!parsed.success) throw zodToValidation(parsed.error);
  const data = parsed.data;
  try {
    return await withTx(async (tx) => {
      const active = await findActiveApplication(tx, actor.id);
      if (active && active.status !== 'draft') throw new InvalidStateError('Your application has been submitted, so your profile is locked.');
      const now = nowIso();
      if (data.fullName !== undefined) await tx.update(profiles).set({ fullName: data.fullName, updatedAt: now }).where(eq(profiles.id, actor.id));
      await ensureStudentRow(tx, actor.id);
      const studentPatch: Partial<StudentRow> = {};
      if (data.studentNo !== undefined) studentPatch.studentNo = data.studentNo;
      if (data.nationality !== undefined) studentPatch.nationality = data.nationality;
      if (data.studentType !== undefined) studentPatch.studentType = data.studentType;
      if (data.programme !== undefined) studentPatch.programme = data.programme;
      if ('phone' in data) studentPatch.phone = data.phone ?? null;
      if (Object.keys(studentPatch).length) {
        await tx.update(students).set({ ...studentPatch, updatedAt: now }).where(eq(students.profileId, actor.id));
      }
      const { profile, student } = await loadStudent(tx, actor.id);
      if (active) await syncApplicationDocuments(tx, active, student);
      await audit(tx, actor, 'profile.updated', { type: 'profile', id: actor.id }, { fields: Object.keys(data) });
      return toProfileView(profile, student);
    });
  } catch (e) {
    if (/students_student_no_uq|UNIQUE constraint failed: students\.student_no/i.test(String((e as Error).message) + String((e as { cause?: Error }).cause?.message ?? ''))) {
      // PRD §7: same student number registered twice → block and route to staff.
      const msg = 'This student number is already registered. Contact the Dean of Students.';
      throw new ValidationError(msg, { studentNo: msg });
    }
    throw e;
  }
}

/** Student: autosave application fields (FR-APP-2) on a draft. */
export async function updateApplicationFields(actor: Actor, applicationId: string, patch: ApplicationFieldsPatch): Promise<Application> {
  const parsed = applicationFieldsPatchSchema.safeParse(patch);
  if (!parsed.success) throw zodToValidation(parsed.error);
  const data = parsed.data;
  return withTx(async (tx) => {
    const app = await loadApplication(tx, applicationId);
    assertStudentOwns(actor, app);
    if (app.status !== 'draft') throw new InvalidStateError('This application has been submitted and can no longer be edited.');
    const set: Partial<ApplicationRow> = {};
    if (data.noPass !== undefined) set.noPass = data.noPass;
    if (data.currentExpiry !== undefined) set.currentExpiry = data.currentExpiry;
    if (data.noPass === true) set.currentExpiry = null;
    if (data.requestedMonths !== undefined) set.requestedMonths = data.requestedMonths;
    if (data.notes !== undefined) set.notes = data.notes;
    const now = nowIso();
    const [updated] = await tx
      .update(applications)
      .set({ ...set, updatedAt: now, lastActivityAt: now })
      .where(eq(applications.id, app.id))
      .returning();
    if (set.currentExpiry !== undefined || set.noPass !== undefined) {
      await tx
        .update(students)
        .set({ passExpiry: updated!.currentExpiry, noPass: updated!.noPass, updatedAt: now })
        .where(eq(students.profileId, actor.id));
    }
    await audit(tx, actor, 'application.fields_updated', { type: 'application', id: app.id }, { fields: Object.keys(data) });
    return updated!;
  });
}

export interface ChecklistEntryView {
  item: ChecklistItem;
  document: ApplicationDocument | null;
  /** Current (non-superseded) versions, one per page, ordered by page. */
  currentVersions: Pick<DocumentVersion, 'id' | 'page' | 'seq' | 'width' | 'height' | 'bytes' | 'uploadedAt'>[];
  canUpload: boolean;
}

export interface ChecklistView {
  applicationId: string;
  status: Application['status'];
  ruleSetVersion: number;
  profileComplete: boolean;
  items: ChecklistEntryView[];
  /** Orphaned documents (kept, "not required"; PRD §7). */
  notRequired: ApplicationDocument[];
  feeRequired: boolean;
  feeUsd: number;
  feeStatus: FeeStatus;
  runway: RunwaySummary;
  progress: { done: number; total: number };
}

/** Checklist merged with per-document state (FR-CHK-1/2/3/5). Readable by owner and staff. */
export async function getChecklistForApplication(actor: Actor, applicationId: string, today: string = todayInKampala()): Promise<ChecklistView> {
  const db = getDb();
  const app = await loadApplication(db, applicationId);
  assertCanReadApplication(actor, app);
  const full = app as ApplicationRow;
  // Authorized: everything else in one parallel wave (rule set usually from the read cache).
  const [student, ruleSet, docs, versions] = await parallelReads(
    () => loadStudentRow(db, full.studentId),
    () => loadRuleSet(db, full.ruleSetId),
    () => db.select().from(applicationDocuments).where(eq(applicationDocuments.applicationId, full.id)),
    () =>
      db
        .select()
        .from(documentVersions)
        .where(and(eq(documentVersions.applicationId, full.id), isNull(documentVersions.supersededAt), isNull(documentVersions.deletedAt)))
        .orderBy(asc(documentVersions.page)),
  );
  return buildChecklistView(actor, full, student, ruleSet, docs, versions, today);
}

/** Pure: checklist view from already-authorized rows (`versions` = current versions, any order). */
function buildChecklistView(
  actor: Actor,
  full: ApplicationRow,
  student: StudentRow | undefined,
  ruleSet: RuleSet,
  docs: ApplicationDocument[],
  allCurrent: DocumentVersion[],
  today: string,
): ChecklistView {
  const versions = [...allCurrent].sort((a, b) => a.page - b.page);
  const profileComplete = Boolean(student?.studentType && student.nationality);
  const checklist = profileComplete
    ? computeChecklist(ruleSet, { studentType: student!.studentType!, nationality: student!.nationality! })
    : null;
  const items: ChecklistEntryView[] = (checklist?.items ?? []).map((item) => {
    const document = docs.find((d) => d.docCode === item.code) ?? null;
    return {
      item,
      document: document ? redactDocForActor(actor, document) : null,
      currentVersions: document
        ? versions
            .filter((v) => v.applicationDocumentId === document.id)
            .map((v) => ({ id: v.id, page: v.page, seq: v.seq, width: v.width, height: v.height, bytes: v.bytes, uploadedAt: v.uploadedAt }))
        : [],
      canUpload: isStudent(actor) && !!document && canStudentUpload(full.status, document.state),
    };
  });
  const done = items.filter((i) => i.document && (i.document.state === 'uploaded' || i.document.state === 'approved')).length;
  return {
    applicationId: full.id,
    status: full.status,
    ruleSetVersion: ruleSet.version,
    profileComplete,
    items,
    notRequired: docs.filter((d) => !d.required).map((d) => redactDocForActor(actor, d)),
    feeRequired: checklist?.feeRequired ?? true,
    feeUsd: ruleSet.feeUsd,
    feeStatus: full.feeStatus,
    runway: runwaySummary(full.noPass ? null : full.currentExpiry, today, ruleSet),
    progress: { done, total: items.length },
  };
}

function redactDocForActor(actor: Actor, d: ApplicationDocument): ApplicationDocument {
  return isStaff(actor) ? d : { ...d, reviewerId: null };
}

export interface SubmitBlockers {
  missingDocs: string[];
  profileErrors: Record<string, string>;
  fieldErrors: Record<string, string>;
}

/** What prevents submission (FR-SUB-2). Empty arrays/objects = ready. */
export async function getSubmitBlockers(actor: Actor, applicationId: string): Promise<SubmitBlockers> {
  const db = getDb();
  const app = await loadApplication(db, applicationId);
  assertStudentOwns(actor, app);
  return computeBlockers(db, app as ApplicationRow);
}

async function computeBlockers(tx: DbOrTx, app: ApplicationRow): Promise<SubmitBlockers> {
  const { profile, student } = await loadStudent(tx, app.studentId);
  const profileErrors: Record<string, string> = {};
  const p = profileSchema.safeParse({
    fullName: profile.fullName ?? '',
    studentNo: student?.studentNo ?? '',
    nationality: student?.nationality ?? '',
    studentType: student?.studentType ?? undefined,
    programme: student?.programme ?? '',
    phone: student?.phone ?? '',
  });
  if (!p.success) for (const i of p.error.issues) profileErrors[String(i.path[0])] ??= i.message;
  const fieldErrors: Record<string, string> = {};
  const f = applicationFieldsSchema.safeParse({
    noPass: app.noPass,
    currentExpiry: app.currentExpiry,
    requestedMonths: app.requestedMonths ?? undefined,
    notes: app.notes,
  });
  if (!f.success) for (const i of f.error.issues) fieldErrors[String(i.path[0])] ??= i.message;
  const docs = await tx
    .select()
    .from(applicationDocuments)
    .where(and(eq(applicationDocuments.applicationId, app.id), eq(applicationDocuments.required, true)));
  const missingDocs = docs.filter((d) => d.state !== 'uploaded' && d.state !== 'approved').map((d) => d.docCode);
  if (docs.length === 0 && Object.keys(profileErrors).length === 0) missingDocs.push('*');
  return { missingDocs, profileErrors, fieldErrors };
}

/**
 * Student: submit (FR-SUB-2/3/4). Requires a valid profile and fields and every
 * required document `uploaded`. Assigns the VD-YYYY-NNNNN ref, freezes the
 * application, and queues the receipt email (dedupe `receipt:{id}`).
 */
export async function submitApplication(actor: Actor, applicationId: string): Promise<Application> {
  return withTx(async (tx) => {
    const app = await loadApplication(tx, applicationId);
    assertStudentOwns(actor, app);
    if (app.status !== 'draft') throw new InvalidStateError('This application has already been submitted.');
    const blockers = await computeBlockers(tx, app);
    if (blockers.missingDocs.length || Object.keys(blockers.profileErrors).length || Object.keys(blockers.fieldErrors).length) {
      const msg = Object.keys(blockers.profileErrors).length
        ? en.submit.profileIncomplete
        : Object.keys(blockers.fieldErrors).length
          ? en.submit.expiryMissing
          : interpolate(en.submit.missingDocs, { docs: blockers.missingDocs.join(', ') });
      throw new ValidationError(msg, { ...blockers.profileErrors, ...blockers.fieldErrors }, { ...blockers });
    }
    const ruleSet = await loadRuleSet(tx, app.ruleSetId);
    const { student } = await loadStudent(tx, app.studentId);
    const ref = app.ref ?? (await allocateRef(tx));
    const now = nowIso();
    const updated = await transition(
      tx,
      actor,
      app,
      'submit',
      { ref, submittedAt: now, feeStatus: feeStatusFor(ruleSet, student?.nationality, app.feeStatus) },
      { ref },
    );
    await queueNotification(tx, { kind: 'receipt', recipientId: app.studentId, applicationId: app.id, dedupeKey: `receipt:${app.id}` });
    // PRD §7: pass already expired → DOS notified immediately.
    const band = runwaySummary(app.noPass ? null : app.currentExpiry, todayInKampala(), ruleSet).band;
    if (band === 'expired') await notifyAdmins(tx, `expired_submit:${app.id}`, app.id, `Expired pass: application ${ref} was submitted after the pass expired.`);
    return updated;
  });
}

export async function notifyAdmins(tx: Tx, dedupePrefix: string, applicationId: string | null, text: string): Promise<void> {
  const admins = await tx
    .select({ id: profiles.id })
    .from(profiles)
    .where(and(inArray(profiles.role, ['dos_admin']), eq(profiles.status, 'active'), isNull(profiles.deletedAt)));
  for (const a of admins) {
    await queueNotification(tx, { kind: 'staff_alert', recipientId: a.id, applicationId, dedupeKey: `${dedupePrefix}:${a.id}`, payload: { text } });
  }
}

/** Student: withdraw an application that has not been approved yet. */
export async function withdrawApplication(actor: Actor, applicationId: string): Promise<Application> {
  return withTx(async (tx) => {
    const app = await loadApplication(tx, applicationId);
    assertStudentOwns(actor, app);
    return transition(tx, actor, app, 'withdraw', { withdrawnAt: nowIso(), claimedBy: null, claimedUntil: null });
  });
}

// ---------------------------------------------------------------- detail

export interface ApplicationDetail {
  application: Application;
  student: StudentProfileView;
  ruleSetVersion: number;
  checklist: ChecklistView;
  documents: (ApplicationDocument & { versions: DocumentVersion[] })[];
  events: (typeof applicationEvents.$inferSelect)[];
  messages: (typeof messages.$inferSelect)[];
  /** Staff only (empty for students). */
  payments: (typeof payments.$inferSelect)[];
  /** Staff only (empty for students). */
  packets: Omit<typeof packets.$inferSelect, 'storageKey'>[];
}

/**
 * Full detail for the owner or staff (FR-DOS-4). For students: staff-only events,
 * internal notes, reviewer ids, claim info, payments and packets are removed.
 */
export async function getApplicationDetail(actor: Actor, applicationId: string): Promise<ApplicationDetail> {
  const db = getDb();
  const app = await loadApplication(db, applicationId);
  assertCanReadApplication(actor, app);
  const full = app as ApplicationRow;
  const staff = isStaff(actor);
  // One parallel wave after the authorization read. The checklist is built from the
  // same rows (it used to re-load the application, student, rule set, documents and
  // versions: 7 extra round trips per detail view).
  const [{ profile, student: studentRow }, docs, versions, events, msgs, pays, pkts, ruleSet] = await parallelReads(
    () => loadStudent(db, full.studentId),
    () => db.select().from(applicationDocuments).where(eq(applicationDocuments.applicationId, full.id)),
    () => db.select().from(documentVersions).where(and(eq(documentVersions.applicationId, full.id), isNull(documentVersions.deletedAt))).orderBy(asc(documentVersions.seq)),
    () =>
      db
        .select()
        .from(applicationEvents)
        .where(staff ? eq(applicationEvents.applicationId, full.id) : and(eq(applicationEvents.applicationId, full.id), eq(applicationEvents.visibleToStudent, true)))
        .orderBy(asc(applicationEvents.at)),
    () =>
      db
        .select()
        .from(messages)
        .where(canSeeInternalNotes(actor) ? eq(messages.applicationId, full.id) : and(eq(messages.applicationId, full.id), eq(messages.internal, false)))
        .orderBy(asc(messages.at)),
    () => (staff ? db.select().from(payments).where(eq(payments.applicationId, full.id)) : Promise.resolve([])),
    () => (staff ? db.select().from(packets).where(eq(packets.applicationId, full.id)).orderBy(desc(packets.createdAt)) : Promise.resolve([])),
    () => loadRuleSet(db, full.ruleSetId),
  );
  const application: Application = staff ? full : { ...full, claimedBy: null, claimedUntil: null, approvedBy: null };
  const student = toProfileView(profile, studentRow);
  const checklist = buildChecklistView(
    actor,
    full,
    studentRow,
    ruleSet,
    docs,
    versions.filter((v) => !v.supersededAt),
    todayInKampala(),
  );
  return {
    application,
    student,
    ruleSetVersion: ruleSet.version,
    checklist,
    documents: docs.map((d) => ({
      ...redactDocForActor(actor, d),
      versions: versions
        .filter((v) => v.applicationDocumentId === d.id)
        .map((v) => (staff ? v : { ...v, storageKey: '', thumbKey: null })),
    })),
    events,
    messages: msgs,
    payments: pays,
    packets: pkts.map(({ storageKey: _s, ...rest }) => rest),
  };
}


function zodToValidation(error: { issues: { path: PropertyKey[]; message: string }[] }): ValidationError {
  const fieldErrors: Record<string, string> = {};
  for (const i of error.issues) fieldErrors[String(i.path[0] ?? 'form')] ??= i.message;
  return new ValidationError('Please check the highlighted fields.', fieldErrors);
}
export { zodToValidation };
