/** PRD story 3 via the Review Mode server action: reject only the passport page → exactly one email listing that doc + reason. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createStaff, createTestDb, outboxFor, type TestDb } from '../helpers/db';
import { createSubmittedApplication, docsOf } from '../helpers/factories';
import { flushNotifications } from '@/server/notify';
import { canStudentUpload } from '@/domain/state';
import { reviewDocumentAction } from '@/app/(staff)/actions';
import type { Actor } from '@/server/authz';
import { afterQueue, drainAfter, setActor } from './helpers';

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

describe('story 3: targeted rejection', () => {
  it('one email, one document, one reason; only that item re-opens', async () => {
    const { student, app } = await createSubmittedApplication(t.db, { nationality: 'KE', studentType: 'continuing' });
    await flushNotifications();
    afterQueue.length = 0;
    const before = (await outboxFor(t.db, student.email)).length; // the receipt
    setActor(staff);
    const docs = await docsOf(t.db, app.id);
    const required = docs.filter((d) => d.required);
    const passport = required.find((d) => d.docCode === 'passport_data_page')!;
    // Reject the passport first: nothing is sent while other docs are still pending.
    const r1 = await reviewDocumentAction({ documentId: passport.id, decision: 'reject', reasonCode: 'glare', note: null });
    expect(r1.ok).toBe(true);
    for (const d of required.filter((x) => x.id !== passport.id)) {
      const r = await reviewDocumentAction({ documentId: d.id, decision: 'approve' });
      expect(r.ok).toBe(true);
    }
    await drainAfter(); // the action's after(() => flushNotifications()) delivers the batched email
    const mails = (await outboxFor(t.db, student.email)).slice(before);
    expect(mails).toHaveLength(1);
    const text = `${mails[0]!.subject}\n${mails[0]!.text}`;
    expect(text).toContain('Passport data page');
    expect(text).toContain('Glare hides details');
    expect(text).not.toContain('Face of student ID card');

    const after = await docsOf(t.db, app.id);
    const reopen = after.filter((d) => d.required && canStudentUpload('corrections_needed', d.state));
    expect(reopen.map((d) => d.docCode)).toEqual(['passport_data_page']);
  });

  it('reject without a reason is refused (FR-REV-3)', async () => {
    const { app } = await createSubmittedApplication(t.db, {});
    setActor(staff);
    const d = (await docsOf(t.db, app.id))[0]!;
    const r = await reviewDocumentAction({ documentId: d.id, decision: 'reject', reasonCode: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('VALIDATION');
  });
});
