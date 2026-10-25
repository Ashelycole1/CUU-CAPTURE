import { interpolate } from '@/i18n';
import { studentText } from '@/i18n/student';
import { ringDash } from './logic';

/** "5 of 8 done" progress ring (design §6.2). The text carries the meaning; the ring is decorative. */
export function ProgressRing({ done, total }: { done: number; total: number }) {
  const r = 26;
  const { circumference, offset } = ringDash(done, total, r);
  const complete = total > 0 && done >= total;
  return (
    <div className="flex items-center gap-3">
      <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden className="shrink-0 -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="var(--line)" strokeWidth="7" />
        <circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          stroke={complete ? 'var(--ok)' : 'var(--brand-500)'}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-[stroke-dashoffset] duration-200 ease-out motion-reduce:transition-none"
        />
      </svg>
      <p className="font-mono text-base font-semibold tabular-nums">{interpolate(studentText.checklist.progressLabel, { done, total })}</p>
    </div>
  );
}
