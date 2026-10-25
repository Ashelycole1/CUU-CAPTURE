/**
 * Application factories built on the real services (so tests exercise the same paths).
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/server/db/client';
import { applicationDocuments } from '@/server/db/schema';
import type { Actor } from '@/server/authz';
import {
  getOrCreateDraft,
  prepareDocumentUpload,
  registerDocumentVersion,
  submitApplication,
  updateApplicationFields,
  type Application,
} from '@/server/services';
import { addDays, todayInKampala } from '@/domain/dates';
import type { StudentType } from '@/domain/types';
import { createStudent, fakeSha } from './db';

let shaSeed = 0;

/** Upload every page of one document through prepare + register (no real bytes). */
export async function uploadDoc(actor: Actor, applicationId: string, docCode: string, opts: { sha?: string; pages?: number } = {}) {
  let last;
  const pages = opts.pages ?? 1;
  for (let page = 1; page <= pages; page++) {
    const prep = await prepareDocumentUpload(actor, { applicationId, docCode, page });
    last = await registerDocumentVersion(actor, {
      applicationId,
      docCode,
      page,
      seq: prep.seq,
      storageKey: prep.storageKey,
      thumbKey: prep.thumbKey,
      sha256: opts.sha ?? fakeSha(`f${shaSeed++}`),
      width: 2000,
      height: 1500,
      bytes: 500_000,
      quality: { blur: 200, warnings: [] },
    });
  }
  return last!;
}

/** Upload all required documents (respecting min_files) for an application. */
export async function uploadAllRequired(db: Db, actor: Actor, applicationId: string) {
  const docs = await db
    .select()
    .from(applicationDocuments)
    .where(and(eq(applicationDocuments.applicationId, applicationId), eq(applicationDocuments.required, true)));
  for (const d of docs) {
    if (d.state === 'missing' || d.state === 'rejected') await uploadDoc(actor, applicationId, d.docCode, { pages: d.minFiles });
  }
}

export interface DraftOpts {
  nationality?: string;
  studentType?: StudentType;
  /** Days from today (Kampala) to pass expiry; null = no pass. Default 45. */
  expiryInDays?: number | null;
}

export async function createDraft(db: Db, opts: DraftOpts = {}): Promise<{ student: Actor; app: Application }> {
  const student = await createStudent(db, { nationality: opts.nationality, studentType: opts.studentType });
  let app = await getOrCreateDraft(student);
  const exp = opts.expiryInDays === undefined ? 45 : opts.expiryInDays;
  app = await updateApplicationFields(student, app.id, {
    noPass: exp === null,
    currentExpiry: exp === null ? null : addDays(todayInKampala(), exp),
    requestedMonths: 12,
  });
  return { student, app };
}

export async function createSubmittedApplication(db: Db, opts: DraftOpts = {}): Promise<{ student: Actor; app: Application }> {
  const { student, app } = await createDraft(db, opts);
  await uploadAllRequired(db, student, app.id);
  const submitted = await submitApplication(student, app.id);
  return { student, app: submitted };
}

export async function docsOf(db: Db, applicationId: string) {
  return db.select().from(applicationDocuments).where(eq(applicationDocuments.applicationId, applicationId));
}
