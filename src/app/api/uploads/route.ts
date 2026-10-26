import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireActorOrThrow } from '@/server/auth/current';
import { enforceRateLimit, RATE_LIMITS } from '@/server/auth/rate-limit';
import { getDb } from '@/server/db/client';
import { ConflictError, InvalidStateError, ValidationError } from '@/server/errors';
import { assertSameOrigin, route } from '@/server/http';
import {
  findActiveVersionByHash,
  prepareDocumentUpload,
  registerDocumentVersion,
} from '@/server/services';
import { getBlobStore } from '@/server/storage';
import type { Actor } from '@/server/authz';
import { docProfile, MAX_REQUEST_BYTES } from '@/lib/scan/constants';
import type { UploadResponse } from '@/lib/scan/upload-types';
import { processScan } from './process';

/**
 * POST /api/uploads (CONTRACTS §8, FR-UP-3/5/6).
 * multipart/form-data: applicationId, docCode, slot (or page; 1-based), file (JPEG ≤ 3 MB),
 * quality (optional JSON from the Scan Coach). The same fields may also be sent in the
 * query string so authz/state fail fast before the body is read.
 *
 * Idempotent: re-sending the same bytes for the same slot returns the existing
 * version instead of creating a new one (safe for client retries, FR-UP-4).
 */
export const runtime = 'nodejs';

const metaSchema = z.object({
  applicationId: z.string().min(1).max(64),
  docCode: z.string().regex(/^[a-z0-9_]{1,64}$/),
  page: z.coerce.number().int().min(1).max(20),
});

const qualitySchema = z
  .object({
    blur: z.number().finite().optional(),
    glare: z.number().finite().optional(),
    brightness: z.number().finite().optional(),
    warnings: z.array(z.string().max(40)).max(12).optional(),
    usedAnyway: z.boolean().optional(),
    source: z.enum(['camera', 'file', 'pdf', 'live']).optional(),
    jpegQuality: z.number().min(0).max(1).optional(),
  })
  .strip();

function readMeta(url: URL, form?: FormData) {
  const pick = (k: string) => url.searchParams.get(k) ?? (form?.get(k) as string | null) ?? undefined;
  const parsed = metaSchema.safeParse({
    applicationId: pick('applicationId'),
    docCode: pick('docCode'),
    page: pick('slot') ?? pick('page') ?? '1',
  });
  if (!parsed.success) throw new ValidationError('Missing or invalid upload details.', { form: 'Invalid upload details' });
  return parsed.data;
}

function parseQuality(raw: FormDataEntryValue | null) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const r = qualitySchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** Same bytes already active for this slot? (retry after a dropped response) */
function findActiveDuplicate(actor: Actor, applicationId: string, docCode: string, page: number, sha256: string) {
  return findActiveVersionByHash(actor, { applicationId, docCode, page, sha256 });
}

export const POST = route(async (req) => {
  assertSameOrigin(req);
  const actor = await requireActorOrThrow(['student']);
  await enforceRateLimit(getDb(), `upload:${actor.id}`, RATE_LIMITS.uploadPerUser.limit, RATE_LIMITS.uploadPerUser.windowMs);

  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_REQUEST_BYTES) throw new ValidationError('The image is larger than 3 MB.', { file: 'Too large' });

  const url = new URL(req.url);
  // Fail fast on authz/state when the client sends the meta in the query string.
  let prepError: unknown = null;
  let prep: Awaited<ReturnType<typeof prepareDocumentUpload>> | null = null;
  const early = url.searchParams.get('applicationId') ? readMeta(url) : null;
  if (early) {
    try {
      prep = await prepareDocumentUpload(actor, { applicationId: early.applicationId, docCode: early.docCode, page: early.page });
    } catch (e) {
      // A retry of an upload that already succeeded can hit InvalidState (the doc is no
      // longer "rejected"). Keep the error and decide after hashing the bytes.
      if (!(e instanceof InvalidStateError)) throw e;
      prepError = e;
    }
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new ValidationError('The upload could not be read. Please try again.', { file: 'Unreadable' });
  }
  const meta = early ?? readMeta(url, form);
  const file = form.get('file');
  if (!file || typeof file === 'string') throw new ValidationError('Choose an image to upload.', { file: 'Missing file' });
  if (!prep && !prepError) {
    try {
      prep = await prepareDocumentUpload(actor, { applicationId: meta.applicationId, docCode: meta.docCode, page: meta.page });
    } catch (e) {
      if (!(e instanceof InvalidStateError)) throw e;
      prepError = e;
    }
  }

  const scan = await processScan(new Uint8Array(await file.arrayBuffer()), { minLongEdge: docProfile(meta.docCode).minLongEdge });

  // Idempotency: same hash already active for this slot → return it, store nothing.
  if (prepError || prep) {
    const dup = await findActiveDuplicate(actor, meta.applicationId, meta.docCode, meta.page, scan.sha256);
    if (dup) {
      const body: UploadResponse = {
        version: { id: dup.version.id, page: dup.version.page },
        document: { id: dup.doc.id, docCode: dup.doc.docCode, state: dup.doc.state },
        duplicateOf: [],
        warnings: [],
        idempotent: true,
      };
      return NextResponse.json(body);
    }
  }
  if (prepError || !prep) throw prepError;

  const store = getBlobStore();
  const put = await store.put(prep.storageKey, scan.jpeg, 'image/jpeg');
  let thumbKey: string | null = null;
  try {
    thumbKey = (await store.put(prep.thumbKey, scan.thumb, 'image/jpeg')).key;
    const quality = parseQuality(form.get('quality'));
    const result = await registerDocumentVersion(actor, {
      applicationId: meta.applicationId,
      docCode: meta.docCode,
      page: meta.page,
      seq: prep.seq,
      storageKey: put.key,
      thumbKey,
      sha256: scan.sha256,
      width: scan.width,
      height: scan.height,
      bytes: scan.bytes,
      quality: quality ? { ...quality, serverReencoded: scan.reencoded } : { serverReencoded: scan.reencoded },
    });
    const warnings: UploadResponse['warnings'] = [];
    if (result.duplicateOf.length) warnings.push({ code: 'duplicate', docCodes: result.duplicateOf });
    if (scan.reencoded) warnings.push({ code: 'reencoded' });
    const body: UploadResponse = {
      version: { id: result.version.id, page: result.version.page },
      document: { id: result.document.id, docCode: result.document.docCode, state: result.document.state },
      duplicateOf: result.duplicateOf,
      warnings,
      idempotent: false,
    };
    return NextResponse.json(body, { status: 201 });
  } catch (e) {
    // Don't leave orphaned blobs behind (Conflict = seq race: client retries).
    await Promise.allSettled([store.delete(put.key), thumbKey ? store.delete(thumbKey) : Promise.resolve()]);
    if (e instanceof ConflictError) throw new ConflictError(e.message, { retry: true });
    throw e;
  }
});
