import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowRight, BadgeCheck, Banknote, Pencil, TriangleAlert } from 'lucide-react';
import { requireActor } from '@/server/auth/current';
import { getChecklistForApplication, getOrCreateDraft } from '@/server/services';
import { getMyDeletionRequest } from '@/server/services/privacy';
import { Runway } from '@/components/runway';
import { ChecklistCard } from '@/components/student/checklist-card';
import { ProgressRing } from '@/components/student/progress-ring';
import { StickyBar } from '@/components/student/sticky-bar';
import { docHref, humanize, nextUndone } from '@/components/student/logic';
import { documentStateChip, studentStatusCopy } from '@/domain/status';
import { Chip } from '@/components/ui/chip';
import { interpolate } from '@/i18n';
import { en } from '@/i18n/en';
import { studentText } from '@/i18n/student';

export const metadata: Metadata = { title: 'Your checklist' };

const barLink =
  'flex min-h-12 w-full items-center justify-center gap-2 rounded-sm bg-brand-500 px-4 font-semibold text-on-brand no-underline hover:bg-brand-700';

/**
 * Checklist home (design §6.2 screen 3, FR-CHK-1..5, FR-RUN-1/4): Runway, fee
 * banner, progress ring, document cards, sticky Continue to the next undone item.
 */
export default async function ApplyPage() {
  const actor = await requireActor(['student']);
  // A pending deletion request: don't start a new draft (it would block the admin's approval).
  if ((await getMyDeletionRequest(actor))?.status === 'pending') redirect('/status');
  const app = await getOrCreateDraft(actor);
  const c = await getChecklistForApplication(actor, app.id);
  const t = studentText.checklist;
  const draft = app.status === 'draft';
  const fieldsMissing = draft && ((!app.noPass && !app.currentExpiry) || !app.requestedMonths);

  // First visit / incomplete profile: start with the welcome questions.
  if (draft && !c.profileComplete) redirect('/profile');

  const next = nextUndone(c.items);
  const status = studentStatusCopy(app.status, { newExpiry: app.newExpiry });

  return (
    <div className="space-y-6">
      <div>
        <h1>{t.title}</h1>
        <p className="mt-1 text-ink-muted">{draft ? status.explanation : t.submittedNote}</p>
      </div>

      <Runway summary={c.runway} />

      {c.runway.band === 'expired' && (
        <div role="note" className="flex gap-3 rounded-sm border border-[color-mix(in_srgb,var(--risk-expired)_50%,transparent)] bg-[color-mix(in_srgb,var(--risk-expired)_8%,var(--surface))] p-3 text-sm">
          <TriangleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-risk-expired" />
          <p>
            <strong>{interpolate(t.penaltyEstimate, { amount: c.runway.penaltyUsd, rate: c.runway.penaltyUsdPerDay })}</strong>{' '}
            <span className="text-ink-muted">{t.penaltyNote}</span>
          </p>
        </div>
      )}

      <p className="flex items-start gap-3 rounded-sm border border-line bg-brand-100 p-3 text-sm">
        {c.feeRequired ? <Banknote aria-hidden className="mt-0.5 size-5 shrink-0" /> : <BadgeCheck aria-hidden className="mt-0.5 size-5 shrink-0 text-ok" />}
        <span className="font-medium">{c.feeRequired ? interpolate(en.checklist.feeRequired, { amount: c.feeUsd }) : en.checklist.feeWaived}</span>
      </p>

      {fieldsMissing && (
        <Link href="/profile?step=3" className="flex min-h-12 items-center gap-2 rounded-sm border border-warn p-3 font-semibold text-ink no-underline">
          <TriangleAlert aria-hidden className="size-5 text-warn" />
          {studentText.review.fieldIssue}
        </Link>
      )}

      <div className="flex items-center justify-between gap-3 rounded-md border-2 border-edge bg-sky p-3 pr-4">
        <ProgressRing done={c.progress.done} total={c.progress.total} />
        {draft && (
          <Link href="/profile" className="inline-flex min-h-12 items-center gap-1.5 text-sm font-semibold">
            <Pencil aria-hidden className="size-4" />
            {t.editProfile}
          </Link>
        )}
      </div>

      <ul className="space-y-3">
        {c.items.map((e) => (
          <li key={e.item.code}>
            <ChecklistCard
              code={e.item.code}
              name={e.item.name}
              helpText={e.item.helpText}
              whereToGet={e.item.whereToGet}
              minFiles={e.item.minFiles}
              universityAddition={e.item.universityAddition}
              state={e.document?.state ?? 'missing'}
              pagesDone={e.currentVersions}
              canUpload={e.canUpload}
              isNext={next?.item.code === e.item.code}
            />
          </li>
        ))}
      </ul>

      {c.notRequired.length > 0 && (
        <section aria-labelledby="not-required" className="space-y-2">
          <h2 id="not-required" className="text-lg">
            {t.notRequiredTitle}
          </h2>
          <p className="text-sm text-ink-muted">{t.notRequiredBody}</p>
          <ul className="space-y-2">
            {c.notRequired.map((d) => {
              const chip = documentStateChip(d.state, false);
              return (
                <li key={d.id} className="flex items-center justify-between gap-3 rounded-sm border border-dashed border-line p-3 text-ink-muted">
                  <span>{humanize(d.docCode)}</span>
                  <Chip tone={chip.tone}>{chip.label}</Chip>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <StickyBar>
        {next ? (
          <Link href={docHref(next.item.code)} className={barLink}>
            {interpolate(t.continueNext, { doc: next.item.name })}
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        ) : draft ? (
          <Link href="/review" className={barLink}>
            {t.allDone}
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        ) : (
          <Link href="/status" className={barLink}>
            {t.viewStatus}
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        )}
      </StickyBar>
    </div>
  );
}
