/** FR-ADM-1..5 and admin-only enforcement. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createAdmin, createStaff, createTestDb, type TestDb } from '../helpers/db';
import { createDraft, createSubmittedApplication, docsOf } from '../helpers/factories';
import { applications, auditLog } from '@/server/db/schema';
import { claimApplication, getOrCreateDraft, getRuleSet, listStaff, markApproved, publishRuleSet, reviewDocument, inviteStaff, setProfileStatus } from '@/server/services';
import {
  countMigratableDrafts,
  deleteRuleSetDraft,
  exportAuditCsv,
  getAnalytics,
  getAuditChainStatus,
  getPublishImpact,
  getRetentionReport,
  getRulesAdminData,
  listAllReasonTemplates,
  listAuditActions,
  listAuditLog,
  migrateDraftApplications,
  saveReasonTemplate,
  saveRuleSetDraft,
  setRetentionDays,
  toRuleSetInput,
} from '@/server/services/admin';
import { listOpenRunwayFlags } from '@/server/services/runway-flags';
import { diffRuleSets } from '@/server/services/rule-diff';
import { ForbiddenError, ValidationError } from '@/server/errors';
import { createStudent } from '../helpers/db';
import type { Actor } from '@/server/authz';

let t: TestDb;
let admin: Actor;
let staff: Actor;
let student: Actor;

beforeAll(async () => {
  t = await createTestDb();
  admin = await createAdmin(t.db);
  staff = await createStaff(t.db);
  student = await createStudent(t.db);
});
afterAll(() => t.cleanup());

describe('admin-only enforcement', () => {
  const calls: [string, (a: Actor) => Promise<unknown>][] = [
    ['getRulesAdminData', (a) => getRulesAdminData(a)],
    ['saveRuleSetDraft', (a) => saveRuleSetDraft(a, null, { feeUsd: 1, penaltyUsdPerDay: 1, applyBeforeDays: 1, maxPassMonths: 1, exemptCountries: [], reminderDays: [], documents: [] })],
    ['deleteRuleSetDraft', (a) => deleteRuleSetDraft(a, 'x')],
    ['getPublishImpact', (a) => getPublishImpact(a, 'x')],
    ['migrateDraftApplications', (a) => migrateDraftApplications(a)],
    ['countMigratableDrafts', (a) => countMigratableDrafts(a)],
    ['saveReasonTemplate', (a) => saveReasonTemplate(a, { code: 'x_y', label: 'XY' })],
    ['listAllReasonTemplates', (a) => listAllReasonTemplates(a)],
    ['setRetentionDays', (a) => setRetentionDays(a, 30)],
    ['getRetentionReport', (a) => getRetentionReport(a)],
    ['listAuditLog', (a) => listAuditLog(a)],
    ['listAuditActions', (a) => listAuditActions(a)],
    ['getAuditChainStatus', (a) => getAuditChainStatus(a)],
    ['exportAuditCsv', (a) => exportAuditCsv(a)],
    ['getAnalytics', (a) => getAnalytics(a)],
    ['inviteStaff', (a) => inviteStaff(a, { email: 'x@cavendish.ac.ug', role: 'dos_staff' })],
    ['setProfileStatus', (a) => setProfileStatus(a, 'x', 'disabled')],
    ['listStaff', (a) => listStaff(a)],
  ];
  it.each(calls)('%s: staff and students get Forbidden', async (_name, fn) => {
    await expect(fn(staff)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(fn(student)).rejects.toBeInstanceOf(ForbiddenError);
  });
  it('runway flags are staff-only', async () => {
    await expect(listOpenRunwayFlags(student)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listOpenRunwayFlags(staff)).resolves.toBeInstanceOf(Array);
  });
});

describe('rule-set editor (FR-ADM-1)', () => {
  it('draft → diff → impact summary → publish; in-flight applications keep their version; drafts can be migrated', async () => {
    const { app: submitted } = await createSubmittedApplication(t.db, { studentType: 'masters' });
    const { app: draftApp, student: drafter } = await createDraft(t.db, { studentType: 'masters' });
    const before = await getRulesAdminData(admin);
    const v1 = before.published!;
    expect(v1.version).toBe(1);

    const input = toRuleSetInput(v1);
    input.documents.push({
      code: 'sponsor_letter',
      name: 'Sponsor letter',
      helpText: 'Shows who pays your fees',
      whereToGet: 'Your sponsor',
      examplePath: null,
      appliesToTypes: ['masters'],
      minFiles: 1,
      source: 'student_addition',
      sort: 99,
    });
    input.feeUsd = 120;
    input.exemptCountries = [...input.exemptCountries, 'UG'];
    const draft = await saveRuleSetDraft(admin, null, input);
    expect(draft.version).toBe(2);
    // Saving again edits the same draft instead of creating v3.
    const again = await saveRuleSetDraft(admin, null, { ...input, penaltyUsdPerDay: 25 });
    expect(again.id).toBe(draft.id);

    const impact = await getPublishImpact(admin, draft.id);
    expect(impact.diff.docsAdded.map((d) => d.code)).toEqual(['sponsor_letter']);
    expect(impact.summary).toContain('Adds 1 document for Masters students: Sponsor letter.');
    expect(impact.summary.some((s) => /Changes Visa fee \(USD\) from 100 to 120/.test(s))).toBe(true);
    expect(impact.summary.some((s) => /Waives the visa fee for: UG/.test(s))).toBe(true);
    expect(impact.summary.some((s) => /in-flight application(s)? keeps? v1/.test(s))).toBe(true);
    expect(impact.drafts).toBeGreaterThanOrEqual(1);

    await publishRuleSet(admin, draft.id);
    const sub = (await t.db.select().from(applications).where(eq(applications.id, submitted.id)))[0]!;
    expect(sub.ruleSetId).toBe(v1.id); // keeps v1
    expect((await getRuleSet(sub.ruleSetId)).version).toBe(1);

    // New drafts use v2.
    const fresh = await createStudent(t.db, { studentType: 'masters' });
    const freshApp = await getOrCreateDraft(fresh);
    expect((await getRuleSet(freshApp.ruleSetId)).version).toBe(2);

    // Optional migrate: only drafts move; the new document appears as missing.
    expect((await countMigratableDrafts(admin)).count).toBeGreaterThanOrEqual(1);
    const res = await migrateDraftApplications(admin);
    expect(res.toVersion).toBe(2);
    expect(res.migrated).toBeGreaterThanOrEqual(1);
    const moved = (await t.db.select().from(applications).where(eq(applications.id, draftApp.id)))[0]!;
    expect(moved.ruleSetId).toBe(draft.id);
    expect((await docsOf(t.db, draftApp.id)).find((d) => d.docCode === 'sponsor_letter')?.state).toBe('missing');
    expect((await t.db.select().from(applications).where(eq(applications.id, submitted.id)))[0]!.ruleSetId).toBe(v1.id);
    void drafter;
  });

  it('diff detects removed and changed documents', () => {
    const base = { version: 1, feeUsd: 100, penaltyUsdPerDay: 20, applyBeforeDays: 30, maxPassMonths: 12, exemptCountries: ['KE'], reminderDays: [60, 30], noticeDate: null,
      documents: [
        { code: 'a', name: 'A', helpText: '', whereToGet: '', examplePath: null, appliesToTypes: null, minFiles: 1, source: 'notice' as const, sort: 1 },
        { code: 'b', name: 'B', helpText: '', whereToGet: '', examplePath: null, appliesToTypes: null, minFiles: 1, source: 'notice' as const, sort: 2 },
      ] };
    const next = { ...base, version: 2, exemptCountries: [], documents: [{ ...base.documents[0]!, minFiles: 2 }] };
    const d = diffRuleSets(base, next);
    expect(d.docsRemoved.map((x) => x.code)).toEqual(['b']);
    expect(d.docsChanged[0]!.changes[0]).toMatchObject({ key: 'minFiles', from: '1', to: '2' });
    expect(d.exemptRemoved).toEqual(['KE']);
  });
});

describe('templates, retention settings', () => {
  it('creates, edits and deactivates reason templates (audited)', async () => {
    await saveReasonTemplate(admin, { code: 'wrong_year', label: 'Statement from the wrong year', sort: 50 });
    await saveReasonTemplate(admin, { code: 'wrong_year', label: 'Statement from the wrong year', active: false, sort: 50 });
    const all = await listAllReasonTemplates(admin);
    expect(all.find((r) => r.code === 'wrong_year')?.active).toBe(false);
    await expect(saveReasonTemplate(admin, { code: 'Bad Code', label: 'x' })).rejects.toBeInstanceOf(ValidationError);
    const audits = (await t.db.select().from(auditLog)).filter((a) => a.targetId === 'wrong_year');
    expect(audits.map((a) => a.action)).toEqual(['reason_template.created', 'reason_template.updated']);
  });
  it('validates the retention period', async () => {
    await expect(setRetentionDays(admin, 3)).rejects.toBeInstanceOf(ValidationError);
    await setRetentionDays(admin, 120);
    expect((await getRetentionReport(admin)).retentionDays).toBe(120);
    await setRetentionDays(admin, 90);
  });
});

describe('audit viewer (FR-ADM-4)', () => {
  it('filters, paginates, verifies the chain and exports CSV (export is audited)', async () => {
    const page = await listAuditLog(admin, { action: 'rule_set.', limit: 2 });
    expect(page.rows.length).toBe(2);
    expect(page.rows.every((r) => r.action.startsWith('rule_set.'))).toBe(true);
    expect(page.nextBeforeId).not.toBeNull();
    const next = await listAuditLog(admin, { action: 'rule_set.', limit: 2, beforeId: page.nextBeforeId! });
    expect(next.rows[0]!.id).toBeLessThan(page.rows[1]!.id);
    const byActor = await listAuditLog(admin, { actor: admin.email });
    expect(byActor.rows.every((r) => r.actorId === admin.id)).toBe(true);
    expect((await listAuditActions(admin))).toContain('rule_set.published');
    expect((await getAuditChainStatus(admin)).ok).toBe(true);

    const { csv, rows } = await exportAuditCsv(admin, { action: 'rule_set.published' });
    expect(rows).toBeGreaterThanOrEqual(1);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('id,at,actor_id,actor,action,target_type,target_id,meta,prev_hash,hash');
    expect(lines.length).toBe(rows + 1);
    const exported = (await t.db.select().from(auditLog)).filter((a) => a.action === 'audit.exported');
    expect(exported.length).toBe(1);
    expect((await getAuditChainStatus(admin)).ok).toBe(true);
  });
});

describe('analytics (FR-ADM-5)', () => {
  it('reports submissions per week, first-pass rate, review time, rejection reasons and risk bands', async () => {
    const { app: good } = await createSubmittedApplication(t.db, { expiryInDays: 20 });
    await claimApplication(staff, good.id);
    for (const d of (await docsOf(t.db, good.id)).filter((x) => x.required)) await reviewDocument(staff, { documentId: d.id, decision: 'approve' });
    await markApproved(staff, good.id);

    const { app: bad } = await createSubmittedApplication(t.db, { expiryInDays: 5 });
    await claimApplication(staff, bad.id);
    const docs = (await docsOf(t.db, bad.id)).filter((x) => x.required);
    for (const [i, d] of docs.entries()) {
      await reviewDocument(staff, i === 0 ? { documentId: d.id, decision: 'reject', reasonCode: 'glare' } : { documentId: d.id, decision: 'approve' });
    }

    const a = await getAnalytics(admin, { weeks: 4 });
    expect(a.submissionsPerWeek).toHaveLength(4);
    expect(a.submissionsPerWeek.at(-1)!.count).toBeGreaterThanOrEqual(2);
    expect(a.firstPass.decided).toBeGreaterThanOrEqual(2);
    expect(a.firstPass.approvedFirstPass).toBeGreaterThanOrEqual(1);
    expect(a.firstPass.rate).toBeGreaterThan(0);
    expect(a.firstPass.rate).toBeLessThan(1);
    expect(a.reviewTime.count).toBeGreaterThanOrEqual(1);
    expect(a.rejectionReasons.find((r) => r.code === 'glare')).toMatchObject({ label: 'Glare hides details', count: 1 });
    const bands = Object.fromEntries(a.riskBands.map((b) => [b.band, b.count]));
    expect(bands.urgent).toBeGreaterThanOrEqual(1);
    expect(bands.critical).toBeGreaterThanOrEqual(1);
  });
});
