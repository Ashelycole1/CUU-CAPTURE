/** FR-PKT-1/2/3, PRD story 5: naming, ZIP contents, manifest hashes = file bytes, cover sheet parses. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { unzipSync, strFromU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { createStaff, createTestDb, type TestDb } from '../helpers/db';
import { createSubmittedApplication } from '../helpers/factories';
import { auditLog, packets } from '@/server/db/schema';
import { getBlobStore } from '@/server/storage';
import { ForbiddenError, InvalidStateError } from '@/server/errors';
import { getApplicationDetail, listPackets, markSentToImmigration } from '@/server/services';
import {
  buildPacket,
  getPacketPlan,
  packetFileName,
  pdfSafe,
  sanitizeSegment,
  surnameOf,
  type BuiltPacketManifest,
} from '@/server/services/packet-builder';
import type { Actor } from '@/server/authz';
import { createApprovedWithFiles, sha } from './helpers';

let t: TestDb;
let staff: Actor;

beforeAll(async () => {
  t = await createTestDb();
  staff = await createStaff(t.db);
});
afterAll(() => t.cleanup());

describe('file naming', () => {
  it('builds {NN}_{doc_code}_{Surname}_{StudentNo}.jpg and sanitises', () => {
    expect(packetFileName(1, 'passport_data_page', 'Amina Okello', 'CUU-2024-0042')).toBe('01_passport_data_page_Okello_CUU-2024-0042.jpg');
    expect(packetFileName(12, 'admission_letter', "Zoë O'Brien-Nakato", 'CUU/2024/7')).toBe('12_admission_letter_OBrien-Nakato_CUU-2024-7.jpg');
    expect(surnameOf('  José   Müller ')).toBe('Muller');
    expect(surnameOf(null)).toBe('Student');
    expect(sanitizeSegment('../../etc/passwd', 'X')).toBe('etc-passwd');
    expect(sanitizeSegment('李', 'NOID')).toBe('NOID');
    expect(packetFileName(3, 'Weird Code!', 'A B', null)).toBe('03_weird_code_B_NOID.jpg');
  });
  it('pdfSafe keeps Latin-1 and replaces the rest', () => {
    expect(pdfSafe('Zoë – “ok” 李')).toBe('Zoë - "ok" ?');
  });
});

describe('buildPacket', () => {
  it('story 5: ZIP with correctly named JPGs, cover sheet and a manifest whose hashes match', async () => {
    const { app, uploaded } = await createApprovedWithFiles(t.db, staff, {
      nationality: 'KE',
      studentType: 'continuing',
      fullName: 'Zoë Amani Ochieng',
      studentNo: 'CUU/2024/0042',
    });
    expect(app.status).toBe('approved');

    const plan = await getPacketPlan(staff, app.id);
    expect(plan.canGenerate).toBe(true);

    const packet = await buildPacket(staff, app.id);
    expect(packet.status).toBe('ready');
    expect(packet).not.toHaveProperty('storageKey');

    const row = (await t.db.select().from(packets).where(eq(packets.id, packet.id)))[0]!;
    const zipBytes = (await getBlobStore().get(row.storageKey!))!;
    expect(sha(zipBytes)).toBe(row.sha256);
    expect(zipBytes.byteLength).toBe(row.bytes);

    const files = unzipSync(zipBytes);
    const names = Object.keys(files);
    const jpgs = names.filter((n) => n.endsWith('.jpg')).sort();
    // continuing student: 8 docs, admission letter has 2 pages → 9 JPGs
    expect(jpgs).toHaveLength(9);
    expect(names).toContain('cover_sheet.pdf');
    expect(names).toContain('manifest.json');
    for (const n of jpgs) expect(n).toMatch(/^\d{2}_[a-z_]+_Ochieng_CUU-2024-0042\.jpg$/);
    expect(jpgs.some((n) => n.endsWith('_passport_data_page_Ochieng_CUU-2024-0042.jpg'))).toBe(true);
    // NN is a contiguous 01..09 sequence in plan order
    expect(jpgs.map((n) => n.slice(0, 2))).toEqual(['01', '02', '03', '04', '05', '06', '07', '08', '09']);
    expect(plan.files.map((f) => f.name)).toEqual(jpgs);

    // Stored bytes are exactly the uploaded bytes
    const passportName = jpgs.find((n) => n.includes('passport_data_page'))!;
    expect(Buffer.from(files[passportName]!).equals(Buffer.from(uploaded.passport_data_page![0]!))).toBe(true);

    const manifest = JSON.parse(strFromU8(files['manifest.json']!)) as BuiltPacketManifest;
    expect(manifest.applicationRef).toBe(app.ref);
    expect(manifest.files.map((f) => f.name).sort()).toEqual([...jpgs, 'cover_sheet.pdf'].sort());
    for (const f of manifest.files) {
      expect(sha(files[f.name]!)).toBe(f.sha256);
      expect(files[f.name]!.byteLength).toBe(f.bytes);
    }
    expect(manifest.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // DB copy of the manifest matches the one in the ZIP
    expect(row.manifest!.files.map((f) => f.sha256)).toEqual(manifest.files.map((f) => f.sha256));

    const pdf = await PDFDocument.load(files['cover_sheet.pdf']!);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(pdf.getTitle()).toContain(app.ref!);

    const audits = await t.db.select().from(auditLog).where(eq(auditLog.targetId, packet.id));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['packet.started', 'packet.generated']));

    // Still allowed once sent (regenerate); the newest packet is listed first
    await markSentToImmigration(staff, app.id, { method: 'email' });
    const again = await buildPacket(staff, app.id);
    expect((await listPackets(staff, app.id))[0]!.id).toBe(again.id);
  });

  it('rejects a non-approved application', async () => {
    const { app } = await createSubmittedApplication(t.db, {});
    await expect(buildPacket(staff, app.id)).rejects.toBeInstanceOf(InvalidStateError);
    const plan = await getPacketPlan(staff, app.id);
    expect(plan.canGenerate).toBe(false);
    expect(await listPackets(staff, app.id)).toHaveLength(0);
  });

  it('forbids students (even the owner)', async () => {
    const { app, student } = await createApprovedWithFiles(t.db, staff, {});
    await expect(buildPacket(student, app.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getPacketPlan(student, app.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('fails the packet (and records it) when a stored file was tampered with', async () => {
    const { app, docs } = await createApprovedWithFiles(t.db, staff, {});
    const detail = await getApplicationDetail(staff, app.id);
    const doc = detail.documents.find((d) => d.docCode === docs[0]!.docCode)!;
    const v = doc.versions.find((x) => !x.supersededAt)!;
    await getBlobStore().put(v.storageKey, new Uint8Array([1, 2, 3]), 'image/jpeg');
    await expect(buildPacket(staff, app.id)).rejects.toThrow(/Integrity/);
    const rows = await t.db.select().from(packets).where(eq(packets.applicationId, app.id));
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.storageKey).toBeNull();
  });
});
