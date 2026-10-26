import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';

/** Friendly empty state: tinted icon bubble, title, optional hint and action. */
export function EmptyState({ icon: Icon, title, hint, action, className }: { icon: LucideIcon; title: ReactNode; hint?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center rounded-md border-2 border-dashed border-line bg-silver/40 px-6 py-12 text-center', className)}>
      <span aria-hidden className="relative mb-4 inline-flex size-16 items-center justify-center rounded-full border-2 border-edge bg-sky text-ink">
        <span className="absolute -top-1 -right-2 size-4 rounded-full border-2 border-edge bg-brand-500" />
        <Icon className="size-7" />
      </span>
      <p className="font-serif text-lg font-bold">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-sm text-ink-muted">{hint}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
