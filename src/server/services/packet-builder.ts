import 'server-only';
/**
 * Immigration packet builder (FR-PKT-1/2/3, PRD story 5).
 *
 *   const packet = await buildPacket(actor, applicationId);
 *
 * Fetches and decrypts the current version of every approved, required document,
 * names them `{NN}_{doc_code}_{Surname}_{StudentNo}.jpg`, renders `cover_sheet.pdf`
 * (pdf-lib, standard fonts, no network), writes `manifest.json` (names, SHA-256,
 * sizes, timestamps), zips everything with fflate IN MEMORY, stores the ZIP through
 * the encrypted BlobStore and records it with startPacket/completePacket.
 * Nothing touches the filesystem (Vercel). Packets are capped at MAX_PACKET_BYTES.
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { zipSync, type Zippable } from 'fflate';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { APP_NAME, UNIVERSITY_NAME } from '@/config/app';
import { applyBy, formatDate, formatDateTime } from '@/domain';
import { fmt, staffText } from '@/i18n/staff';
import { assertStaff, type Actor } from '../authz';
import { getDb } from '../db/client';
import { profiles, ruleSets, type PacketManifest, type PacketManifestEntry } from '../db/schema';
import { InvalidStateError, ValidationError } from '../errors';
import { getBlobStore, blobKeys } from '../storage';
import { getApplicationDetail, type ApplicationDetail } from './applications';
import { completePacket, failPacket, startPacket, type PacketView } from './packets';

/** In-memory build limit (sum of document bytes). Keeps the function well inside Vercel memory/time. */
export const MAX_PACKET_BYTES = 25 * 1024 * 1024;
export const COVER_SHEET_NAME = 'cover_sheet.pdf';
export const MANIFEST_NAME = 'manifest.json';
const PACKET_STATUSES = ['approved', 'sent_to_immigration'] as const;

// ---------------------------------------------------------------- naming (pure)

/** ASCII-only file-name segment: diacritics folded, separators → '-', everything else dropped. */
export function sanitizeSegment(value: string | null | undefined, fallback: string): string {
  const out = String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\s/\\.]+/g, '-')
    .replace(/[^A-Za-z0-9-]+/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return out || fallback;
}

/** Surname = last word of the full name (e.g. "Amina N. Okello" → "Okello"). */
export function surnameOf(fullName: string | null | undefined): string {
  const parts = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  return sanitizeSegment(parts[parts.length - 1], 'Student');
}

/** `{NN}_{doc_code}_{Surname}_{StudentNo}.jpg` (FR-PKT-1), sanitised. */
export function packetFileName(nn: number, docCode: string, fullName: string | null | undefined, studentNo: string | null | undefined): string {
  const code = docCode.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'document';
  return `${String(nn).padStart(2, '0')}_${code}_${surnameOf(fullName)}_${sanitizeSegment(studentNo, 'NOID')}.jpg`;
}

// ---------------------------------------------------------------- plan

export interface PacketPlanFile {
  nn: number;
  name: string;
  docCode: string;
  docName: string;
  page: number;
  pages: number;
  versionId: string;
  sha256: string;
  bytes: number;
  uploadedAt: string;
  reviewedAt: string | null;
}

interface InternalPlanFile extends PacketPlanFile {
  storageKey: string;
}

/** Export order = checklist order (rule-set sort), pages in order. Approved required docs only. */
function planFromDetail(detail: ApplicationDetail): InternalPlanFile[] {
  const out: InternalPlanFile[] = [];
  let nn = 1;
  for (const entry of detail.checklist.items) {
    const doc = detail.documents.find((d) => d.docCode === entry.item.code);
    if (!doc || !doc.required || doc.state !== 'approved') continue;
    const current = doc.versions
      .filter((v) => !v.supersededAt && !v.deletedAt)
      .sort((a, b) => a.page - b.page || b.seq - a.seq)
      .filter((v, i, arr) => arr.findIndex((x) => x.page === v.page) === i);
    for (const v of current) {
      out.push({
        nn,
        name: packetFileName(nn, doc.docCode, detail.student.fullName, detail.student.studentNo),
        docCode: doc.docCode,
        docName: entry.item.name,
        page: v.page,
        pages: current.length,
        versionId: v.id,
        sha256: v.sha256,
        bytes: v.bytes,
        uploadedAt: v.uploadedAt,
        reviewedAt: doc.reviewedAt,
        storageKey: v.storageKey,
      });
      nn++;
    }
  }
  return out;
}

