import type { Metadata } from 'next';
import { requireActor } from '@/server/auth/current';
import { getChecklistForApplication, getOrCreateDraft } from '@/server/services';
import { Runway } from '@/components/runway';
import { Chip } from '@/components/ui/chip';
import { documentStateChip, studentStatusCopy } from '@/domain/status';
import { en } from '@/i18n/en';
import { interpolate } from '@/i18n';

export const metadata: Metadata = { title: 'Your application' };

/**
 * STUB (foundation). The student-UI agent replaces this with the full checklist /
 * profile flow. It demonstrates the contract: requireActor → service → components.
 */
export default async function ApplyPage() {
  const actor = await requireActor(['student']);
  const app = await getOrCreateDraft(actor);
  const checklist = await getChecklistForApplication(actor, app.id);
  const status = studentStatusCopy(app.status, { newExpiry: app.newExpiry });
  return (
    <div className="space-y-6">
      <div>
        <h1>{status.label}</h1>
        <p className="text-ink-muted">{status.explanation}</p>
      </div>
      <Runway summary={checklist.runway} />
      {checklist.profileComplete ? (
        <>
          <p className="rounded-sm border border-line bg-brand-100 p-3 text-sm">
            {checklist.feeRequired ? interpolate(en.checklist.feeRequired, { amount: checklist.feeUsd }) : en.checklist.feeWaived}
          </p>
          <p className="font-semibold">{interpolate(en.checklist.progress, checklist.progress)}</p>
          <ul className="space-y-2">
            {checklist.items.map(({ item, document }) => {
              const chip = documentStateChip(document?.state ?? 'missing');
              return (
                <li key={item.code} className="flex items-center justify-between gap-3 rounded-sm border border-line bg-surface p-3">
                  <span>{item.name}</span>
                  <Chip tone={chip.tone}>{chip.label}</Chip>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p className="text-ink-muted">Complete your profile to see your checklist.</p>
      )}
    </div>
  );
}
