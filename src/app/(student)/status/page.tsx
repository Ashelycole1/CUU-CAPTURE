import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, MessageSquare, TriangleAlert, Wrench } from 'lucide-react';
import { requireActor } from '@/server/auth/current';
import { getApplicationDetail, getMyActiveApplication, listMyApplications } from '@/server/services';
import { getReasonLabelsForApplication } from '@/server/services/student-view';
import { getMyDeletionRequest } from '@/server/services/privacy';
import { AccountDeletion } from '@/components/student/account-deletion';
import { Chip } from '@/components/ui/chip';
import { Runway } from '@/components/runway';
import { CopyRef } from '@/components/student/copy-ref';
import { Timeline } from '@/components/student/timeline';
import { StickyBar } from '@/components/student/sticky-bar';
import { fixItems, humanize, timelineEntries } from '@/components/student/logic';
import { applicationStatusTone, studentStatusCopy } from '@/domain/status';
import { formatDate } from '@/domain/dates';
import { studentText } from '@/i18n/student';

export const metadata: Metadata = { title: 'Status' };

const primaryLink =
  'flex min-h-12 w-full items-center justify-center gap-2 rounded-sm bg-brand-500 px-4 font-semibold text-on-brand no-underline hover:bg-brand-700';

/** Status (design §6.2 screens 6–7): timeline, reference, what happens next, fixes first. */
export default async function StatusPage() {
  const actor = await requireActor(['student']);
  const s = studentText.status;
  const [active, deletion] = await Promise.all([getMyActiveApplication(actor), getMyDeletionRequest(actor)]);
  const app = active ?? (await listMyApplications(actor))[0] ?? null;
  const account = (
    <AccountDeletion
      request={deletion ? { status: deletion.status, requestedAt: deletion.requestedAt } : null}
      blockedByActive={!!active && active.status !== 'draft'}
      hasDraft={active?.status === 'draft'}
    />
  );

  if (!app) {
    return (
      <div className="space-y-4 rounded-md border border-line bg-surface p-6 text-center">
        <h1 className="text-2xl">{s.title}</h1>
        <p className="text-ink-muted">{s.noApplication}</p>
        <Link href="/apply" className={primaryLink}>
          {s.start}
          <ArrowRight aria-hidden className="size-4" />
        </Link>
        <div className="text-left">{account}</div>
      </div>
    );
  }

  const detail = await getApplicationDetail(actor, app.id);
  const items = detail.checklist.items;
  const nameOf = (code: string) => items.find((i) => i.item.code === code)?.item.name ?? humanize(code);
  const rejectedCodes = items.map((i) => (i.document?.state === 'rejected' ? (i.document.reviewerReasonCode ?? '') : '')).filter(Boolean);
  const reasons = rejectedCodes.length ? await getReasonLabelsForApplication(actor, app.id, rejectedCodes) : {};
  const fixes = fixItems(items, reasons);
  const copy = studentStatusCopy(app.status, { newExpiry: app.newExpiry });
  const entries = timelineEntries(detail.events, nameOf);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1>{s.title}</h1>
        <Chip tone={applicationStatusTone(app.status)} className="text-base">
          {copy.label}
        </Chip>
        <p className="text-ink-muted">{copy.explanation}</p>
      </div>

      {app.ref && <CopyRef value={app.ref} />}

      {fixes.length > 0 && (
        <section aria-labelledby="fix-title" className="space-y-3">
          <h2 id="fix-title" className="flex items-center gap-2 text-xl">
            <Wrench aria-hidden className="size-5 text-warn" />
            {s.fixTitle}
          </h2>
          <ul className="space-y-3">
            {fixes.map((f) => (
              <li key={f.code} className="space-y-2 rounded-md border-2 border-warn bg-[color-mix(in_srgb,var(--warn)_8%,var(--surface))] p-4">
                <p className="flex items-center gap-2 font-semibold">
                  <TriangleAlert aria-hidden className="size-5 text-warn" />
                  {f.name}
                </p>
                <div className="rounded-sm bg-surface p-3">
                  <p className="text-sm text-ink-muted">{s.fixReason}</p>
                  <p className="font-medium">{f.reason}</p>
                  {f.note && <p className="mt-1 text-sm">“{f.note}”</p>}
                </div>
                <Link href={f.href} className={primaryLink}>
                  {s.fixNow}
                  <span className="sr-only">: {f.name}</span>
                  <ArrowRight aria-hidden className="size-4" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="next-title" className="rounded-md border border-line bg-surface p-4">
        <h2 id="next-title" className="text-lg">
          {s.whatNext}
        </h2>
        <p className="mt-1">{s.next[app.status]}</p>
        {app.status === 'pass_issued' && app.newExpiry && <p className="mt-1 font-mono tabular-nums">{formatDate(app.newExpiry)}</p>}
      </section>

      {active && <Runway summary={detail.checklist.runway} />}

      <section aria-labelledby="timeline-title" className="space-y-3">
        <h2 id="timeline-title" className="text-xl">
          {s.timeline}
        </h2>
        <Timeline entries={entries} label={s.timeline} />
      </section>

      {account}

      <StickyBar>
        {app.status === 'draft' ? (
          <Link href="/apply" className={primaryLink}>
            {studentText.nav.checklist}
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        ) : (
          <Link href="/messages" className={primaryLink.replace('bg-brand-500', 'bg-brand-700')}>
            <MessageSquare aria-hidden className="size-4" />
            {studentText.nav.messages}
          </Link>
        )}
      </StickyBar>
    </div>
  );
}
