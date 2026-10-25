import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, Lock, MapPin, TriangleAlert } from 'lucide-react';
import { requireActor } from '@/server/auth/current';
import { getChecklistForApplication, getMyActiveApplication } from '@/server/services';
import { getReasonLabelsForApplication } from '@/server/services/student-view';
import { Chip } from '@/components/ui/chip';
import { ScanCoach } from '@/components/student/scan-coach';
import { DocExample } from '@/components/student/doc-example';
import { docHref, firstOpenSlot, fixItems, nextUndone, parseSlot, slotsFor } from '@/components/student/logic';
import { documentStateChip } from '@/domain/status';
import { en } from '@/i18n/en';
import { studentText } from '@/i18n/student';
import { docProfile } from '@/lib/scan/constants';

export const metadata: Metadata = { title: 'Scan a document' };

/** Document capture, one per screen (design §6.2 screen 4). */
export default async function DocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ type: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireActor(['student']);
  const [{ type }, sp] = await Promise.all([params, searchParams]);
  const app = await getMyActiveApplication(actor);
  if (!app) redirect('/apply');
  const c = await getChecklistForApplication(actor, app.id);
  const entry = c.items.find((i) => i.item.code === type);
  if (!entry) notFound();

  const t = studentText.capture;
  const state = entry.document?.state ?? 'missing';
  const chip = documentStateChip(state);
  const slots = slotsFor(entry.item.minFiles, entry.currentVersions);
  const initialSlot = parseSlot(sp.slot, entry.item.minFiles) ?? firstOpenSlot(slots);
  const others = c.items.filter((i) => i.item.code !== type);
  const next = nextUndone(others);
  const reasons =
    state === 'rejected' && entry.document?.reviewerReasonCode
      ? await getReasonLabelsForApplication(actor, app.id, [entry.document.reviewerReasonCode])
      : {};
  const fix = fixItems([entry], reasons)[0];

  return (
    <div className="space-y-5">
      <Link href="/apply" className="inline-flex min-h-12 items-center gap-1.5 font-semibold">
        <ArrowLeft aria-hidden className="size-4" />
        {t.backToChecklist}
      </Link>

      <div className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-2xl sm:text-3xl">{entry.item.name}</h1>
          <Chip tone={chip.tone} className="mt-1 shrink-0">
            {chip.label}
          </Chip>
        </div>
        <p>{entry.item.helpText}</p>
        <p className="flex items-start gap-2 text-sm">
          <MapPin aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-muted" />
          <span>
            <span className="font-semibold">{studentText.checklist.whereToGet}:</span> {entry.item.whereToGet}
          </span>
        </p>
        {entry.item.universityAddition && <p className="text-sm font-medium text-ink-muted">{en.checklist.universityAddition}</p>}
      </div>

      {fix && (
        <div role="alert" className="rounded-md border border-warn bg-[color-mix(in_srgb,var(--warn)_10%,var(--surface))] p-4">
          <p className="flex items-center gap-2 font-semibold">
            <TriangleAlert aria-hidden className="size-5 text-warn" />
            {t.rejectedTitle}
          </p>
          {fix.reason && <p className="mt-1">{fix.reason}</p>}
          {fix.note && <p className="mt-1 text-sm text-ink-muted">“{fix.note}”</p>}
        </div>
      )}

      <DocExample name={entry.item.name} examplePath={entry.item.examplePath} frame={docProfile(type).frame} />

      {entry.canUpload ? (
        <ScanCoach
          applicationId={app.id}
          docCode={type}
          docName={entry.item.name}
          minFiles={entry.item.minFiles}
          initialSlots={slots}
          initialSlot={initialSlot}
          canUpload={entry.canUpload}
          nextHref={next ? docHref(next.item.code) : app.status === 'draft' ? '/review' : null}
        />
      ) : (
        <p className="flex items-center gap-2 rounded-sm border border-line bg-surface p-3">
          <Lock aria-hidden className="size-4 text-ink-muted" />
          {state === 'approved' ? t.approvedLocked : t.locked}
        </p>
      )}
    </div>
  );
}
