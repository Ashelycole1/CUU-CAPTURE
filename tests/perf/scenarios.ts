/**
 * Hot-path scenarios for the performance tests. Each scenario reproduces the DATABASE
 * work of one real request (the same service calls, in the same order and with the same
 * Promise.all parallelism as the page / route / action), so counting round trips here
 * equals counting them in production.
 *
 * The test file must mock `@/server/auth/current` with `sessionAuthMock` (below) so the
 * real session lookup (`validateSession`) is part of every request, as in production.
 */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/server/db/client';
import { applicationDocuments, profiles } from '@/server/db/schema';
import { createSession, validateSession } from '@/server/auth/session';
import { getDb } from '@/server/db/client';
import type { Actor } from '@/server/authz';
import {
  authorizeVersionFile,
  claimApplication,
  getApplicationDetail,
  getChecklistForApplication,
  getDashboardSummary,
  getMyActiveApplication,
  getOrCreateDraft,
  getStudentProfile,
  getSubmitBlockers,
  listApplicationsForStaff,
  listReasonTemplates,
  listSavedViews,
  markApproved,
  prepareDocumentUpload,
  registerDocumentVersion,
  reviewDocument,
  submitApplication,
  updateApplicationFields,
} from '@/server/services';
import { getPacketPlan, buildPacket } from '@/server/services/packet-builder';
import { getBlobStore } from '@/server/storage';
import { addDays, todayInKampala } from '@/domain/dates';
import { createStaff, createStudent } from '../helpers/db';

// ---------------------------------------------------------------- auth mock

/** Token of the "current request" (set by `asUser`). */
export const authState: { token: string | null } = { token: null };

async function currentActor(): Promise<Actor | null> {
  const v = await validateSession(getDb(), authState.token);
  return v?.actor ?? null;
}

/** Factory for `vi.mock('@/server/auth/current', () => sessionAuthMock())`. */
export function sessionAuthMock() {
  return {
    getActor: currentActor,
    requireActor: async () => {
      const a = await currentActor();
      if (!a) throw new Error('not signed in');
      return a;
    },
    requireActorOrThrow: async (roles?: string[]) => {
      const { UnauthenticatedError, ForbiddenError } = await import('@/server/errors');
      const a = await currentActor();
      if (!a) throw new UnauthenticatedError();
      if (roles && !roles.includes(a.role)) throw new ForbiddenError();
      return a;
    },
    homePathFor: () => '/',
  };
}

// ---------------------------------------------------------------- images

/** A document-like JPEG (paper with text bars). ~0.5–1.5 MB at 2000×1500 depending on seed/quality. */
export async function documentJpeg(width = 2000, height = 1500, seed = 1, quality = 85): Promise<Buffer> {
  const ch = 3;
  const raw = Buffer.alloc(width * height * ch, 235);
  for (let y = 0; y < height; y++) {
    const line = Math.floor(y / 24);
    if (y % 24 > 12) continue;
    for (let x = 0; x < width; x++) {
      if (((x >> 4) + line + seed) % 5 === 0) continue;
      const i = (y * width + x) * ch;
      // Per-pixel noise makes the JPEG realistically large (phone photos are noisy).
      raw[i] = raw[i + 1] = raw[i + 2] = 20 + ((x * 31 + y * 17 + seed * 7) % 60);
    }
  }
  return sharp(raw, { raw: { width, height, channels: ch } }).jpeg({ quality }).toBuffer();
}

export function uploadRequest(fields: { applicationId: string; docCode: string; slot?: number }, file: Buffer): Request {
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(file)], { type: 'image/jpeg' }), 'scan.jpg');
  form.set('quality', JSON.stringify({ blur: 180, glare: 0.01, warnings: [] }));
  const qs = new URLSearchParams({ applicationId: fields.applicationId, docCode: fields.docCode, slot: String(fields.slot ?? 1) });
  return new Request(`http://localhost:3000/api/uploads?${qs}`, {
    method: 'POST',
    body: form,
    headers: { origin: 'http://localhost:3000', host: 'localhost:3000' },
  });
}

// ---------------------------------------------------------------- fixture

