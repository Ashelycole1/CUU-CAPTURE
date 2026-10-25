import type { ReactNode } from 'react';
import { Check, CircleDot, Lock, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatDateTime, type ChipTone } from '@/domain';

export interface TimelineItem {
  id: string;
  /** ISO timestamp; rendered with formatDateTime (Kampala). */
  at: string;
  title: ReactNode;
  description?: ReactNode;
  /** Small text after the time (e.g. who did it). */
  meta?: ReactNode;
  tone?: ChipTone;
  icon?: LucideIcon;
  /** Staff-only / internal entries get a lock marker and muted styling. */
  restricted?: boolean;
  restrictedLabel?: string;
}

const TONE_DOT: Record<ChipTone, string> = {
  neutral: 'bg-surface text-ink-muted border-line',
  info: 'bg-surface text-info border-info',
  teal: 'bg-surface text-teal border-teal',
  warn: 'bg-surface text-warn border-warn',
  ok: 'bg-surface text-ok border-ok',
  bad: 'bg-surface text-bad border-bad',
};

const TONE_ICON: Record<ChipTone, LucideIcon> = {
  neutral: CircleDot,
  info: CircleDot,
  teal: Check,
  warn: TriangleAlert,
  ok: Check,
  bad: X,
};

/**
 * Generic vertical timeline (design §6.2 status, §7.2 staff detail). No hooks, so
 * it renders in server or client components. Pass items oldest → newest (or set
 * `newestFirst`). Colour is never the only signal: every entry has an icon + text.
 */
export function Timeline({
  items,
  label,
  emptyText,
  newestFirst = false,
  className,
}: {
  items: TimelineItem[];
  label: string;
  emptyText?: string;
  newestFirst?: boolean;
  className?: string;
}) {
  const list = newestFirst ? [...items].reverse() : items;
  if (list.length === 0) return emptyText ? <p className="text-sm text-ink-muted">{emptyText}</p> : null;
  return (
    <ol aria-label={label} className={cn('relative space-y-4 border-l border-line pl-6', className)}>
      {list.map((it) => {
        const tone = it.tone ?? 'neutral';
        const Icon = it.icon ?? TONE_ICON[tone];
        return (
          <li key={it.id} className="relative">
            <span
              aria-hidden
              className={cn('absolute top-0.5 -left-[2.06rem] flex size-5 items-center justify-center rounded-full border-2', TONE_DOT[tone])}
            >
              <Icon className="size-3" strokeWidth={2.5} />
            </span>
            <div className={cn('text-sm', it.restricted && 'text-ink-muted')}>
              <p className="font-semibold text-ink">
                {it.title}
                {it.restricted && (
                  <span className="ml-2 inline-flex items-center gap-0.5 align-middle text-xs font-medium text-ink-muted">
                    <Lock aria-hidden className="size-3" />
                    {it.restrictedLabel ?? ''}
                  </span>
                )}
              </p>
              {it.description && <div className="mt-0.5 text-ink-muted">{it.description}</div>}
              <p className="mt-0.5 text-xs text-ink-muted tabular">
                <time dateTime={it.at}>{formatDateTime(it.at)}</time>
                {it.meta && <> · {it.meta}</>}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
