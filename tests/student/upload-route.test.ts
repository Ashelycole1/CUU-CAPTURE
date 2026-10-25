/**
 * POST /api/uploads (FR-UP-3/5/6, CONTRACTS §8) end to end through the real
 * services, DB, and encrypted blob store. Only the session lookup is mocked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { createStaff, createTestDb, type TestDb } from '../helpers/db';
import { createDraft, createSubmittedApplication, docsOf } from '../helpers/factories';
import { documentVersions } from '@/server/db/schema';
import { getBlobStore } from '@/server/storage';
import { claimApplication, reviewDocument } from '@/server/services';
import type { Actor } from '@/server/authz';
import { UnauthenticatedError } from '@/server/errors';

let currentActor: Actor | null = null;
vi.mock('@/server/auth/current', () => ({
  requireActorOrThrow: vi.fn(async (roles?: string[]) => {
    if (!currentActor) throw new UnauthenticatedError();
    if (roles && !roles.includes(currentActor.role)) {
      const { ForbiddenError } = await import('@/server/errors');
      throw new ForbiddenError();
    }
    return currentActor;
  }),
}));

const { POST } = await import('@/app/api/uploads/route');

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.cleanup());
beforeEach(() => {
  currentActor = null;
});

/** A document-like test image: paper background with dark "text" bars. */
async function makeImage(width: number, height: number, opts: { seed?: number } = {}) {
  const seed = opts.seed ?? 1;
  const ch = 3;
  const raw = Buffer.alloc(width * height * ch, 235);
  for (let y = 0; y < height; y++) {
    const line = Math.floor(y / 24);
    if (y % 24 > 12) continue;
    for (let x = 0; x < width; x++) {
      if (((x >> 4) + line + seed) % 5 === 0) continue;
      const i = (y * width + x) * ch;
      raw[i] = raw[i + 1] = raw[i + 2] = 30 + ((x * seed) % 20);
    }
  }
  return sharp(raw, { raw: { width, height, channels: ch } });
}

async function jpeg(width = 2000, height = 1500, seed = 1) {
  return (await makeImage(width, height, { seed })).jpeg({ quality: 85 }).toBuffer();
}

function uploadRequest(fields: { applicationId: string; docCode: string; slot?: number }, file: Buffer, opts: { query?: boolean; origin?: string } = {}) {
  const form = new FormData();
  form.set('applicationId', fields.applicationId);
  form.set('docCode', fields.docCode);
  form.set('slot', String(fields.slot ?? 1));
  form.set('file', new Blob([new Uint8Array(file)], { type: 'image/jpeg' }), 'scan.jpg');
  form.set('quality', JSON.stringify({ blur: 180, glare: 0.01, warnings: [], usedAnyway: false, junk: 'x'.repeat(10) }));
  const qs = opts.query ? `?${new URLSearchParams({ applicationId: fields.applicationId, docCode: fields.docCode, slot: String(fields.slot ?? 1) })}` : '';
  return new Request(`http://localhost:3000/api/uploads${qs}`, {
    method: 'POST',
    body: form,
    headers: { origin: opts.origin ?? 'http://localhost:3000', host: 'localhost:3000' },
  });
}

async function call(req: Request) {
  const res = await POST(req, undefined as never);
  return { status: res.status, body: await res.json() };
}

