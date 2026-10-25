/**
 * Staff-test helpers: real (fake-JPEG) bytes in the encrypted store so packets can
 * be built and hashed, an approved-application factory, and an auth mock for
 * route handlers / server actions.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { vi } from 'vitest';
import type { Db } from '@/server/db/client';
import { applicationDocuments, profiles, students } from '@/server/db/schema';
import { getBlobStore } from '@/server/storage';
import { ForbiddenError, UnauthenticatedError } from '@/server/errors';
import type { Actor } from '@/server/authz';
import type { Role } from '@/domain/types';
import {
  claimApplication,
  markApproved,
  prepareDocumentUpload,
  registerDocumentVersion,
  reviewDocument,
  submitApplication,
} from '@/server/services';
import { createDraft, type DraftOpts } from '../helpers/factories';

export function fakeJpeg(size = 4096): Uint8Array {
  const body = randomBytes(size);
  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), body, Buffer.from([0xff, 0xd9])]));
}

export const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Upload one page with real bytes stored (encrypted) at the prepared key. */
export async function uploadReal(actor: Actor, applicationId: string, docCode: string, page = 1, bytes: Uint8Array = fakeJpeg()) {
  const prep = await prepareDocumentUpload(actor, { applicationId, docCode, page });
  const store = getBlobStore();
  const { key } = await store.put(prep.storageKey, bytes, 'image/jpeg');
  const { key: thumbKey } = await store.put(prep.thumbKey, bytes, 'image/jpeg');
  return registerDocumentVersion(actor, {
    applicationId,
    docCode,
    page,
    seq: prep.seq,
    storageKey: key,
    thumbKey,
    sha256: sha(bytes),
    width: 2000,
    height: 1500,
    bytes: bytes.byteLength,
  });
}

export interface ApprovedOpts extends DraftOpts {
  fullName?: string;
  studentNo?: string;
  /** Stop before markApproved (all docs approved, status under_review). */
  skipApprove?: boolean;
  /** Stop after submission. */
  submitOnly?: boolean;
}

/** Draft → real uploads → submitted → every doc approved → application approved. */
export async function createApprovedWithFiles(db: Db, staff: Actor, opts: ApprovedOpts = {}) {
  const { student, app } = await createDraft(db, opts);
  if (opts.fullName) await db.update(profiles).set({ fullName: opts.fullName }).where(eq(profiles.id, student.id));
  if (opts.studentNo) await db.update(students).set({ studentNo: opts.studentNo }).where(eq(students.profileId, student.id));
  const docs = await db
    .select()
    .from(applicationDocuments)
    .where(and(eq(applicationDocuments.applicationId, app.id), eq(applicationDocuments.required, true)));
  const uploaded: Record<string, Uint8Array[]> = {};
  for (const d of docs) {
    uploaded[d.docCode] = [];
    for (let p = 1; p <= d.minFiles; p++) {
      const bytes = fakeJpeg(2048 + p * 17);
      uploaded[d.docCode]!.push(bytes);
      await uploadReal(student, app.id, d.docCode, p, bytes);
    }
  }
  let current = await submitApplication(student, app.id);
  if (!opts.submitOnly) {
    await claimApplication(staff, app.id);
    for (const d of docs) await reviewDocument(staff, { documentId: d.id, decision: 'approve' });
    if (!opts.skipApprove) current = await markApproved(staff, app.id);
  }
  return { student, app: current, docs, uploaded };
}

// ---------------------------------------------------------------- auth mock

export const authState: { actor: Actor | null } = { actor: null };

export function setActor(a: Actor | null) {
  authState.actor = a;
}

/** Use with: vi.mock('@/server/auth/current', async () => (await import('./helpers')).authMock()); */
export function authMock() {
  const requireActorOrThrow = async (roles?: readonly Role[]) => {
    const a = authState.actor;
    if (!a) throw new UnauthenticatedError();
    if (roles && !roles.includes(a.role as Role)) throw new ForbiddenError();
    return a;
  };
  return {
    getActor: async () => authState.actor,
    requireActor: requireActorOrThrow,
    requireActorOrThrow,
    homePathFor: () => '/dashboard',
  };
}

/** Callbacks passed to next/server `after()`; tests drain them explicitly (no concurrent DB writers). */
export const afterQueue: (() => unknown)[] = [];

/** Replace next/server `after` (needs a request scope) with a queue. */
export async function nextServerMock(importOriginal: () => Promise<unknown>) {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, after: (fn: () => unknown) => void afterQueue.push(fn) };
}

export async function drainAfter() {
  while (afterQueue.length) await afterQueue.shift()!();
}

export const nextCacheMock = () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() });

export function req(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has('origin')) headers.set('origin', 'http://localhost:3000');
  headers.set('host', 'localhost:3000');
  return new Request(`http://localhost:3000${url}`, { ...init, headers });
}