export interface PacketPlan {
  applicationId: string;
  ref: string | null;
  status: ApplicationDetail['application']['status'];
  canGenerate: boolean;
  files: PacketPlanFile[];
  totalBytes: number;
}

/** Staff: preview of the export (names/order) without fetching any bytes. */
export async function getPacketPlan(actor: Actor, applicationId: string, detail?: ApplicationDetail): Promise<PacketPlan> {
  assertStaff(actor);
  const d = detail ?? (await getApplicationDetail(actor, applicationId));
  const files = planFromDetail(d).map(({ storageKey: _k, ...f }) => f);
  return {
    applicationId: d.application.id,
    ref: d.application.ref,
    status: d.application.status,
    canGenerate: (PACKET_STATUSES as readonly string[]).includes(d.application.status) && files.length > 0,
    files,
    totalBytes: files.reduce((s, f) => s + f.bytes, 0),
  };
}

// ---------------------------------------------------------------- build

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface PacketManifestFile extends PacketManifestEntry {
  docName?: string;
  page?: number;
  uploadedAt?: string;
  reviewedAt?: string | null;
}

export interface BuiltPacketManifest extends PacketManifest {
  applicationId: string;
  generatedBy: string;
  files: PacketManifestFile[];
}

/**
 * Staff: build, store and record the immigration packet for an approved (or
 * already sent) application. Audited via startPacket/completePacket
 * (`packet.started`, `packet.generated`); failures are recorded with failPacket.
 */
export async function buildPacket(actor: Actor, applicationId: string, now: Date = new Date()): Promise<PacketView> {
  assertStaff(actor);
  const detail = await getApplicationDetail(actor, applicationId);
  const app = detail.application;
  if (!(PACKET_STATUSES as readonly string[]).includes(app.status)) {
    throw new InvalidStateError('Packets can only be generated for approved applications.', { status: app.status });
  }
  const plan = planFromDetail(detail);
  if (plan.length === 0) throw new InvalidStateError('There are no approved documents to export.');
  const total = plan.reduce((s, f) => s + f.bytes, 0);
  if (total > MAX_PACKET_BYTES) {
    throw new ValidationError('This packet is too large to build in one go.', { packet: 'Too large' }, { bytes: total, max: MAX_PACKET_BYTES });
  }

  const db = getDb();
  const [approver, ruleSet] = await Promise.all([
    app.approvedBy ? db.select({ fullName: profiles.fullName, email: profiles.email }).from(profiles).where(eq(profiles.id, app.approvedBy)).then((r) => r[0]) : undefined,
    db.select({ applyBeforeDays: ruleSets.applyBeforeDays }).from(ruleSets).where(eq(ruleSets.id, app.ruleSetId)).then((r) => r[0]),
  ]);

  const packet = await startPacket(actor, app.id);
  let storedKey: string | null = null;
  try {
    const store = getBlobStore();
    const generatedAt = now.toISOString();
    const files: { name: string; bytes: Uint8Array; entry: PacketManifestFile }[] = [];
    for (const f of plan) {
      const bytes = await store.get(f.storageKey);
      if (!bytes) throw new Error(`Missing file for ${f.docCode} page ${f.page}`);
      const sha = sha256Hex(bytes);
      if (sha !== f.sha256) throw new Error(`Integrity check failed for ${f.docCode} page ${f.page}`);
      files.push({
        name: f.name,
        bytes,
        entry: { name: f.name, sha256: sha, bytes: bytes.byteLength, docCode: f.docCode, versionId: f.versionId, docName: f.docName, page: f.page, uploadedAt: f.uploadedAt, reviewedAt: f.reviewedAt },
      });
    }

    const cover = await renderCoverSheet({
      detail,
      files: files.map((f) => f.entry),
      approverName: approver?.fullName ?? approver?.email ?? null,
      generatorName: actor.fullName ?? actor.email,
      applyBy: !app.noPass && app.currentExpiry && ruleSet ? applyBy(app.currentExpiry, ruleSet.applyBeforeDays) : null,
      generatedAt,
    });
    const coverEntry: PacketManifestFile = { name: COVER_SHEET_NAME, sha256: sha256Hex(cover), bytes: cover.byteLength };

    const manifest: BuiltPacketManifest = {
      generatedAt,
      applicationRef: app.ref,
      applicationId: app.id,
      generatedBy: actor.id,
      packetId: packet.id,
      approvedAt: app.approvedAt,
      algorithm: 'SHA-256',
      files: [...files.map((f) => f.entry), coverEntry],
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));

    const mtime = now;
    const zippable: Zippable = {};
    for (const f of files) zippable[f.name] = [f.bytes, { level: 0, mtime }];
    zippable[COVER_SHEET_NAME] = [cover, { level: 6, mtime }];
    zippable[MANIFEST_NAME] = [manifestBytes, { level: 6, mtime }];
    const zip = zipSync(zippable);

    const { key } = await store.put(blobKeys.packet(app.id, packet.id), zip, 'application/zip');
    storedKey = key;
    return await completePacket(actor, packet.id, { storageKey: key, sha256: sha256Hex(zip), bytes: zip.byteLength, manifest });
  } catch (e) {
    if (storedKey) await getBlobStore().delete(storedKey).catch(() => undefined);
    await failPacket(actor, packet.id, e instanceof Error ? e.message : String(e)).catch(() => undefined);
    throw e;
  }
}