export interface Fixture {
  student: Actor;
  studentToken: string;
  draftAppId: string;
  /** A draft whose first doc is free for uploads. */
  uploadDocCode: string;
  staff: Actor;
  staffToken: string;
  /** Submitted application with real blobs, claimed by `staff`. */
  reviewAppId: string;
  reviewDocIds: string[];
  /** A version id with a real encrypted original + thumbnail (review app). */
  versionId: string;
  /** A version id owned by `student`. */
  studentVersionId: string;
  /** Approved application ready for a packet. */
  approvedAppId: string;
}

/** Store a real (small) encrypted JPEG + thumbnail and register it as a version. */
async function uploadReal(actor: Actor, applicationId: string, docCode: string, page: number, jpeg: Buffer, thumb: Buffer) {
  const prep = await prepareDocumentUpload(actor, { applicationId, docCode, page });
  const store = getBlobStore();
  const put = await store.put(prep.storageKey, jpeg, 'image/jpeg');
  const tput = await store.put(prep.thumbKey, thumb, 'image/jpeg');
  return registerDocumentVersion(actor, {
    applicationId,
    docCode,
    page,
    seq: prep.seq,
    storageKey: put.key,
    thumbKey: tput.key,
    sha256: createHash('sha256').update(jpeg).digest('hex'),
    width: 2000,
    height: 1500,
    bytes: jpeg.byteLength,
    quality: { blur: 200, warnings: [] },
  });
}

async function draftWithFields(db: Db, n: number) {
  const student = await createStudent(db, { nationality: 'NG', studentType: 'new', fullName: `Perf Student ${n}` });
  const app = await getOrCreateDraft(student);
  await updateApplicationFields(student, app.id, { noPass: false, currentExpiry: addDays(todayInKampala(), 40), requestedMonths: 12 });
  return { student, app };
}

async function uploadAll(db: Db, student: Actor, appId: string, jpeg: Buffer, thumb: Buffer) {
  const docs = await db
    .select()
    .from(applicationDocuments)
    .where(and(eq(applicationDocuments.applicationId, appId), eq(applicationDocuments.required, true)));
  for (const d of docs) for (let p = 1; p <= d.minFiles; p++) await uploadReal(student, appId, d.docCode, p, jpeg, thumb);
}

export async function buildFixture(db: Db): Promise<Fixture> {
  const jpeg = await documentJpeg(1600, 1200, 3, 70);
  const thumb = await sharp(jpeg).resize({ width: 400 }).jpeg({ quality: 75 }).toBuffer();

  const staff = await createStaff(db);
  const staffProfile = (await db.select().from(profiles).where(eq(profiles.id, staff.id)))[0]!;
  const { token: staffToken } = await createSession(db, staffProfile);

  // Student with a draft (for /apply, /documents, uploads).
  const { student, app: draft } = await draftWithFields(db, 1);
  const studentProfile = (await db.select().from(profiles).where(eq(profiles.id, student.id)))[0]!;
  const { token: studentToken } = await createSession(db, studentProfile);
  const docs = await db.select().from(applicationDocuments).where(eq(applicationDocuments.applicationId, draft.id));
  // Upload most docs so the checklist has realistic content; keep one single-page doc free.
  const free = docs.find((d) => d.minFiles === 1)!;
  for (const d of docs) if (d.id !== free.id) for (let p = 1; p <= d.minFiles; p++) await uploadReal(student, draft.id, d.docCode, p, jpeg, thumb);

  const studentVersionId = (await db.select().from(applicationDocuments).where(eq(applicationDocuments.id, docs.find((d) => d.id !== free.id)!.id)))[0]!.currentVersionId!;

  // Submitted application under review (claimed by staff).
  const r = await draftWithFields(db, 2);
  await uploadAll(db, r.student, r.app.id, jpeg, thumb);
  await submitApplication(r.student, r.app.id);
  await claimApplication(staff, r.app.id);
  const reviewDocs = await db.select().from(applicationDocuments).where(eq(applicationDocuments.applicationId, r.app.id));
  const versionId = reviewDocs[0]!.currentVersionId!;

  // Approved application (packet).
  const a = await draftWithFields(db, 3);
  await uploadAll(db, a.student, a.app.id, jpeg, thumb);
  await submitApplication(a.student, a.app.id);
  await claimApplication(staff, a.app.id);
  for (const d of await db.select().from(applicationDocuments).where(eq(applicationDocuments.applicationId, a.app.id))) {
    if (d.required) await reviewDocument(staff, { documentId: d.id, decision: 'approve' });
  }
  await markApproved(staff, a.app.id);

  return {
    student,
    studentToken,
    draftAppId: draft.id,
    uploadDocCode: free.docCode,
    staff,
    staffToken,
    reviewAppId: r.app.id,
    reviewDocIds: reviewDocs.filter((d) => d.required).map((d) => d.id),
    versionId,
    studentVersionId,
    approvedAppId: a.app.id,
  };
}

