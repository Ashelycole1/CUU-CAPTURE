import { Check } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface Step {
  id: string;
  label: string;
}

/** Progress stepper (e.g. Profile → Checklist → Review → Submit). */
export function Stepper({ steps, current, className }: { steps: Step[]; current: number; className?: string }) {
  return (
    <ol className={cn('flex items-center gap-2', className)} aria-label="Progress">
      {steps.map((s, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'todo';
        return (
          <li key={s.id} className="flex min-w-0 flex-1 items-center gap-2" aria-current={state === 'current' ? 'step' : undefined}>
            <span
              className={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-bold',
                state === 'done' && 'border-ok bg-ok text-white',
                state === 'current' && 'border-brand-500 text-brand-500',
                state === 'todo' && 'border-line text-ink-muted',
              )}
            >
              {state === 'done' ? <Check aria-hidden className="size-4" /> : i + 1}
            </span>
            <span className={cn('truncate text-sm', state === 'current' ? 'font-semibold text-ink' : 'text-ink-muted')}>
              {s.label}
              <span className="sr-only">{state === 'done' ? ' (done)' : state === 'current' ? ' (current step)' : ''}</span>
            </span>
            {i < steps.length - 1 && <span aria-hidden className="h-px flex-1 bg-line" />}
          </li>
        );
      })}
    </ol>
  );
}
