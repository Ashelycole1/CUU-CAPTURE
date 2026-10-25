import Link from 'next/link';
import { ChevronRight, GraduationCap } from 'lucide-react';
import { Chip } from '@/components/ui/chip';
import { documentStateChip } from '@/domain/status';
import type { DocumentState } from '@/domain/types';
import { interpolate } from '@/i18n';
import { en } from '@/i18n/en';
import { studentText } from '@/i18n/student';
import { cn } from '@/lib/cn';
import { docHref, slotsFor } from './logic';

export interface ChecklistCardProps {
  code: string;
  name: string;
  helpText: string;
  whereToGet: string;
  minFiles: number;
  universityAddition: boolean;
  state: DocumentState;
  pagesDone: { id: string; page: number }[];
  canUpload: boolean;
  /** Highlight as the next thing to do. */
  isNext?: boolean;
}

/**
 * One checklist item (FR-CHK-2/4/5): name, why, where to get it, state chip,
 * "Required by the university" tag, page slots. The whole card is the link.
 */
export function ChecklistCard(p: ChecklistCardProps) {
  const chip = documentStateChip(p.state);
  const slots = p.minFiles > 1 ? slotsFor(p.minFiles, p.pagesDone) : null;
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-base font-semibold">{p.name}</h3>
        <Chip tone={chip.tone} className="shrink-0">
          {chip.label}
        </Chip>
      </div>
      <p className="mt-1 text-sm text-ink-muted">{p.helpText}</p>
      <p className="mt-1 text-sm">
        <span className="font-semibold">{studentText.checklist.whereToGet}:</span> {p.whereToGet}
      </p>
      {(p.universityAddition || slots) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {p.universityAddition && (
            <span className="inline-flex items-center gap-1 rounded-full border border-[color-mix(in_srgb,var(--accent-500)_50%,transparent)] bg-[color-mix(in_srgb,var(--accent-500)_12%,transparent)] px-2.5 py-0.5 text-sm font-medium text-ink">
              <GraduationCap aria-hidden className="size-3.5" />
              {en.checklist.universityAddition}
            </span>
          )}
          {slots && (
            <span className="font-mono text-sm text-ink-muted tabular-nums">
              {slots.map((s) => `${interpolate(studentText.capture.pageSlot, { n: s.page })} ${s.versionId ? '✓' : '+'}`).join(' · ')}
            </span>
          )}
        </div>
      )}
    </>
  );
  const cls = cn(
    'block rounded-md border bg-surface p-4 shadow-1 no-underline text-ink',
    p.isNext ? 'border-brand-500 ring-1 ring-brand-500' : 'border-line',
    p.state === 'rejected' && 'border-[color-mix(in_srgb,var(--warn)_60%,transparent)]',
  );
  if (!p.canUpload) return <div className={cls}>{body}</div>;
  return (
    <Link href={docHref(p.code)} className={cn(cls, 'group relative pr-10 hover:border-brand-500')}>
      {body}
      <ChevronRight aria-hidden className="absolute top-1/2 right-3 size-5 -translate-y-1/2 text-ink-muted group-hover:text-ink" />
    </Link>
  );
}
