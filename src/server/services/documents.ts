import 'server-only';
/**
 * Document services: upload registration (FR-UP-5/6), review (FR-REV-3/5),
 * review queue (FR-REV-1), and authorized file access (NFR-SEC).
 */
import { and, asc, desc, eq, inArray, isNull, max, ne, sql } from 'drizzle-orm';
import { canStudentUpload, nextDocumentState, REVIEWABLE_STATUSES } from '@/domain/state';
import { reviewDecisionSchema, type ReviewDecisionInput } from '@/domain/schemas';
import {
  assertCanReadApplication,
  assertStaff,
  assertStudentOwns,
  canReadFile,
  fileViewIsAudited,
  type Actor,
} from '../authz';
import { getDb, type Tx } from '../db/client';
import {
  applicationDocuments,
  applications,
  documentVersions,
  packets,
  payments,
  profiles,
  reasonTemplates,
  ruleDocuments,
  students,
  type QualityReport,
} from '../db/schema';
import { ConflictError, InvalidStateError, NotFoundError, ValidationError } from '../errors';
import { queueNotification } from '../notify';
import { blobKeys } from '../storage/types';
import { audit, loadApplication, loadApplicationOrThrow, nowIso, recordEvent, transition, withTx, type ApplicationRow } from './internal';
import { zodToValidation, type Application, type ApplicationDocument, type DocumentVersion } from './applications';

export const CLAIM_MINUTES = 15;

async function loadDocByCode(tx: Tx, applicationId: string, docCode: string): Promise<ApplicationDocument> {
  const doc = (
    await tx
      .select()
      .from(applicationDocuments)
      .where(and(eq(applicationDocuments.applicationId, applicationId), eq(applicationDocuments.docCode, docCode)))
  )[0];
  if (!doc) throw new NotFoundError('Document');
  return doc;
}

function assertUploadAllowed(app: ApplicationRow, doc: ApplicationDocument, page: number): void {
  if (!doc.required) throw new InvalidStateError('This document is no longer required.');
  if (!canStudentUpload(app.status, doc.state)) {
    throw new InvalidStateError(
      doc.state === 'approved' ? 'This document is already approved.' : 'This document cannot be changed right now.',
      { status: app.status, state: doc.state },
    );
  }
  const maxPage = Math.max(1, doc.minFiles);
  if (!Number.isInteger(page) || page < 1 || page > maxPage) throw new ValidationError(`Page must be between 1 and ${maxPage}.`, { page: 'Invalid page' });
}

export interface PreparedUpload {
  applicationDocumentId: string;
  seq: number;
  /** Logical keys to pass to `BlobStore.put` (persist the keys `put` returns). */
  storageKey: string;
  thumbKey: string;
}

/**
 * Upload pipeline step 1: authz + state check, and reserve the next sequence
 * number for the storage key layout `{application_id}/{doc_code}/{seq}.jpg`.
 * Read-only (no rows written). If two uploads race for the same seq, the second
 * `registerDocumentVersion` fails with ConflictError; the client retries.
 */
export async function prepareDocumentUpload(
  actor: Actor,
  input: { applicationId: string; docCode: string; page?: number },
): Promise<PreparedUpload> {
  const db = getDb();
  const app = await loadApplication(db, input.applicationId);
  assertStudentOwns(actor, app);
  const doc = (
    await db
      .select()
      .from(applicationDocuments)
      .where(and(eq(applicationDocuments.applicationId, app.id), eq(applicationDocuments.docCode, input.docCode)))
  )[0];
  if (!doc) throw new NotFoundError('Document');
  assertUploadAllowed(app, doc, input.page ?? 1);
  const m = await db.select({ m: max(documentVersions.seq) }).from(documentVersions).where(eq(documentVersions.applicationDocumentId, doc.id));
  const seq = (m[0]?.m ?? 0) + 1;
  return {
    applicationDocumentId: doc.id,
    seq,
    storageKey: blobKeys.documentVersion(app.id, doc.docCode, seq),
    thumbKey: blobKeys.documentThumb(app.id, doc.docCode, seq),
  };
}

/**
 * Upload idempotency (FR-UP-4): the ACTIVE version of `docCode`/`page` with this exact
 * hash, if any, for an application OWNED by `actor`. One round trip (it used to load
 * the whole application detail). Returns null for other students' applications.
 */
