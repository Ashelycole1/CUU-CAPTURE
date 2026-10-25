/** Staff server actions + payment/receipt routes: staff-only (students get FORBIDDEN/403), happy paths work. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { createAdmin, createStaff, createTestDb, type TestDb } from '../helpers/db';
import { createSubmittedApplication, docsOf } from '../helpers/factories';
import { applications, auditLog, messages, payments } from '@/server/db/schema';
import * as actions from '@/app/(staff)/actions';
import type { Actor } from '@/server/authz';
import { createApprovedWithFiles, req, setActor } from './helpers';

vi.mock('@/server/auth/current', async () => (await import('./helpers')).authMock());
vi.mock('next/server', async (orig) => (await import('./helpers')).nextServerMock(orig));
vi.mock('next/cache', async () => (await import('./helpers')).nextCacheMock());

let t: TestDb;
let staff: Actor;

beforeAll(async () => {
  t = await createTestDb();
  staff = await createStaff(t.db);
});
afterAll(() => t.cleanup());

describe('server actions are staff-only', () => {
  it('every action returns FORBIDDEN for a student and UNAUTHENTICATED when signed out', async () => {
    const { student, app } = await createSubmittedApplication(t.db, {});
    const doc = (await docsOf(t.db, app.id))[0]!;
    const calls: (() => Promise<{ ok: boolean; error?: { code: string } }>)[] = [
      () => actions.approveApplicationAction(app.id),
      () => actions.markSentAction(app.id, { method: 'email' }),
      () => actions.recordPassIssuedAction(app.id, { newExpiry: '2027-10-01' }),
      () => actions.closeApplicationAction(app.id),
      () => actions.setFeeStatusAction(app.id, 'paid'),
      () => actions.claimAction(app.id),
      () => actions.releaseClaimAction(app.id),
      () => actions.reviewDocumentAction({ documentId: doc.id, decision: 'approve' }),
      () => actions.getReviewContextAction(app.id),
      () => actions.postMessageAction(app.id, { body: 'hi', internal: true }),
      () => actions.createSavedViewAction({ name: 'x', filters: {} }),
      () => actions.deleteSavedViewAction('nope'),
      () => actions.bulkRemindAction([app.id]),
      () => actions.bulkMarkFeePaidAction([app.id]),
      () => actions.bulkExportPacketsAction([app.id]),
    ];
    setActor(student);
    for (const c of calls) {
      const r = await c();
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('FORBIDDEN');
    }
    setActor(null);
    for (const c of calls.slice(0, 3)) expect((await c()).error?.code).toBe('UNAUTHENTICATED');
    // Nothing changed
    const row = (await t.db.select().from(applications).where(eq(applications.id, app.id)))[0]!;
    expect(row.status).toBe('submitted');
    expect(row.feeStatus).not.toBe('paid');
    expect(await t.db.select().from(messages).where(eq(messages.applicationId, app.id))).toHaveLength(0);
  });
});

describe('staff happy paths', () => {
  it('approve → mark sent → pass issued → close', async () => {
    const { app } = await createApprovedWithFiles(t.db, staff, { skipApprove: true });
    setActor(staff);
    expect((await actions.approveApplicationAction(app.id)).ok).toBe(true);
    expect((await actions.markSentAction(app.id, { method: 'in_person', sentOn: '2026-10-20' })).ok).toBe(true);
    const bad = await actions.recordPassIssuedAction(app.id, { newExpiry: 'not-a-date' });
    expect(bad.ok).toBe(false);
    expect((await actions.recordPassIssuedAction(app.id, { newExpiry: '2027-10-20' })).ok).toBe(true);
    expect((await actions.closeApplicationAction(app.id)).ok).toBe(true);
    const row = (await t.db.select().from(applications).where(eq(applications.id, app.id)))[0]!;
    expect(row.status).toBe('closed');
    expect(row.sentMethod).toBe('in_person');
  });

  it('internal notes, claims, review context, saved views', async () => {
    const { app } = await createSubmittedApplication(t.db, {});
    setActor(staff);
    expect((await actions.postMessageAction(app.id, { body: 'note', internal: true })).ok).toBe(true);
    const c = await actions.claimAction(app.id);
    expect(c.ok && c.claimedUntil).toBeTruthy();
    const other = await createStaff(t.db);
    setActor(other);
    const conflict = await actions.claimAction(app.id);
    expect(!conflict.ok && conflict.error.code).toBe('CONFLICT');
    const ctx = await actions.getReviewContextAction(app.id);
    expect(ctx.ok && ctx.context.student.studentNo).toBeTruthy();
    setActor(staff);
    expect((await actions.releaseClaimAction(app.id)).ok).toBe(true);
    const v = await actions.createSavedViewAction({ name: 'Urgent KE', filters: { nationality: ['KE'], sort: 'expiry' }, shared: true });
    expect(v.ok).toBe(true);
    setActor(other);
    if (v.ok) expect((await actions.deleteSavedViewAction(v.id)).ok).toBe(false);
    setActor(await createAdmin(t.db));
    if (v.ok) expect((await actions.deleteSavedViewAction(v.id)).ok).toBe(true);
  });

  it('bulk: reminders email students, fee paid, export only approved', async () => {
    const a = await createSubmittedApplication(t.db, {});
    const b = await createApprovedWithFiles(t.db, staff, {});
    setActor(staff);
    const rem = await actions.bulkRemindAction([a.app.id, b.app.id, 'missing-id']);
    expect(rem.ok && rem.outcome.done.length).toBe(2);
    expect(rem.ok && rem.outcome.skipped).toEqual(['missing-id']);
    const fee = await actions.bulkMarkFeePaidAction([a.app.id]);
    expect(fee.ok && fee.outcome.done).toEqual([a.app.id]);
    const exp = await actions.bulkExportPacketsAction([a.app.id, b.app.id]);
    expect(exp.ok).toBe(true);
    if (exp.ok) {
      expect(exp.packets.map((p) => p.applicationId)).toEqual([b.app.id]);
      expect(exp.outcome.skipped).toEqual([a.app.id]);
    }
  });
});

describe('payments route (FR-FEE-2)', () => {
  const load = async () => ({
    pay: (await import('@/app/(staff)/applications/[id]/payments/route')).POST,
    receipt: (await import('@/app/(staff)/applications/[id]/payments/[paymentId]/receipt/route')).GET,
  });

  it('records a payment with a re-encoded, encrypted receipt; audited view; students 403', async () => {
    const { pay, receipt } = await load();
    const { app, student } = await createSubmittedApplication(t.db, {});
    const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#cc8844' } }).png().toBuffer();
    const form = () => {
      const f = new FormData();
      f.set('amountUgx', '370,000');
      f.set('paidOn', '2026-10-20');
      f.set('reference', 'BANK-123');
      f.set('receipt', new File([new Uint8Array(png)], 'r.png', { type: 'image/png' }));
      return f;
    };

    setActor(student);
    const denied = await pay(req(`/applications/${app.id}/payments`, { method: 'POST', body: form() }), { params: Promise.resolve({ id: app.id }) });
    expect(denied.status).toBe(403);

    setActor(staff);
    const res = await pay(req(`/applications/${app.id}/payments`, { method: 'POST', body: form() }), { params: Promise.resolve({ id: app.id }) });
    expect(res.status).toBe(201);
    const { payment } = (await res.json()) as { payment: { id: string; hasReceipt: boolean; amountUgx: number } };
    expect(payment.amountUgx).toBe(370000);
    expect(payment.hasReceipt).toBe(true);
    const row = (await t.db.select().from(applications).where(eq(applications.id, app.id)))[0]!;
    expect(row.feeStatus).toBe('paid');

    const img = await receipt(req(`/applications/${app.id}/payments/${payment.id}/receipt`), { params: Promise.resolve({ id: app.id, paymentId: payment.id }) });
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/jpeg');
    const bytes = new Uint8Array(await img.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
    const views = await t.db.select().from(auditLog).where(and(eq(auditLog.action, 'file.viewed'), eq(auditLog.targetId, payment.id)));
    expect(views).toHaveLength(1);

    setActor(student);
    const r403 = await receipt(req(`/applications/${app.id}/payments/${payment.id}/receipt`), { params: Promise.resolve({ id: app.id, paymentId: payment.id }) });
    expect(r403.status).toBe(403);
  });

  it('rejects an unreadable receipt and does not record a payment', async () => {
    const { pay } = await load();
    const { app } = await createSubmittedApplication(t.db, {});
    setActor(staff);
    const f = new FormData();
    f.set('amountUgx', '1000');
    f.set('paidOn', '2026-10-20');
    f.set('receipt', new File([new Uint8Array([1, 2, 3, 4])], 'x.jpg', { type: 'image/jpeg' }));
    const res = await pay(req(`/applications/${app.id}/payments`, { method: 'POST', body: f }), { params: Promise.resolve({ id: app.id }) });
    expect(res.status).toBe(422);
    expect(await t.db.select().from(payments).where(eq(payments.applicationId, app.id))).toHaveLength(0);
  });
});
