/**
 * PRD §6 stories 1 and 2 at the service/route level, plus receipt (FR-SUB-3),
 * messages (FR-NOT-2) and the student reason labels. Session lookup and Next's
 * request-scoped helpers are mocked; everything else is real.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { createStaff, createStudent, createTestDb, outboxFor, type TestDb } from '../helpers/db';
import { createDraft, docsOf, uploadDoc } from '../helpers/factories';
import { documentVersions } from '@/server/db/schema';
import { getBlobStore } from '@/server/storage';
import {
  claimApplication,
  getChecklistForApplication,
  getOrCreateDraft,
  getSubmitBlockers,
  listMessages,
  postMessage,
  reviewDocument,
  updateApplicationFields,
  updateStudentProfile,
} from '@/server/services';
import { getReasonLabelsForApplication } from '@/server/services/student-view';
import { addDays, todayInKampala } from '@/domain/dates';
import { compressToLimit, evaluateQuality, analyzeRgba, type QualityMetrics } from '@/lib/scan/quality';
import { docProfile } from '@/lib/scan/constants';
import { submitIssues } from '@/components/student/logic';
import type { Actor } from '@/server/authz';
import { UnauthenticatedError } from '@/server/errors';

let currentActor: Actor | null = null;
const afterQueue: (() => unknown)[] = [];
vi.mock('@/server/auth/current', () => ({
  requireActorOrThrow: vi.fn(async () => {
    if (!currentActor) throw new UnauthenticatedError();
    return currentActor;
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: () => unknown) => afterQueue.push(fn) }));

const { POST } = await import('@/app/api/uploads/route');
const actions = await import('@/app/(student)/actions');

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.cleanup());

async function runAfter() {
  while (afterQueue.length) await afterQueue.shift()!();
}

function upload(applicationId: string, docCode: string, file: Buffer, slot = 1) {
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(file)], { type: 'image/jpeg' }), 'scan.jpg');
  const qs = new URLSearchParams({ applicationId, docCode, slot: String(slot) });
  return POST(new Request(`http://localhost:3000/api/uploads?${qs}`, { method: 'POST', body: form, headers: { origin: 'http://localhost:3000', host: 'localhost:3000' } }), undefined as never);
}

/** A "phone photo" of a document as raw RGB. */
function documentPixels(width: number, height: number) {
  const raw = Buffer.alloc(width * height * 3, 238);
  for (let y = 0; y < height; y++) {
    if (y % 22 > 10) continue;
    for (let x = 0; x < width; x++) if (((x >> 4) + (y >> 5)) % 6 !== 0) raw.fill(25, (y * width + x) * 3, (y * width + x) * 3 + 3);
  }
  return raw;
}

