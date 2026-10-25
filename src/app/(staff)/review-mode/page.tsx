import type { Metadata } from 'next';
import { requireActor } from '@/server/auth/current';
import { listReasonTemplates, listReviewQueue } from '@/server/services';
import { ReviewMode, type QueueItem } from '@/components/staff/review-mode';
import { staffText } from '@/i18n/staff';

export const metadata: Metadata = { title: staffText.review.title };

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || null;

/** FR-REV-1: full-screen queue of uploaded documents (oldest submission first), filterable by application / doc type. */
export default async function ReviewModePage({ searchParams }: { searchParams: Promise<SP> }) {
  const actor = await requireActor(['dos_staff', 'dos_admin']);
  const sp = await searchParams;
  const app = one(sp.app);
  const doc = one(sp.doc);
  const [queue, templates, all] = await Promise.all([
    listReviewQueue(actor, { applicationId: app ?? undefined, docCode: doc ?? undefined, limit: 200 }),
    listReasonTemplates(actor),
    // Unfiltered head of the queue, only to populate the filter menus.
    app || doc ? listReviewQueue(actor, { limit: 200 }) : null,
  ]);
  const source = all ?? queue;
  const items: QueueItem[] = queue.items.map((i) => ({
    documentId: i.documentId,
    docCode: i.docCode,
    docName: i.docName,
    applicationId: i.applicationId,
    ref: i.ref,
    studentName: i.studentName,
    studentNo: i.studentNo,
    submittedAt: i.submittedAt,
    versionIds: i.versionIds,
  }));
  const appOptions = [...new Map(source.items.map((i) => [i.applicationId, `${i.ref ?? i.applicationId.slice(0, 8)} · ${i.studentName ?? ''}`])).entries()].map(
    ([value, label]) => ({ value, label }),
  );
  const docOptions = [...new Map(source.items.map((i) => [i.docCode, i.docName])).entries()].map(([value, label]) => ({ value, label }));
  if (app && !appOptions.some((o) => o.value === app)) appOptions.unshift({ value: app, label: app.slice(0, 8) });
  if (doc && !docOptions.some((o) => o.value === doc)) docOptions.unshift({ value: doc, label: doc });

  return (
    <ReviewMode
      key={`${app ?? ''}:${doc ?? ''}`}
      items={items}
      total={queue.total}
      templates={templates.map((t) => ({ code: t.code, label: t.label, body: t.body }))}
      filter={{ app, doc }}
      appOptions={appOptions}
      docOptions={docOptions}
    />
  );
}