export async function findActiveVersionByHash(
  actor: Actor,
  input: { applicationId: string; docCode: string; page: number; sha256: string },
): Promise<{ version: Pick<DocumentVersion, 'id' | 'page'>; doc: Pick<ApplicationDocument, 'id' | 'docCode' | 'state'> } | null> {
  if (actor.role !== 'student') return null;
  const row = (
    await getDb()
      .select({ versionId: documentVersions.id, page: documentVersions.page, docId: applicationDocuments.id, docCode: applicationDocuments.docCode, state: applicationDocuments.state })
      .from(documentVersions)
      .innerJoin(applicationDocuments, eq(applicationDocuments.id, documentVersions.applicationDocumentId))
      .innerJoin(applications, eq(applications.id, documentVersions.applicationId))
      .where(
        and(
          eq(applications.id, input.applicationId),
          eq(applications.studentId, actor.id),
          eq(applicationDocuments.docCode, input.docCode),
          eq(documentVersions.page, input.page),
          eq(documentVersions.sha256, input.sha256),
          isNull(documentVersions.supersededAt),
          isNull(documentVersions.deletedAt),
        ),
      )
      .limit(1)
  )[0];
  return row ? { version: { id: row.versionId, page: row.page }, doc: { id: row.docId, docCode: row.docCode, state: row.state } } : null;
}

export interface RegisterVersionInput {
  applicationId: string;
  docCode: string;
  /** 1-based page for multi-file items (default 1). */
  page?: number;
  /** From prepareDocumentUpload. */
  seq: number;
  /** Keys RETURNED by BlobStore.put. */
  storageKey: string;
  thumbKey?: string | null;
  sha256: string;
  width: number;
  height: number;
  bytes: number;
  quality?: QualityReport | null;
}

export interface RegisterVersionResult {
  version: DocumentVersion;
  document: ApplicationDocument;
  application: Application;
  /** FR-UP-6: other document types in this application with the same file hash. */
  duplicateOf: string[];
}

/**
 * Upload pipeline step 2 (after server validation + encrypted put): insert the
 * version, supersede the previous version of the same page, set the document to
 * `uploaded` when all `min_files` pages are present. Only for the owning student,
 * only when the document is not approved and the application is editable.
 * When the last rejected document of a `corrections_needed` application is
 * replaced, the application returns to `under_review` automatically.
 */
export async function registerDocumentVersion(actor: Actor, input: RegisterVersionInput): Promise<RegisterVersionResult> {
  const page = input.page ?? 1;
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) throw new ValidationError('Invalid file hash', { sha256: 'Invalid' });
  if (![input.width, input.height, input.bytes, input.seq].every((n) => Number.isInteger(n) && n > 0)) {
    throw new ValidationError('Invalid file metadata');
  }
  return withTx(async (tx) => {
    const app = await loadApplication(tx, input.applicationId);
    assertStudentOwns(actor, app);
    const doc = await loadDocByCode(tx, app.id, input.docCode);
    assertUploadAllowed(app, doc, page);
    const now = nowIso();

    const taken = await tx
      .select({ id: documentVersions.id })
      .from(documentVersions)
      .where(and(eq(documentVersions.applicationDocumentId, doc.id), eq(documentVersions.seq, input.seq)));
    if (taken.length) throw new ConflictError('Another upload for this document finished first. Please retry.');

    await tx
      .update(documentVersions)
      .set({ supersededAt: now })
      .where(and(eq(documentVersions.applicationDocumentId, doc.id), eq(documentVersions.page, page), isNull(documentVersions.supersededAt)));

    const versionId = crypto.randomUUID();
    await tx.insert(documentVersions).values({
      id: versionId,
      applicationDocumentId: doc.id,
      applicationId: app.id,
      seq: input.seq,
      page,
      storageKey: input.storageKey,
      thumbKey: input.thumbKey ?? null,
      sha256: input.sha256,
      width: input.width,
      height: input.height,
      bytes: input.bytes,
      quality: input.quality ?? null,
      uploadedBy: actor.id,
      uploadedAt: now,
    });

    const active = await tx
      .select({ page: documentVersions.page })
      .from(documentVersions)
      .where(and(eq(documentVersions.applicationDocumentId, doc.id), isNull(documentVersions.supersededAt), isNull(documentVersions.deletedAt)));
    const pages = new Set(active.map((a) => a.page));
    const complete = Array.from({ length: Math.max(1, doc.minFiles) }, (_, i) => i + 1).every((p) => pages.has(p));
    const newState = complete ? nextDocumentState(doc.state, 'upload')! : doc.state;
    const [document] = await tx
      .update(applicationDocuments)
      .set({
        state: newState,
        currentVersionId: versionId,
        updatedAt: now,
        ...(newState === 'uploaded' ? { reviewerId: null, reviewerReasonCode: null, reviewerNote: null, reviewedAt: null } : {}),
      })
      .where(eq(applicationDocuments.id, doc.id))
      .returning();

    const dups = await tx
      .select({ docCode: applicationDocuments.docCode })
      .from(documentVersions)
      .innerJoin(applicationDocuments, eq(applicationDocuments.id, documentVersions.applicationDocumentId))
      .where(
        and(
          eq(documentVersions.applicationId, app.id),
          eq(documentVersions.sha256, input.sha256),
          ne(documentVersions.applicationDocumentId, doc.id),
          isNull(documentVersions.supersededAt),
          isNull(documentVersions.deletedAt),
        ),
      );
    const duplicateOf = [...new Set(dups.map((d) => d.docCode))];

    await recordEvent(tx, actor, app.id, 'document_uploaded', { docCode: doc.docCode, page, seq: input.seq, wasRejected: doc.state === 'rejected' }, { at: now });
    await audit(tx, actor, 'document.uploaded', { type: 'document_version', id: versionId }, {
      applicationId: app.id,
      docCode: doc.docCode,
      page,
      seq: input.seq,
      sha256: input.sha256,
      duplicateOf,
    });

    let application = (await tx.update(applications).set({ lastActivityAt: now, updatedAt: now }).where(eq(applications.id, app.id)).returning())[0]!;
    if (application.status === 'corrections_needed') {
      const stillRejected = await tx
        .select({ id: applicationDocuments.id })
        .from(applicationDocuments)
        .where(and(eq(applicationDocuments.applicationId, app.id), eq(applicationDocuments.required, true), eq(applicationDocuments.state, 'rejected')));
      if (stillRejected.length === 0) application = await transition(tx, actor, application, 'corrections_resubmitted');
    }
    const version = (await tx.select().from(documentVersions).where(eq(documentVersions.id, versionId)))[0]!;
    return { version, document: document!, application, duplicateOf };
  });
}

