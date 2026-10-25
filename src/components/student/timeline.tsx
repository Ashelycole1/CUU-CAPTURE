import { Check, Circle, Clock3, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { TimelineEntry } from './logic';

const icons = { neutral: Circle, info: Clock3, ok: Check, warn: TriangleAlert };
const tones = { neutral: 'text-ink-muted', info: 'text-info', ok: 'text-ok', warn: 'text-warn' };

/** Vertical event timeline (design §6.2). Server-renderable. */
export function Timeline({ entries, label }: { entries: TimelineEntry[]; label: string }) {
  return (
    <ol aria-label={label} className="relative ml-3 space-y-4 border-l-2 border-line pl-6">
      {entries.map((e) => {
        const Icon = icons[e.tone];
        return (
          <li key={e.id} className="relative">
            <span className="absolute top-0.5 -left-[37px] grid size-6 place-items-center rounded-full border border-line bg-surface">
              <Icon aria-hidden className={cn('size-3.5', tones[e.tone])} strokeWidth={2.5} />
            </span>
            <p className="font-medium">{e.label}</p>
            <p className="font-mono text-sm text-ink-muted tabular-nums">
              <time dateTime={e.at}>{e.when}</time>
            </p>
          </li>
        );
      })}
    </ol>
  );
}