// ---------------------------------------------------------------- cover sheet (pdf-lib)

/** Standard PDF fonts are WinAnsi (Latin-1): replace anything else. */
export function pdfSafe(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
}

interface CoverInput {
  detail: ApplicationDetail;
  files: PacketManifestFile[];
  approverName: string | null;
  generatorName: string;
  applyBy: string | null;
  generatedAt: string;
}

export async function renderCoverSheet(input: CoverInput): Promise<Uint8Array> {
  const c = staffText.cover;
  const { application: app, student, payments } = input.detail;
  const pdf = await PDFDocument.create();
  pdf.setTitle(pdfSafe(`${c.title} ${app.ref ?? ''}`.trim()));
  pdf.setAuthor(pdfSafe(`${UNIVERSITY_NAME} - ${c.office}`));
  pdf.setProducer(pdfSafe(APP_NAME));
  pdf.setCreationDate(new Date(input.generatedAt));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  const A4: [number, number] = [595.28, 841.89];
  const margin = 48;
  const ink = rgb(0.08, 0.09, 0.12);
  const muted = rgb(0.29, 0.33, 0.39);
  const navy = rgb(0.04, 0.15, 0.27);

  let page: PDFPage = pdf.addPage(A4);
  let y = A4[1] - margin;
  const newPage = () => {
    page = pdf.addPage(A4);
    y = A4[1] - margin;
  };
  const ensure = (h: number) => {
    if (y - h < margin + 24) newPage();
  };
  const text = (s: string, x: number, size: number, f: PDFFont = font, color = ink) => page.drawText(pdfSafe(s), { x, y, size, font: f, color });
  const fit = (s: string, f: PDFFont, size: number, width: number) => {
    const full = pdfSafe(s);
    if (f.widthOfTextAtSize(full, size) <= width) return full;
    let out = full;
    while (out.length > 1 && f.widthOfTextAtSize(`${out}...`, size) > width) out = out.slice(0, -1);
    return `${out}...`;
  };

  // Header
  text(UNIVERSITY_NAME, margin, 10, bold, navy);
  y -= 13;
  text(c.office, margin, 10, font, muted);
  y -= 26;
  text(c.title, margin, 17, bold, ink);
  y -= 20;
  text(`${c.ref}: ${app.ref ?? '-'}`, margin, 11, mono, ink);
  y -= 22;

  const section = (title: string, rows: [string, string][]) => {
    ensure(22 + rows.length * 15);
    page.drawLine({ start: { x: margin, y: y + 4 }, end: { x: A4[0] - margin, y: y + 4 }, thickness: 0.5, color: rgb(0.89, 0.88, 0.85) });
    y -= 12;
    text(title, margin, 11, bold, navy);
    y -= 16;
    for (const [k, v] of rows) {
      ensure(15);
      text(k, margin, 9.5, font, muted);
      page.drawText(fit(v || '-', font, 9.5, A4[0] - margin * 2 - 150), { x: margin + 150, y, size: 9.5, font, color: ink });
      y -= 14;
    }
    y -= 6;
  };

  const months = app.requestedMonths ? fmt(staffText.detail.months, { n: app.requestedMonths }) : '-';
  const payment = [...payments].sort((a, b) => b.paidOn.localeCompare(a.paidOn))[0];
  section(c.student, [
    [c.name, student.fullName ?? student.email],
    [c.studentNo, student.studentNo ?? '-'],
    [c.nationality, student.nationality ?? '-'],
    [c.type, student.studentType ? staffText.dashboard.types[student.studentType] : '-'],
    [c.programme, student.programme ?? '-'],
    [c.email, student.email],
    [c.phone, student.phone ?? '-'],
  ]);
  section(c.visa, [
    [c.currentExpiry, app.noPass ? c.noPass : formatDate(app.currentExpiry)],
    [c.applyBy, input.applyBy ? formatDate(input.applyBy) : '-'],
    [c.requested, months],
    [c.submitted, app.submittedAt ? formatDateTime(app.submittedAt) : '-'],
  ]);
  section(c.fee, [
    [c.feeStatus, staffText.dashboard.fees[app.feeStatus]],
    [
      c.payment,
      payment
        ? fmt(c.paymentLine, { amount: payment.amountUgx.toLocaleString('en-US'), date: formatDate(payment.paidOn), ref: payment.reference ? ` (${payment.reference})` : '' })
        : '-',
    ],
  ]);
  section(c.review, [
    [c.approvedBy, input.approverName ?? '-'],
    [c.approvedOn, app.approvedAt ? formatDateTime(app.approvedAt) : '-'],
    [c.generatedBy, input.generatorName],
    [c.generatedOn, formatDateTime(input.generatedAt)],
  ]);

  // Manifest table
  ensure(40);
  page.drawLine({ start: { x: margin, y: y + 4 }, end: { x: A4[0] - margin, y: y + 4 }, thickness: 0.5, color: rgb(0.89, 0.88, 0.85) });
  y -= 12;
  text(c.manifest, margin, 11, bold, navy);
  y -= 16;
  const cols = { no: margin, file: margin + 26, hash: margin + 26 };
  const header = () => {
    text(c.colNo, cols.no, 8.5, bold, muted);
    text(`${c.colFile} / ${c.colDoc}`, cols.file, 8.5, bold, muted);
    y -= 12;
  };
  header();
  input.files.forEach((f, i) => {
    if (y - 34 < margin + 24) {
      newPage();
      header();
    }
    text(String(i + 1).padStart(2, '0'), cols.no, 9, mono, ink);
    page.drawText(fit(f.name, mono, 8.5, A4[0] - margin - cols.file), { x: cols.file, y, size: 8.5, font: mono, color: ink });
    y -= 11;
    const label = f.docName ? `${f.docName}${f.page && f.page > 1 ? ` (${fmt(staffText.detail.pageN, { n: f.page })})` : ''}` : (f.docCode ?? '');
    page.drawText(fit(label, font, 8.5, A4[0] - margin - cols.file), { x: cols.file, y, size: 8.5, font, color: muted });
    y -= 11;
    page.drawText(`${c.colHash}: ${f.sha256}`, { x: cols.hash, y, size: 6.8, font: mono, color: muted });
    y -= 14;
  });

  // Footer on every page
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    p.drawText(pdfSafe(fmt(c.footer, { app: APP_NAME })), { x: margin, y: margin - 18, size: 7.5, font, color: muted });
    const label = pdfSafe(fmt(c.page, { n: i + 1, total: pages.length }));
    p.drawText(label, { x: A4[0] - margin - font.widthOfTextAtSize(label, 7.5), y: margin - 18, size: 7.5, font, color: muted });
  });
  return pdf.save({ useObjectStreams: false });
}