// ---------------------------------------------------------------- claims (FR-REV-6)

function claimActive(app: ApplicationRow, now: Date): boolean {
  return !!app.claimedBy && !!app.claimedUntil && new Date(app.claimedUntil).getTime() > now.getTime();
}

function claimUntil(now: Date): string {
  return new Date(now.getTime() + CLAIM_MINUTES * 60_000).toISOString();
}

/**
 * Staff: claim (or refresh a claim on) an application for 15 minutes. Moves a
 * `submitted` application to `under_review`. ConflictError if another reviewer
 * holds an unexpired claim (details.claimedBy, details.claimedUntil).
 */
export async function claimApplication(actor: Actor, applicationId: string, now: Date = new Date()): Promise<Application> {
  assertStaff(actor);
  return withTx(async (tx) => {
    let app = await loadApplicationOrThrow(tx, applicationId);
    if (!REVIEWABLE_STATUSES.includes(app.status)) throw new InvalidStateError('This application is not open for review.');
    if (claimActive(app, now) && app.claimedBy !== actor.id) {
      throw new ConflictError('Another reviewer is working on this application.', { claimedBy: app.claimedBy, claimedUntil: app.claimedUntil });
    }
    const refreshing = app.claimedBy === actor.id && claimActive(app, now);
    if (app.status === 'submitted') app = await transition(tx, actor, app, 'start_review');
    const [updated] = await tx
      .update(applications)
      .set({ claimedBy: actor.id, claimedUntil: claimUntil(now) })
      .where(eq(applications.id, app.id))
      .returning();
    if (!refreshing) {
      await recordEvent(tx, actor, app.id, 'claimed', {}, { visibleToStudent: false });
      await audit(tx, actor, 'application.claimed', { type: 'application', id: app.id });
    }
    return updated!;
  });
}

/** Staff: release own claim (admins may release anyone's). */
export async function releaseClaim(actor: Actor, applicationId: string): Promise<Application> {
  assertStaff(actor);
  return withTx(async (tx) => {
    const app = await loadApplicationOrThrow(tx, applicationId);
    if (app.claimedBy && app.claimedBy !== actor.id && actor.role !== 'dos_admin') {
      throw new ConflictError('Only the reviewer who claimed this application can release it.');
    }
    const [updated] = await tx.update(applications).set({ claimedBy: null, claimedUntil: null }).where(eq(applications.id, app.id)).returning();
    if (app.claimedBy) {
      await recordEvent(tx, actor, app.id, 'claim_released', {}, { visibleToStudent: false });
      await audit(tx, actor, 'application.claim_released', { type: 'application', id: app.id });
    }
    return updated!;
  });
}

