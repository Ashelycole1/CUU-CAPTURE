import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** Sticky bottom action bar (design §4: thumb reach, safe-area aware). */
export function StickyBar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur',
        'pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]',
        className,
      )}
    >
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-2 px-4">{children}</div>
    </div>
  );
}