// ---------------------------------------------------------------- scenarios

type Scenario = (fx: Fixture) => Promise<unknown>;

/** Session lookup only (every authenticated request pays this). */
async function auth(token: string): Promise<Actor> {
  authState.token = token;
  const a = await currentActor();
  if (!a) throw new Error('session invalid');
  return a;
}

/** Staff application page: page.tsx of (staff)/applications/[id]. */
async function staffApplicationPage(actor: Actor, id: string) {
  const detail = await getApplicationDetail(actor, id);
  await Promise.all([listReasonTemplates(actor, { includeInactive: true }), getPacketPlan(actor, id, detail)]);
}

export const SCENARIOS: Record<string, Scenario> = {
  'session lookup (every request)': async (fx) => auth(fx.studentToken),

  'student /apply (checklist home)': async (fx) => {
    const actor = await auth(fx.studentToken);
    const app = await getOrCreateDraft(actor);
    return getChecklistForApplication(actor, app.id);
  },

  'student /documents/[type]': async (fx) => {
    const actor = await auth(fx.studentToken);
    const app = (await getMyActiveApplication(actor))!;
    return getChecklistForApplication(actor, app.id);
  },

  'student /review': async (fx) => {
    const actor = await auth(fx.studentToken);
    const app = (await getMyActiveApplication(actor))!;
    return Promise.all([getChecklistForApplication(actor, app.id), getSubmitBlockers(actor, app.id), getStudentProfile(actor)]);
  },

  'student /status (detail)': async (fx) => {
    const actor = await auth(fx.studentToken);
    const app = (await getMyActiveApplication(actor))!;
    return getApplicationDetail(actor, app.id);
  },

  'staff /dashboard (first page)': async (fx) => {
    const actor = await auth(fx.staffToken);
    const today = todayInKampala();
    return Promise.all([getDashboardSummary(actor, today), listSavedViews(actor), listApplicationsForStaff(actor, { limit: 50, today })]);
  },

  'staff /dashboard (filtered + search)': async (fx) => {
    const actor = await auth(fx.staffToken);
    const today = todayInKampala();
    return Promise.all([
      getDashboardSummary(actor, today),
      listSavedViews(actor),
      listApplicationsForStaff(actor, { filters: { status: ['submitted', 'under_review'], q: 'perf' }, limit: 50, today }),
    ]);
  },

  'staff /applications/[id]': async (fx) => {
    const actor = await auth(fx.staffToken);
    return staffApplicationPage(actor, fx.reviewAppId);
  },

  'staff file view (thumb, audited)': async (fx) => {
    const actor = await auth(fx.staffToken);
    const f = await authorizeVersionFile(actor, fx.versionId, 'thumb');
    return getBlobStore().get(f.storageKey);
  },

  'student file view (original)': async (fx) => {
    const actor = await auth(fx.studentToken);
    const f = await authorizeVersionFile(actor, fx.studentVersionId, 'original');
    return getBlobStore().get(f.storageKey);
  },
};

/** Review decision server action: reviewDocument + revalidated re-render of the page. */
export async function reviewDecision(fx: Fixture, docId: string, decision: 'approve' | 'reject' = 'approve') {
  const actor = await auth(fx.staffToken);
  await reviewDocument(actor, decision === 'approve' ? { documentId: docId, decision } : { documentId: docId, decision, reasonCode: 'blurry' });
}

export async function reviewDecisionRerender(fx: Fixture) {
  const actor = await auth(fx.staffToken);
  return staffApplicationPage(actor, fx.reviewAppId);
}

export async function packet(fx: Fixture) {
  const actor = await auth(fx.staffToken);
  return buildPacket(actor, fx.approvedAppId);
}