// ---------------------------------------------------------------- review (FR-REV-3/5)

export interface ReviewResult {
  document: ApplicationDocument;
  application: Application;
  /** True when no required document is left awaiting a decision. */
  allDecided: boolean;
  /** True when this decision queued the single batched corrections email. */
  correctionsNotified: boolean;
}

/**
 * Staff: approve or reject one uploaded document. Rejection requires a reason
 * code (an active reason template; `other` also requires a note). When the last
 * pending document is decided and any are rejected, the application moves to
 * `corrections_needed` and ONE notification listing every rejected document is
 * queued (dedupe `corrections:{appId}:{round}`). If all are approved the status
 * stays `under_review` until `markApproved`.
 */
export async function reviewDocument(actor: Actor, input: ReviewDecisionInput, now: Date = new Date()): Promise<ReviewResult> {
  assertStaff(actor);
  const parsed = reviewDecisionSchema.safeParse(input);
  if (!parsed.success) throw zodToValidation(parsed.error);
  const { documentId, decision, reasonCode, note } = parsed.data;
  return withTx(async (tx) => {
    const doc = (await tx.select().from(applicationDocuments).where(eq(applicationDocuments.id, documentId)))[0];
    if (!doc) throw new NotFoundError('Document');
    let app = await loadApplicationOrThrow(tx, doc.applicationId);
    if (!REVIEWABLE_STATUSES.includes(app.status)) throw new InvalidStateError('This application is not open for review.');
    if (claimActive(app, now) && app.claimedBy !== actor.id) {
      throw new ConflictError('Another reviewer is working on this application.', { claimedBy: app.claimedBy, claimedUntil: app.claimedUntil });
    }
    if (!doc.required) throw new InvalidStateError('This document is not required.');
    const to = nextDocumentState(doc.state, decision === 'approve' ? 'approve' : 'reject');
    if (!to) throw new InvalidStateError(`Only uploaded documents can be reviewed (this one is ${doc.state}).`);
    if (decision === 'reject') {
      const tpl = (await tx.select().from(reasonTemplates).where(and(eq(reasonTemplates.code, reasonCode!), eq(reasonTemplates.active, true))))[0];
      if (!tpl) throw new ValidationError('Choose a valid reason.', { reasonCode: 'Unknown reason' });
    }
    if (app.status === 'submitted') app = await transition(tx, actor, app, 'start_review');
    const ts = now.toISOString();
    const [document] = await tx
      .update(applicationDocuments)
      .set({
        state: to,
        reviewerId: actor.id,
        reviewerReasonCode: decision === 'reject' ? reasonCode! : null,
        reviewerNote: note ?? null,
        reviewedAt: ts,
        updatedAt: ts,
      })
      .where(and(eq(applicationDocuments.id, doc.id), eq(applicationDocuments.state, doc.state)))
      .returning();
    if (!document) throw new InvalidStateError('This document changed while you were reviewing it. Reload and try again.');

    await recordEvent(
      tx,
      actor,
      app.id,
      'document_reviewed',
      { docCode: doc.docCode, decision, reasonCode: decision === 'reject' ? reasonCode : null, note: decision === 'reject' ? (note ?? null) : null },
      { at: ts },
    );
    await audit(tx, actor, 'document.reviewed', { type: 'application_document', id: doc.id }, {
      applicationId: app.id,
      docCode: doc.docCode,
      decision,
      reasonCode: reasonCode ?? null,
      versionId: doc.currentVersionId,
    });

    // Refresh the claim (activity heartbeat).
    const refreshed = await tx
      .update(applications)
      .set({ claimedBy: actor.id, claimedUntil: claimUntil(now), lastActivityAt: ts, updatedAt: ts })
      .where(eq(applications.id, app.id))
      .returning();
    app = refreshed[0]!;

    const reqDocs = await tx
      .select()
      .from(applicationDocuments)
      .where(and(eq(applicationDocuments.applicationId, app.id), eq(applicationDocuments.required, true)));
    const pending = reqDocs.filter((d) => d.state === 'uploaded' || d.state === 'missing');
    const rejected = reqDocs.filter((d) => d.state === 'rejected');
    const allDecided = pending.length === 0;
    let correctionsNotified = false;

    const shouldNotify =
      allDecided && rejected.length > 0 && (app.status === 'under_review' || (app.status === 'corrections_needed' && decision === 'reject'));
    if (shouldNotify) {
      const round = app.correctionsRound + 1;
      if (app.status === 'under_review') {
        app = await transition(tx, actor, app, 'request_corrections', { correctionsRound: round }, { rejected: rejected.map((d) => d.docCode) });
      } else {
        app = (await tx.update(applications).set({ correctionsRound: round }).where(eq(applications.id, app.id)).returning())[0]!;
      }
      correctionsNotified = await queueNotification(tx, {
        kind: 'corrections_needed',
        recipientId: app.studentId,
        applicationId: app.id,
        dedupeKey: `corrections:${app.id}:${round}`,
        payload: { items: rejected.map((d) => ({ docCode: d.docCode, reasonCode: d.reviewerReasonCode, note: d.reviewerNote })) },
      });
    }
    return { document, application: app, allDecided, correctionsNotified };
  });
}