describe('PRD story 1: student submits', () => {
  it('continuing KE, 45 days: 8 items, fee waived, 15 days runway; then uploads all and submits with a receipt', async () => {
    const student = await createUser();
    currentActor = student;
    const app = await getOrCreateDraft(student);
    // The profile wizard's autosave actions.
    expect((await actions.saveProfileAction({ fullName: 'Amina Wanjiru', studentNo: 'cuu-2026-0001', programme: 'BSc Nursing' })).ok).toBe(true);
    expect((await actions.saveProfileAction({ studentType: 'continuing' })).ok).toBe(true);
    expect((await actions.saveProfileAction({ nationality: 'KE' })).ok).toBe(true);
    expect((await actions.saveApplicationFieldsAction(app.id, { currentExpiry: addDays(todayInKampala(), 45), noPass: false })).ok).toBe(true);
    expect((await actions.saveApplicationFieldsAction(app.id, { requestedMonths: 12 })).ok).toBe(true);

    const c = await getChecklistForApplication(student, app.id);
    expect(c.items).toHaveLength(8);
    expect(c.feeRequired).toBe(false);
    expect(c.runway.daysToApplyBy).toBe(15);

    // Submit is blocked and the review page says why.
    const blocked = await actions.submitApplicationAction(app.id, true);
    expect(blocked.ok).toBe(false);
    const blockers = await getSubmitBlockers(student, app.id);
    expect(submitIssues(blockers, c.items, true)).toHaveLength(8);
    // Unconfirmed submit is refused even when everything else is ready.
    for (const e of c.items) await uploadDoc(student, app.id, e.item.code, { pages: e.item.minFiles });
    const unconfirmed = await actions.submitApplicationAction(app.id, false);
    expect(unconfirmed.ok).toBe(false);

    const res = await actions.submitApplicationAction(app.id, true);
    expect(res.ok).toBe(true);
    const ref = res.ok ? res.data.ref : null;
    expect(ref).toMatch(/^VD-\d{4}-\d{5}$/);
    await runAfter(); // after(() => flushNotifications())
    const mails = await outboxFor(t.db, student.email);
    expect(mails.some((m) => m.subject.includes(ref!))).toBe(true);
  });

  it('profile autosave rejects invalid values and duplicate student numbers', async () => {
    const a = await createStudent(t.db, { studentNo: 'DUP-123' });
    const b = await createUser();
    currentActor = b;
    await getOrCreateDraft(b);
    const r = await actions.saveProfileAction({ studentNo: 'dup-123' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.fieldErrors?.studentNo).toMatch(/already registered/);
    const bad = await actions.saveProfileAction({ nationality: 'Kenya' });
    expect(bad.ok).toBe(false);
    void a;
  });
});

async function createUser(): Promise<Actor> {
  const { createUser: cu } = await import('../helpers/db');
  return cu(t.db, { role: 'student' });
}

describe('PRD story 2: format-proof upload', () => {
  it('a non-JPEG phone image is converted to JPEG, quality-checked, uploaded, and stored as a valid JPEG', async () => {
    const { student, app } = await createDraft(t.db, { nationality: 'NG', studentType: 'new' });
    currentActor = student;
    // Input: a PNG (stands in for HEIC, which sharp's prebuilt binaries cannot encode as a fixture).
    const png = await sharp(documentPixels(2400, 1800), { raw: { width: 2400, height: 1800, channels: 3 } }).png().toBuffer();
    const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    // Client pipeline, with sharp standing in for canvas: compress ladder, then the worker's checks.
    const encoded = await compressToLimit(async (q) => {
      const b = await sharp(png).jpeg({ quality: Math.round(q * 100) }).toBuffer();
      return { bytes: b, size: b.byteLength };
    });
    expect(encoded.overLimit).toBe(false);
    const metrics: QualityMetrics = { ...analyzeRgba(decoded.data, decoded.info.width, decoded.info.height), width: 2400, height: 1800, bytes: encoded.size };
    expect(evaluateQuality(metrics, docProfile('passport_data_page'))).toEqual([]);

    const res = await upload(app.id, 'passport_data_page', encoded.bytes);
    expect(res.status).toBe(201);
    const body = await res.json();
    const v = (await t.db.select().from(documentVersions).where(eq(documentVersions.id, body.version.id)))[0]!;
    const stored = (await getBlobStore().get(v.storageKey))!;
    expect((await sharp(stored).metadata()).format).toBe('jpeg');
    expect(stored[0]).toBe(0xff);
    expect(stored[1]).toBe(0xd8);

    // The raw PNG itself is refused by the server (stored files are always real JPEGs).
    expect((await upload(app.id, 'student_id_face', png)).status).toBe(422);
  });
});

describe('PRD story 3 (student side): rejection reason and messages', () => {
  it('shows the DOS reason, keeps internal notes hidden, and emails the reply', async () => {
    const { student, app } = await createDraft(t.db);
    const docs = await docsOf(t.db, app.id);
    for (const d of docs.filter((x) => x.required)) await uploadDoc(student, app.id, d.docCode, { pages: d.minFiles });
    currentActor = student;
    expect((await actions.submitApplicationAction(app.id, true)).ok).toBe(true);
    const staff = await createStaff(t.db);
    await claimApplication(staff, app.id);
    for (const d of (await docsOf(t.db, app.id)).filter((x) => x.required)) {
      await reviewDocument(staff, d.docCode === 'passport_data_page' ? { documentId: d.id, decision: 'reject', reasonCode: 'glare' } : { documentId: d.id, decision: 'approve' });
    }
    const labels = await getReasonLabelsForApplication(student, app.id, ['glare']);
    expect(labels.glare!.label).toBe('Glare hides details');
    // Another student cannot read them.
    const other = await createStudent(t.db);
    await expect(getReasonLabelsForApplication(other, app.id, ['glare'])).rejects.toThrow(/not found/i);

    await postMessage(staff, app.id, { body: 'Internal: check passport again', internal: true });
    await postMessage(staff, app.id, { body: 'Please retake the passport page.' });
    const r = await actions.postMessageAction(app.id, 'Will do, thank you.');
    expect(r.ok).toBe(true);
    await runAfter();
    const thread = await listMessages(student, app.id);
    expect(thread.map((m) => m.body)).toEqual(['Please retake the passport page.', 'Will do, thank you.']);
    expect(thread.some((m) => m.internal)).toBe(false);
    expect((await outboxFor(t.db, staff.email)).length).toBeGreaterThan(0);
  });

  it('expired pass at first login: application allowed, penalty estimate computed', async () => {
    const { student, app } = await createDraft(t.db, { expiryInDays: -3 });
    const c = await getChecklistForApplication(student, app.id);
    expect(c.runway.band).toBe('expired');
    expect(c.runway.penaltyUsd).toBe(60);
    await updateStudentProfile(student, { programme: 'MBA' });
    await updateApplicationFields(student, app.id, { notes: 'late' });
  });
});
