/**
 * Performance seed: a realistic, large local database + encrypted blobs for load tests.
 *
 *   DATA_DIR=./data-perf DATABASE_URL=file:./data-perf/visadesk.db \
 *     npx tsx --conditions=react-server scripts/perf/seed-perf.ts [--students 2000] [--apps 1500]
 *
 * Creates (by default) 2,000 students, 1,500 applications in a realistic mix of states,
 * their application_documents / document_versions (≈15 % with a superseded older version),
 * timeline events, notifications and a VALID audit hash chain, plus encrypted blobs on
 * LocalDiskStore (`${DATA_DIR}/blobs`, the same driver and envelope as production minus
 * the network). It also creates sessions directly in the DB and writes them, with useful
 * ids, to `${DATA_DIR}/perf-fixture.json` for scripts/perf/load.mjs.
 *
 * Refuses to run on anything but a local `file:` database whose path contains "perf".
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { filePathFromUrl, openDb, type Db } from '../../src/server/db/client';
import { runMigrations } from '../../src/server/db/migrate';
import { seedBase } from '../../src/server/db/seed';
import { config } from '../../src/server/config';
import {
  applicationDocuments,
  applicationEvents,
  applications,
  auditLog,
  documentVersions,
  notifications,
  profiles,
  ruleSets,
  students,
} from '../../src/server/db/schema';
import { canonicalJson, computeAuditHash, GENESIS_HASH } from '../../src/server/audit';
import { createSession } from '../../src/server/auth/session';
import { encryptBytes } from '../../src/server/storage/crypto';
import { keyringFromConfig } from '../../src/server/storage';
import { LocalDiskStore } from '../../src/server/storage/local';
import { blobKeys } from '../../src/server/storage/types';
import { loadRuleSet } from '../../src/server/services/internal';
import { computeChecklist } from '../../src/domain/rules';
import { addDays, todayInKampala } from '../../src/domain/dates';
import type { ApplicationStatus, DocumentState, StudentType } from '../../src/domain/types';

const arg = (name: string, def: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const N_STUDENTS = arg('students', 2000);
const N_APPS = arg('apps', 1500);
const N_UPLOADERS = arg('uploaders', 300);

// Deterministic PRNG so runs are comparable.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;

const NATIONALITIES = ['KE', 'TZ', 'RW', 'NG', 'SS', 'CD', 'BI', 'SO', 'ET', 'ZM', 'IN', 'CN'];
const TYPES: StudentType[] = ['new', 'continuing'];
/** Status mix for N_APPS applications (fractions sum to 1). */
const STATUS_MIX: [ApplicationStatus, number][] = [
  ['draft', 0.2],
  ['submitted', 0.16],
  ['under_review', 0.13],
  ['corrections_needed', 0.1],
  ['approved', 0.08],
  ['sent_to_immigration', 0.07],
  ['pass_issued', 0.05],
  ['closed', 0.17],
  ['withdrawn', 0.04],
];

function docStateFor(status: ApplicationStatus, i: number): DocumentState {
  switch (status) {
    case 'draft':
      return rnd() < 0.55 ? 'uploaded' : 'missing';
    case 'submitted':
      return 'uploaded';
    case 'under_review':
      return rnd() < 0.5 ? 'approved' : 'uploaded';
    case 'corrections_needed':
      return i === 0 || rnd() < 0.15 ? 'rejected' : 'approved';
    case 'withdrawn':
      return rnd() < 0.5 ? 'uploaded' : 'missing';
    default:
      return 'approved';
  }
}