// ---------------------------------------------------------------- review queue (FR-REV-1)

export interface ReviewQueueItem {
  documentId: string;
  docCode: string;
  docName: string;
  applicationId: string;
  ref: string | null;
  studentId: string;
  studentName: string | null;
  studentNo: string | null;
  submittedAt: string | null;
  currentExpiry: string | null;
  claimedBy: string | null;
  claimedUntil: string | null;
  /** Current version ids ordered by page (serve via /api/files/[id]). */
  versionIds: string[];
}

/** Staff: documents awaiting review, oldest submission first. */
export async function listReviewQueue(
  actor: Actor,
  opts: { applicationId?: string; docCode?: string; limit?: number; offset?: number } = {},
): Promise<{ items: ReviewQueueItem[]; total: number }> {
  assertStaff(actor);
  const db = getDb();
  const conds = [
    eq(applicationDocuments.state, 'uploaded'),
    eq(applicationDocuments.required, true),
    inArray(applications.status, [...REVIEWABLE_STATUSES]),
  ];
  if (opts.applicationId) conds.push(eq(applications.id, opts.applicationId));
  if (opts.docCode) conds.push(eq(applicationDocuments.docCode, opts.docCode));
  const where = and(...conds);
  const rows = await db
    .select({
      documentId: applicationDocuments.id,
      docCode: applicationDocuments.docCode,
      docName: ruleDocuments.name,
      docSort: ruleDocuments.sort,
      applicationId: applications.id,
      ref: applications.ref,
      studentId: applications.studentId,
      studentName: profiles.fullName,
      studentNo: students.studentNo,
      submittedAt: applications.submittedAt,
      currentExpiry: applications.currentExpiry,
      claimedBy: applications.claimedBy,
      claimedUntil: applications.claimedUntil,
    })
    .from(applicationDocuments)
    .innerJoin(applications, eq(applications.id, applicationDocuments.applicationId))
    .innerJoin(profiles, eq(profiles.id, applications.studentId))
    .leftJoin(students, eq(students.profileId, applications.studentId))
    .leftJoin(ruleDocuments, and(eq(ruleDocuments.ruleSetId, applications.ruleSetId), eq(ruleDocuments.code, applicationDocuments.docCode)))
    .where(where)
    .orderBy(asc(sql`coalesce(${applications.submittedAt}, ${applications.createdAt})`), asc(applications.id), asc(ruleDocuments.sort))
    .limit(Math.min(opts.limit ?? 100, 500))
    .offset(opts.offset ?? 0);
  const totalRow = await db
    .select({ n: sql<number>`count(*)` })
    .from(applicationDocuments)
    .innerJoin(applications, eq(applications.id, applicationDocuments.applicationId))
    .where(where);
  const docIds = rows.map((r) => r.documentId);
  const versions = docIds.length
    ? await db
        .select({ id: documentVersions.id, docId: documentVersions.applicationDocumentId, page: documentVersions.page })
        .from(documentVersions)
        .where(and(inArray(documentVersions.applicationDocumentId, docIds), isNull(documentVersions.supersededAt), isNull(documentVersions.deletedAt)))
        .orderBy(asc(documentVersions.page))
    : [];
  return {
    items: rows.map(({ docSort: _s, ...r }) => ({
      ...r,
      docName: r.docName ?? r.docCode,
      versionIds: versions.filter((v) => v.docId === r.documentId).map((v) => v.id),
    })),
    total: Number(totalRow[0]?.n ?? 0),
  };
}

