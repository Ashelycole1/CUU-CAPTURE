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
const BAR: Record<string, string> = { ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--bad)', info: 'var(--info)', teal: 'var(--teal)', neutral: 'var(--line)' };

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
    'relative block overflow-hidden rounded-md border bg-surface p-4 pl-5 shadow-1 no-underline text-ink transition-[box-shadow,transform,border-color] duration-200',
    // Left accent bar in the state's colour (the chip still carries the meaning in text).
    'before:absolute before:inset-y-0 before:left-0 before:w-1.5 before:bg-[var(--bar)]',
    p.isNext ? 'border-brand-500 ring-1 ring-brand-500' : 'border-line',
    p.state === 'rejected' && 'border-[color-mix(in_srgb,var(--warn)_60%,transparent)]',
  );
  const style = { '--bar': p.isNext ? 'var(--brand-500)' : BAR[chip.tone ?? 'neutral'] } as React.CSSProperties;
  if (!p.canUpload) return <div className={cls} style={style}>{body}</div>;
  return (
    <Link href={docHref(p.code)} style={style} className={cn(cls, 'group pr-10 hover:-translate-y-0.5 hover:border-brand-500 hover:shadow-2')}>
      {body}
      <ChevronRight aria-hidden className="absolute top-1/2 right-3 size-5 -translate-y-1/2 text-ink-muted group-hover:text-ink" />
    </Link>
  );
}
