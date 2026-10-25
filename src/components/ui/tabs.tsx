'use client';
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface TabItem {
  id: string;
  label: ReactNode;
  content: ReactNode;
}

/** WAI-ARIA tabs with roving focus (Arrow/Home/End). */
export function Tabs({ items, defaultId, className, onChange }: { items: TabItem[]; defaultId?: string; className?: string; onChange?: (id: string) => void }) {
  const [active, setActive] = useState(defaultId ?? items[0]?.id);
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const select = (i: number) => {
    const item = items[i];
    if (!item) return;
    setActive(item.id);
    onChange?.(item.id);
    refs.current[i]?.focus();
  };
  const onKey = (e: KeyboardEvent, i: number) => {
    if (e.key === 'ArrowRight') select((i + 1) % items.length);
    else if (e.key === 'ArrowLeft') select((i - 1 + items.length) % items.length);
    else if (e.key === 'Home') select(0);
    else if (e.key === 'End') select(items.length - 1);
    else return;
    e.preventDefault();
  };
  return (
    <div className={className}>
      <div role="tablist" className="flex gap-1 border-b border-line">
        {items.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="tab"
            type="button"
            id={`${base}-tab-${t.id}`}
            aria-selected={active === t.id}
            aria-controls={`${base}-panel-${t.id}`}
            tabIndex={active === t.id ? 0 : -1}
            onClick={() => select(i)}
            onKeyDown={(e) => onKey(e, i)}
            className={cn(
              '-mb-px min-h-11 border-b-2 px-4 text-sm font-semibold',
              active === t.id ? 'border-brand-500 text-ink' : 'border-transparent text-ink-muted hover:text-ink',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {items.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${base}-panel-${t.id}`}
          aria-labelledby={`${base}-tab-${t.id}`}
          hidden={active !== t.id}
          tabIndex={0}
          className="pt-4"
        >
          {t.content}
        </div>
      ))}
    </div>
  );
}