// ---------------------------------------------------------------- file access

export type FileVariant = 'original' | 'thumb';

export interface AuthorizedFile {
  storageKey: string;
  contentType: string;
  filename: string;
}

/**
 * Authorize reading a document version's bytes (owner or staff). Staff/liaison
 * views are audit-logged (`file.viewed`). Returns the storage key for the caller to
 * fetch + decrypt; never send the key to the client.
 */
export async function authorizeVersionFile(actor: Actor, versionId: string, variant: FileVariant = 'original'): Promise<AuthorizedFile> {
  const db = getDb();
  // One round trip: version + its application (for authz) + doc code.
  const row = (
    await db
      .select({ v: documentVersions, app: applications, docCode: applicationDocuments.docCode })
      .from(documentVersions)
      .innerJoin(applications, eq(applications.id, documentVersions.applicationId))
      .innerJoin(applicationDocuments, eq(applicationDocuments.id, documentVersions.applicationDocumentId))
      .where(eq(documentVersions.id, versionId))
      .limit(1)
  )[0];
  if (!row || row.v.deletedAt) throw new NotFoundError('File');
  const { v, app } = row;
  if (!canReadFile(actor, app, 'document')) throw new NotFoundError('File');
  assertCanReadApplication(actor, app);
  const doc = { docCode: row.docCode };
  const key = variant === 'thumb' ? (v.thumbKey ?? v.storageKey) : v.storageKey;
  if (fileViewIsAudited(actor)) {
    await withTx(async (tx) => {
      await audit(tx, actor, 'file.viewed', { type: 'document_version', id: v.id }, { applicationId: app.id, docCode: doc.docCode, variant });
    });
  }
  return { storageKey: key, contentType: v.contentType, filename: `${doc.docCode}_${v.page}${variant === 'thumb' ? '_thumb' : ''}.jpg` };
}

/** Authorize a packet ZIP download (staff). Audited (`packet.downloaded`, FR-PKT-3). */
export async function authorizePacketFile(actor: Actor, packetId: string): Promise<AuthorizedFile> {
  const db = getDb();
  const p = (await db.select().from(packets).where(eq(packets.id, packetId)))[0];
  if (!p || p.status !== 'ready' || !p.storageKey) throw new NotFoundError('Packet');
  const app = await loadApplication(db, p.applicationId);
  if (!app || !canReadFile(actor, app, 'packet')) throw new NotFoundError('Packet');
  await withTx(async (tx) => {
    await audit(tx, actor, 'packet.downloaded', { type: 'packet', id: p.id }, { applicationId: app.id });
  });
  return { storageKey: p.storageKey, contentType: 'application/zip', filename: `${app.ref ?? app.id}_packet.zip` };
}

/** Authorize a payment receipt image (staff). Audited. */
export async function authorizeReceiptFile(actor: Actor, paymentId: string): Promise<AuthorizedFile> {
  const db = getDb();
  const p = (await db.select().from(payments).where(eq(payments.id, paymentId)))[0];
  if (!p || !p.receiptKey) throw new NotFoundError('Receipt');
  const app = await loadApplication(db, p.applicationId);
  if (!app || !canReadFile(actor, app, 'receipt')) throw new NotFoundError('Receipt');
  await withTx(async (tx) => {
    await audit(tx, actor, 'file.viewed', { type: 'payment_receipt', id: p.id }, { applicationId: app.id });
  });
  return { storageKey: p.receiptKey, contentType: 'image/jpeg', filename: `receipt_${p.id}.jpg` };
}

/** All versions (history) of one document, for staff or the owner. */
export async function listDocumentVersions(actor: Actor, documentId: string): Promise<DocumentVersion[]> {
  const db = getDb();
  const doc = (await db.select().from(applicationDocuments).where(eq(applicationDocuments.id, documentId)))[0];
  if (!doc) throw new NotFoundError('Document');
  const app = await loadApplication(db, doc.applicationId);
  assertCanReadApplication(actor, app);
  const rows = await db.select().from(documentVersions).where(and(eq(documentVersions.applicationDocumentId, doc.id), isNull(documentVersions.deletedAt))).orderBy(desc(documentVersions.seq));
  return actor.role === 'student' ? rows.map((r) => ({ ...r, storageKey: '', thumbKey: null })) : rows;
}