describe('POST /api/uploads', () => {
  it('stores an encrypted JPEG + thumbnail and registers a version', async () => {
    const { student, app } = await createDraft(t.db, { nationality: 'KE', studentType: 'continuing' });
    currentActor = student;
    const { status, body } = await call(uploadRequest({ applicationId: app.id, docCode: 'fees_statement' }, await jpeg()));
    expect(status).toBe(201);
    expect(body.document.state).toBe('uploaded');
    expect(body.idempotent).toBe(false);

    const v = (await t.db.select().from(documentVersions).where(eq(documentVersions.id, body.version.id)))[0]!;
    expect(v.width).toBe(2000);
    expect(v.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(v.quality).toMatchObject({ blur: 180, usedAnyway: false });
    expect((v.quality as Record<string, unknown>).junk).toBeUndefined();

    // Stored encrypted on disk (no JPEG magic in the raw file) …
    const blobDir = path.join(t.dir, 'blobs');
    const files = fs.readdirSync(blobDir, { recursive: true }).map(String).filter((f) => f.endsWith('.jpg'));
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const f of files) {
      const raw = fs.readFileSync(path.join(blobDir, f));
      expect(raw.subarray(0, 4).toString('latin1')).toBe('VDE1');
    }
    // … and decrypts to a valid JPEG; the thumbnail is 400 px on the long side.
    const original = (await getBlobStore().get(v.storageKey))!;
    expect((await sharp(original).metadata()).format).toBe('jpeg');
    const thumb = (await getBlobStore().get(v.thumbKey!))!;
    const tm = await sharp(thumb).metadata();
    expect(Math.max(tm.width!, tm.height!)).toBe(400);
  });

  it('strips EXIF and applies orientation (FR-UP-3)', async () => {
    const { student, app } = await createDraft(t.db);
    currentActor = student;
    // 2000×1500 stored pixels with orientation 6 (rotate 90° CW) + GPS-ish EXIF.
    const withExif = await (await makeImage(2000, 1500, { seed: 3 }))
      .jpeg({ quality: 85 })
      .withMetadata({ orientation: 6 })
      .withExif({ IFD0: { Copyright: 'secret-location', Artist: 'Student Phone' } })
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeTruthy();

    const { status, body } = await call(uploadRequest({ applicationId: app.id, docCode: 'passport_data_page' }, withExif, { query: true }));
    expect(status).toBe(201);
    expect(body.warnings).toContainEqual({ code: 'reencoded' });
    const v = (await t.db.select().from(documentVersions).where(eq(documentVersions.id, body.version.id)))[0]!;
    const stored = (await getBlobStore().get(v.storageKey))!;
    const m = await sharp(stored).metadata();
    expect(m.exif).toBeUndefined();
    expect(m.orientation === undefined || m.orientation === 1).toBe(true);
    expect([m.width, m.height]).toEqual([1500, 2000]); // rotated upright
    expect([v.width, v.height]).toEqual([1500, 2000]);
    expect(Buffer.from(stored).includes(Buffer.from('secret-location'))).toBe(false);
  });

  it('rejects files whose magic bytes are not JPEG (e.g. a PNG renamed .jpg)', async () => {
    const { student, app } = await createDraft(t.db);
    currentActor = student;
    const png = await (await makeImage(2000, 1500)).png().toBuffer();
    const { status, body } = await call(uploadRequest({ applicationId: app.id, docCode: 'fees_statement' }, png));
    expect(status).toBe(422);
    expect(body.error.code).toBe('VALIDATION');
    expect(body.error.message).toMatch(/Only JPG/);
  });

  it('rejects a truncated JPEG', async () => {
    const { student, app } = await createDraft(t.db);
    currentActor = student;
    const full = await jpeg();
    const { status } = await call(uploadRequest({ applicationId: app.id, docCode: 'fees_statement' }, full.subarray(0, Math.floor(full.length / 2))));
    expect(status).toBe(422);
  });

  it('rejects oversize files (> 3 MB)', async () => {
    const { student, app } = await createDraft(t.db);
    currentActor = student;
    const big = Buffer.concat([await jpeg(), Buffer.alloc(3 * 1024 * 1024)]);
    const { status, body } = await call(uploadRequest({ applicationId: app.id, docCode: 'fees_statement' }, big));
    expect(status).toBe(422);
    expect(body.error.message).toMatch(/3 MB/);
  });

  it('rejects images that are too small (1600 px default, 1200 px for passport/ID)', async () => {
    const { student, app } = await createDraft(t.db);
    currentActor = student;
    const small = await jpeg(1400, 1000);
    const a = await call(uploadRequest({ applicationId: app.id, docCode: 'fees_statement' }, small));
    expect(a.status).toBe(422);
    expect(a.body.error.message).toMatch(/1600 px/);
    // The same 1400 px image is fine for the passport data page (1200 px minimum).
    const b = await call(uploadRequest({ applicationId: app.id, docCode: 'passport_data_page' }, small));
    expect(b.status).toBe(201);
  });

  it("returns 404 for another student's application and stores nothing", async () => {
    const { app } = await createDraft(t.db);
    const { student: other } = await createDraft(t.db);
    currentActor = other;
    const before = (await t.db.select().from(documentVersions)).length;
    const { status, body } = await call(uploadRequest({ applicationId: app.id, docCode: 'fees_statement' }, await jpeg(), { query: true }));
    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect((await t.db.select().from(documentVersions)).length).toBe(before);
  });

  it('requires a signed-in student and same-origin requests', async () => {
    const { student, app } = await createDraft(t.db);
    expect((await call(uploadRequest({ applicationId: app.id, docCode: 'fees_statement' }, await jpeg()))).status).toBe(401);
    currentActor = await createStaff(t.db);
    expect((await call(uploadRequest({ applicationId: app.id, docCode: 'fees_statement' }, await jpeg()))).status).toBe(403);
    currentActor = student;
    const cross = await call(uploadRequest({ applicationId: app.id, docCode: 'fees_statement' }, await jpeg(), { origin: 'https://evil.example' }));
    expect(cross.status).toBe(403);
  });

  it('refuses uploads to an approved document (409)', async () => {
    const { student, app } = await createSubmittedApplication(t.db);
    const staff = await createStaff(t.db);
    await claimApplication(staff, app.id);
    const doc = (await docsOf(t.db, app.id)).find((d) => d.docCode === 'fees_statement')!;
    await reviewDocument(staff, { documentId: doc.id, decision: 'approve' });
    currentActor = student;
    const { status, body } = await call(uploadRequest({ applicationId: app.id, docCode: 'fees_statement' }, await jpeg(), { query: true }));
    expect(status).toBe(409);
    expect(body.error.code).toBe('INVALID_STATE');
  });

  it('is idempotent: the same bytes for the same slot do not create a second version', async () => {
    const { student, app } = await createDraft(t.db);
    currentActor = student;
    const bytes = await jpeg(2000, 1500, 7);
    const first = await call(uploadRequest({ applicationId: app.id, docCode: 'admission_letter', slot: 1 }, bytes));
    expect(first.status).toBe(201);
    expect(first.body.document.state).toBe('missing'); // page 2 still needed (FR-CHK-5)
    const again = await call(uploadRequest({ applicationId: app.id, docCode: 'admission_letter', slot: 1 }, bytes));
    expect(again.status).toBe(200);
    expect(again.body.idempotent).toBe(true);
    expect(again.body.version.id).toBe(first.body.version.id);
    const doc = (await docsOf(t.db, app.id)).find((d) => d.docCode === 'admission_letter')!;
    const versions = await t.db.select().from(documentVersions).where(eq(documentVersions.applicationDocumentId, doc.id));
    expect(versions).toHaveLength(1);

    // Page 2 completes the document.
    const p2 = await call(uploadRequest({ applicationId: app.id, docCode: 'admission_letter', slot: 2 }, await jpeg(2000, 1500, 8)));
    expect(p2.body.document.state).toBe('uploaded');
    // A different file for slot 1 is a new version (FR-UP-5) and supersedes the old one.
    const replace = await call(uploadRequest({ applicationId: app.id, docCode: 'admission_letter', slot: 1 }, await jpeg(2000, 1500, 9)));
    expect(replace.status).toBe(201);
    const all = await t.db.select().from(documentVersions).where(eq(documentVersions.applicationDocumentId, doc.id));
    expect(all).toHaveLength(3);
    expect(all.filter((v) => !v.supersededAt)).toHaveLength(2);
  });

  it('a retry after a successful corrections upload is still idempotent', async () => {
    const { student, app } = await createSubmittedApplication(t.db);
    const staff = await createStaff(t.db);
    await claimApplication(staff, app.id);
    const docs = await docsOf(t.db, app.id);
    for (const d of docs.filter((x) => x.required)) {
      await reviewDocument(staff, d.docCode === 'passport_data_page' ? { documentId: d.id, decision: 'reject', reasonCode: 'glare' } : { documentId: d.id, decision: 'approve' });
    }
    currentActor = student;
    const bytes = await jpeg(2000, 1500, 11);
    const first = await call(uploadRequest({ applicationId: app.id, docCode: 'passport_data_page' }, bytes, { query: true }));
    expect(first.status).toBe(201);
    // The doc is now `uploaded` and the app back under review; a network retry must not fail.
    const retry = await call(uploadRequest({ applicationId: app.id, docCode: 'passport_data_page' }, bytes, { query: true }));
    expect(retry.status).toBe(200);
    expect(retry.body.idempotent).toBe(true);
    // But a different file is refused (only rejected docs can change after submit).
    const other = await call(uploadRequest({ applicationId: app.id, docCode: 'passport_data_page' }, await jpeg(2000, 1500, 12), { query: true }));
    expect(other.status).toBe(409);
  });

  it('warns when the same file is uploaded for two document types (FR-UP-6)', async () => {
    const { student, app } = await createDraft(t.db);
    currentActor = student;
    const bytes = await jpeg(2000, 1500, 21);
    await call(uploadRequest({ applicationId: app.id, docCode: 'fees_statement' }, bytes));
    const { status, body } = await call(uploadRequest({ applicationId: app.id, docCode: 'proof_of_registration' }, bytes));
    expect(status).toBe(201);
    expect(body.duplicateOf).toEqual(['fees_statement']);
    expect(body.warnings).toContainEqual({ code: 'duplicate', docCodes: ['fees_statement'] });
  });

  it('rejects an out-of-range slot', async () => {
    const { student, app } = await createDraft(t.db);
    currentActor = student;
    const { status } = await call(uploadRequest({ applicationId: app.id, docCode: 'fees_statement', slot: 2 }, await jpeg()));
    expect(status).toBe(422);
  });
});
