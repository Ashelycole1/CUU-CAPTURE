/** Helpers shared by tests/jobs and tests/admin. */
import { eq } from 'drizzle-orm';
import type { Db } from '@/server/db/client';
import { applications, documentVersions, jobRuns, students } from '@/server/db/schema';
import type { Actor } from '@/server/authz';
import { addDays, todayInKampala } from '@/domain/dates';
import {
  claimApplication,
  closeApplication,
  markApproved,
  markSentToImmigration,
  postMessage,
  recordPassIssued,
  recordPayment,
  reviewDocument,
  type Application,
} from '@/server/services';
import { blobKeys, getBlobStore } from '@/server/storage';
import { createStudent } from '../helpers/db';
import { createSubmittedApplication, docsOf } from '../helpers/factories';

/** A student with a pass expiring `days` after `today`, and no application. */
export async function studentExpiringIn(db: Db, days: number | null, today = todayInKampala(), opts: { email?: string } = {}): Promise<Actor> {
  const s = await createStudent(db, { email: opts.email });
  await db
    .update(students)
    .set(days === null ? { noPass: true, passExpiry: null } : { passExpiry: addDays(today, days), noPass: false })
    .where(eq(students.profileId, s.id));
  return s;
}

export async function resetJobRuns(db: Db): Promise<void> {
  await db.delete(jobRuns);
}

/** Write real (encrypted) bytes for every version of an application so blob deletion can be checked. */
export async function storeFilesFor(db: Db, applicationId: string): Promise<string[]> {
  const versions = await db.select().from(documentVersions).where(eq(documentVersions.applicationId, applicationId));
  const store = getBlobStore();
  const keys: string[] = [];
  for (const v of versions) {
    const { key } = await store.put(v.storageKey, new TextEncoder().encode(`jpeg-${v.id}`), 'image/jpeg');
    keys.push(key);
    if (v.thumbKey) {
      const t = await store.put(v.thumbKey, new TextEncoder().encode(`thumb-${v.id}`), 'image/jpeg');
      keys.push(t.key);
    }
  }
  return keys;
}

/**
 * A fully processed application (submitted → approved → sent → pass issued → closed),
 * with stored files, a fee receipt and a message, closed `closedDaysAgo` days ago.
 */
export async function closedApplication(
  db: Db,
  staff: Actor,
  opts: { closedDaysAgo: number; nationality?: string },
): Promise<{ student: Actor; app: Application; keys: string[] }> {
  const { student, app } = await createSubmittedApplication(db, { nationality: opts.nationality ?? 'NG', studentType: 'new' });
  const keys = await storeFilesFor(db, app.id);
  await claimApplication(staff, app.id);
  for (const d of (await docsOf(db, app.id)).filter((x) => x.required)) {
    await reviewDocument(staff, { documentId: d.id, decision: 'approve' });
  }
  await markApproved(staff, app.id);
  const receipt = await getBlobStore().put(blobKeys.receipt(app.id, crypto.randomUUID()), new TextEncoder().encode('receipt'), 'image/jpeg');
  keys.push(receipt.key);
  await recordPayment(staff, app.id, { amountUgx: 370000, paidOn: todayInKampala(), reference: 'URA-123', receiptKey: receipt.key });
  await postMessage(student, app.id, { body: 'My passport number is A1234567' });
  await markSentToImmigration(staff, app.id, { method: 'in_person' });
  await recordPassIssued(staff, app.id, { newExpiry: addDays(todayInKampala(), 365) });
  await closeApplication(staff, app.id);
  const closedAt = new Date(Date.now() - opts.closedDaysAgo * 86_400_000).toISOString();
  await db.update(applications).set({ closedAt }).where(eq(applications.id, app.id));
  const updated = (await db.select().from(applications).where(eq(applications.id, app.id)))[0]!;
  return { student, app: updated, keys };
}