async function chunked<T>(rows: T[], size: number, fn: (part: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
}

async function main() {
  const c = config();
  if (!c.databaseUrl.startsWith('file:') || !/perf/i.test(c.databaseUrl)) {
    throw new Error('seed-perf only runs on a local file: database whose path contains "perf" (e.g. file:./data-perf/visadesk.db)');
  }
  const file = filePathFromUrl(c.databaseUrl);
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  const blobRoot = path.resolve(c.dataDir, 'blobs');
  fs.rmSync(blobRoot, { recursive: true, force: true });

  const t0 = Date.now();
  const h = await openDb(c.databaseUrl);
  const db: Db = h.db;
  await runMigrations(db);
  await seedBase(db, { allowedDomains: c.allowedEmailDomains });
  const rsRow = (await db.select().from(ruleSets).where(eq(ruleSets.status, 'published')))[0]!;
  const ruleSet = await loadRuleSet(db, rsRow.id);
  const today = todayInKampala();
  const nowIso = new Date().toISOString();

  // Blob payloads: one realistic small scan + thumbnail, encrypted ONCE and written under
  // every key (each envelope is valid on its own; the key path is not part of the AAD).
  const keyring = keyringFromConfig();
  const raw = Buffer.alloc(800 * 600 * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = 200 + ((i * 7919) % 50);
  const scan = await sharp(raw, { raw: { width: 800, height: 600, channels: 3 } }).jpeg({ quality: 70 }).toBuffer();
  const thumb = await sharp(scan).resize({ width: 400 }).jpeg({ quality: 75 }).toBuffer();
  const encScan = encryptBytes(scan, keyring);
  const encThumb = encryptBytes(thumb, keyring);
  const disk = new LocalDiskStore(blobRoot);

  // ---------------- people
  const staffIds: string[] = [];
  const profileRows: (typeof profiles.$inferInsert)[] = [];
  for (let i = 0; i < 5; i++) {
    const id = crypto.randomUUID();
    staffIds.push(id);
    profileRows.push({ id, email: `perf.staff${i}@cavendish.ac.ug`, fullName: `Perf Staff ${i}`, role: i === 0 ? 'dos_admin' : 'dos_staff' });
  }
  const studentIds: string[] = [];
  const studentRows: (typeof students.$inferInsert)[] = [];
  const studentMeta = new Map<string, { type: StudentType; nationality: string }>();
  for (let i = 0; i < N_STUDENTS; i++) {
    const id = crypto.randomUUID();
    studentIds.push(id);
    const type = pick(TYPES);
    const nationality = pick(NATIONALITIES);
    studentMeta.set(id, { type, nationality });
    profileRows.push({ id, email: `perf.student${i}@cavendish.ac.ug`, fullName: `Perf Student ${i} Okello`, role: 'student' });
    const noPass = rnd() < 0.03;
    studentRows.push({
      profileId: id,
      studentNo: `CUU-P${String(i).padStart(5, '0')}`,
      nationality,
      studentType: type,
      programme: 'BSc Computer Science',
      phone: '+256700000000',
      passExpiry: noPass ? null : addDays(today, Math.floor(rnd() * 400) - 40),
      noPass,
    });
  }
  await chunked(profileRows, 400, (p) => db.insert(profiles).values(p));
  await chunked(studentRows, 400, (p) => db.insert(students).values(p));

  // ---------------- applications
  const appRows: (typeof applications.$inferInsert)[] = [];
  const docRows: (typeof applicationDocuments.$inferInsert)[] = [];
  const verRows: (typeof documentVersions.$inferInsert)[] = [];
  const eventRows: (typeof applicationEvents.$inferInsert)[] = [];
  const notifRows: (typeof notifications.$inferInsert)[] = [];
  const audits: { at: string; actorId: string | null; action: string; targetType: string; targetId: string; meta: string }[] = [];
  const blobWrites: string[][] = [];
  const statusList: ApplicationStatus[] = [];
  for (const [s, f] of STATUS_MIX) for (let k = 0; k < Math.round(f * N_APPS); k++) statusList.push(s);
  while (statusList.length < N_APPS) statusList.push('submitted');
  statusList.length = N_APPS;

  const fixture = {
    baseUrl: 'http://localhost:3100',
    cookieName: 'vd_session',
    student: { token: '', applicationId: '' },
    uploaders: [] as { token: string; applicationId: string; docCode: string }[],
    staff: [] as string[],
    staffVersionIds: [] as string[],
    approvedAppIds: [] as string[],
    reviewDocs: [] as { applicationId: string; documentId: string }[],
  };

  let refN = 0;
  for (let i = 0; i < N_APPS; i++) {
    const studentId = studentIds[i]!;
    const meta = studentMeta.get(studentId)!;
    const status = statusList[i]!;
    const id = crypto.randomUUID();
    const created = new Date(Date.now() - Math.floor(rnd() * 60) * 86_400_000).toISOString();
    const submitted = status === 'draft' ? null : new Date(Date.parse(created) + 86_400_000).toISOString();
    const expiry = addDays(today, Math.floor(rnd() * 200) - 20);
    const claimed = status === 'under_review' && rnd() < 0.3;
    appRows.push({
      id,
      ref: submitted ? `VD-2026-${String(++refN).padStart(5, '0')}` : null,
      studentId,
      ruleSetId: rsRow.id,
      status,
      currentExpiry: expiry,
      noPass: false,
      requestedMonths: 12,
      feeStatus: rnd() < 0.6 ? 'unpaid' : 'paid',
      submittedAt: submitted,
      claimedBy: claimed ? pick(staffIds) : null,
      claimedUntil: claimed ? new Date(Date.now() + 600_000).toISOString() : null,
      correctionsRound: status === 'corrections_needed' ? 1 : 0,
      lastActivityAt: submitted ?? created,
      createdAt: created,
      updatedAt: submitted ?? created,
    });
    const checklist = computeChecklist(ruleSet, { studentType: meta.type, nationality: meta.nationality });
    checklist.items.forEach((item, di) => {
      const docId = crypto.randomUUID();
      const state = docStateFor(status, di);
      let currentVersionId: string | null = null;
      if (state !== 'missing') {
        for (let page = 1; page <= item.minFiles; page++) {
          const versions = rnd() < 0.15 ? 2 : 1;
          for (let seq = 1; seq <= versions; seq++) {
            const vid = crypto.randomUUID();
            const key = blobKeys.documentVersion(id, item.code, seq + (page - 1) * 2);
            const tkey = blobKeys.documentThumb(id, item.code, seq + (page - 1) * 2);
            blobWrites.push([key, tkey]);
            verRows.push({
              id: vid,
              applicationDocumentId: docId,
              applicationId: id,
              seq: seq + (page - 1) * 2,
              page,
              storageKey: key,
              thumbKey: tkey,
              sha256: Buffer.from(vid.replace(/-/g, ''), 'hex').toString('hex').padEnd(64, '0'),
              width: 2000,
              height: 1500,
              bytes: 650_000 + Math.floor(rnd() * 900_000),
              quality: { blur: 150 + Math.floor(rnd() * 200), glare: 0.01, warnings: [], source: 'camera', serverReencoded: true },
              uploadedBy: studentId,
              uploadedAt: created,
              supersededAt: seq < versions ? created : null,
            });
            if (seq === versions) currentVersionId = vid;
            audits.push({ at: created, actorId: studentId, action: 'document.uploaded', targetType: 'document_version', targetId: vid, meta: canonicalJson({ applicationId: id, docCode: item.code, page, seq }) });
            eventRows.push({ applicationId: id, type: 'document_uploaded', data: { docCode: item.code, page, seq }, actorId: studentId, at: created });
          }
        }
        if (status === 'submitted' || status === 'under_review') fixture.reviewDocs.push({ applicationId: id, documentId: docId });
        if (state === 'approved' || state === 'rejected') {
          const reviewer = pick(staffIds);
          audits.push({ at: nowIso, actorId: reviewer, action: 'document.reviewed', targetType: 'application_document', targetId: docId, meta: canonicalJson({ applicationId: id, decision: state === 'approved' ? 'approve' : 'reject' }) });
          eventRows.push({ applicationId: id, type: 'document_reviewed', data: { docCode: item.code, decision: state === 'approved' ? 'approve' : 'reject', reasonCode: state === 'rejected' ? 'blurry' : null }, actorId: reviewer, at: nowIso });
        }
      }
      docRows.push({
        id: docId,
        applicationId: id,
        docCode: item.code,
        required: true,
        minFiles: item.minFiles,
        state,
        currentVersionId,
        reviewerId: state === 'approved' || state === 'rejected' ? pick(staffIds) : null,
        reviewerReasonCode: state === 'rejected' ? 'blurry' : null,
        reviewedAt: state === 'approved' || state === 'rejected' ? nowIso : null,
        updatedAt: created,
      });
    });
    eventRows.push({ applicationId: id, type: 'created', data: { ruleSetVersion: 1 }, actorId: studentId, at: created });
    audits.push({ at: created, actorId: studentId, action: 'application.created', targetType: 'application', targetId: id, meta: canonicalJson({ ruleSetVersion: 1 }) });
    if (submitted) {
      eventRows.push({ applicationId: id, type: 'status_changed', data: { from: 'draft', to: 'submitted', action: 'submit' }, actorId: studentId, at: submitted });
      audits.push({ at: submitted, actorId: studentId, action: 'application.submit', targetType: 'application', targetId: id, meta: canonicalJson({ from: 'draft', to: 'submitted' }) });
      notifRows.push({ kind: 'receipt', recipientId: studentId, applicationId: id, dedupeKey: `receipt:${id}`, payload: {}, status: 'sent', attempts: 1, sentAt: submitted });
    }
    for (const kind of ['approved', 'sent_to_immigration', 'pass_issued'] as const) {
      const reached =
        (kind === 'approved' && ['approved', 'sent_to_immigration', 'pass_issued', 'closed'].includes(status)) ||
        (kind === 'sent_to_immigration' && ['sent_to_immigration', 'pass_issued', 'closed'].includes(status)) ||
        (kind === 'pass_issued' && ['pass_issued', 'closed'].includes(status));
      if (!reached) continue;
      eventRows.push({ applicationId: id, type: 'status_changed', data: { to: kind }, actorId: staffIds[1]!, at: nowIso });
      audits.push({ at: nowIso, actorId: staffIds[1]!, action: `application.${kind}`, targetType: 'application', targetId: id, meta: canonicalJson({ to: kind }) });
      notifRows.push({ kind, recipientId: studentId, applicationId: id, dedupeKey: `${kind}:${id}`, payload: {}, status: 'sent', attempts: 1, sentAt: nowIso });
    }
    if (status === 'approved') fixture.approvedAppIds.push(id);
  }

  await chunked(appRows, 200, (p) => db.insert(applications).values(p));
  await chunked(docRows, 500, (p) => db.insert(applicationDocuments).values(p));
  await chunked(verRows, 400, (p) => db.insert(documentVersions).values(p));
  await chunked(eventRows, 500, (p) => db.insert(applicationEvents).values(p));
  await chunked(notifRows, 500, (p) => db.insert(notifications).values(p));

  // Audit chain continues from the seed's rows; compute hashes sequentially.
  const lastRow = (await h.client.execute('select hash from audit_log order by id desc limit 1')).rows[0];
  let prev = (lastRow?.hash as string | undefined) ?? GENESIS_HASH;
  const auditRows = audits.map((a) => {
    const hash = computeAuditHash(prev, a);
    const row = { ...a, prevHash: prev, hash };
    prev = hash;
    return row;
  });
  await chunked(auditRows, 500, (p) => db.insert(auditLog).values(p));

  // Blobs (same encrypted payload under every key).
  let n = 0;
  for (const [k, tk] of blobWrites) {
    await disk.put(k!, encScan);
    await disk.put(tk!, encThumb);
    if (++n % 5000 === 0) console.log(`  blobs: ${n * 2}`);
  }

  // ---------------- sessions + fixture
  const sess = async (id: string) => (await createSession(db, (await db.select().from(profiles).where(eq(profiles.id, id)))[0]!)).token;
  for (const id of staffIds) fixture.staff.push(await sess(id));
  const draft = appRows.find((a) => a.status === 'draft')!;
  fixture.student = { token: await sess(draft.studentId), applicationId: draft.id! };
  // Uploaders: students WITHOUT an application get a fresh draft whose first single-page
  // document is free (each load-test upload goes to a different student, like real users).
  const free = studentIds.slice(N_APPS, N_APPS + N_UPLOADERS);
  for (const sid of free) {
    const meta = studentMeta.get(sid)!;
    const appId = crypto.randomUUID();
    await db.insert(applications).values({ id: appId, studentId: sid, ruleSetId: rsRow.id, status: 'draft', currentExpiry: addDays(today, 50), requestedMonths: 12, lastActivityAt: nowIso });
    const items = computeChecklist(ruleSet, { studentType: meta.type, nationality: meta.nationality }).items;
    await db.insert(applicationDocuments).values(items.map((it) => ({ applicationId: appId, docCode: it.code, minFiles: it.minFiles, state: 'missing' as const })));
    const docCode = items.find((it) => it.minFiles === 1 && it.code !== 'passport_data_page')?.code ?? items[0]!.code;
    fixture.uploaders.push({ token: await sess(sid), applicationId: appId, docCode });
  }
  fixture.staffVersionIds = verRows.filter((v) => !v.supersededAt).slice(0, 500).map((v) => v.id!);

  fs.writeFileSync(path.resolve(c.dataDir, 'perf-fixture.json'), JSON.stringify(fixture, null, 2));
  await h.client.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  const counts = await h.client.execute(
    `select (select count(*) from profiles) p, (select count(*) from applications) a, (select count(*) from application_documents) d,
            (select count(*) from document_versions) v, (select count(*) from application_events) e, (select count(*) from audit_log) au,
            (select count(*) from notifications) n`,
  );
  console.log(JSON.stringify({ ms: Date.now() - t0, dbBytes: fs.statSync(file).size, blobs: blobWrites.length * 2, ...counts.rows[0] }));
  h.client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
