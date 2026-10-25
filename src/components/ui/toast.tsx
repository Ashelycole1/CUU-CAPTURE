'use client';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { cn } from '@/lib/cn';

export type ToastTone = 'success' | 'info' | 'error';

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** ms; default 5000. Review Mode undo uses 8000 (design §7.3). */
  duration?: number;
  action?: { label: string; onClick: () => void };
}

interface ToastItem extends ToastOptions {
  id: number;
}

const ToastContext = createContext<{ toast: (t: ToastOptions) => void } | null>(null);

/** Wrap the app (done in the root layout). Toasts are announced via aria-live. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (t: ToastOptions) => {
      const id = next.current++;
      setItems((xs) => [...xs.slice(-3), { ...t, id }]);
      setTimeout(() => dismiss(id), t.duration ?? 5000);
    },
    [dismiss],
  );
  const value = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite" role="status" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 pb-[env(safe-area-inset-bottom)]">
        {items.map((t) => {
          const Icon = t.tone === 'error' ? TriangleAlert : t.tone === 'success' ? CircleCheck : Info;
          return (
            <div
              key={t.id}
              className={cn(
                'pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-md border border-line bg-surface p-4 shadow-1',
                t.tone === 'error' && 'border-bad',
              )}
            >
              <Icon aria-hidden className={cn('mt-0.5 size-5 shrink-0', t.tone === 'error' ? 'text-bad' : t.tone === 'success' ? 'text-ok' : 'text-info')} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{t.title}</p>
                {t.description && <p className="text-sm text-ink-muted">{t.description}</p>}
              </div>
              {t.action && (
                <button
                  type="button"
                  className="text-sm font-semibold text-link underline"
                  onClick={() => {
                    t.action!.onClick();
                    dismiss(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              )}
              <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="text-ink-muted">
                <X aria-hidden className="size-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx.toast;
}
