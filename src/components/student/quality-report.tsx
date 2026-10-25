import { Check, OctagonAlert, TriangleAlert } from 'lucide-react';
import { interpolate } from '@/i18n';
import { studentText } from '@/i18n/student';
import { issueMessage } from '@/lib/scan/messages';
import type { QualityIssue } from '@/lib/scan/quality';
import { cn } from '@/lib/cn';

/**
 * Quality report card (design §6.2 screen 4): "✓ Sharp, ✓ Size OK, ⚠ Glare on the
 * right side". Hard problems first. Icon + text, never colour alone.
 * The parent owns the aria-live announcement.
 */
export function QualityReport({ issues, width, height, className }: { issues: QualityIssue[]; width: number; height: number; className?: string }) {
  const q = studentText.quality;
  const codes = new Set(issues.map((i) => i.code));
  const passes: string[] = [];
  if (!codes.has('too_blurry') && !codes.has('blurry')) passes.push(q.okSharp);
  if (!codes.has('too_small') && !codes.has('too_big')) passes.push(interpolate(q.okSize, { w: width, h: height }));
  if (!codes.has('glare') && !codes.has('glare_hard') && !codes.has('too_dark')) passes.push(q.okLight);
  const sorted = [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'hard' ? -1 : 1));
  return (
    <div className={cn('rounded-md border border-line bg-surface p-4', className)}>
      <h3 className="mb-2 text-base font-semibold">{q.title}</h3>
      <ul className="space-y-1.5">
        {sorted.map((i) => (
          <li key={i.code} className={cn('flex gap-2 text-sm', i.severity === 'hard' ? 'text-bad' : 'text-warn')}>
            {i.severity === 'hard' ? <OctagonAlert aria-hidden className="mt-0.5 size-4 shrink-0" /> : <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />}
            <span className="font-medium text-ink">{issueMessage(i)}</span>
          </li>
        ))}
        {passes.map((p) => (
          <li key={p} className="flex gap-2 text-sm">
            <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-ok" />
            <span>{p}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
