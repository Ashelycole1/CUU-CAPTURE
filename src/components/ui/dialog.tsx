'use client';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/**
 * Modal dialog on the native <dialog> element: focus trap, Esc to close and
 * inert background come from the browser. Focus returns to the opener on close.
 */
export function Dialog({ open, onClose, title, description, children, footer, className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cn(
        'm-auto w-[min(92vw,32rem)] rounded-md border border-line bg-surface p-0 text-ink shadow-1 backdrop:bg-black/50',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4 p-5 pb-2">
        <div>
          <h2 id={titleId} className="text-xl">
            {title}
          </h2>
          {description && (
            <p id={descId} className="mt-1 text-sm text-ink-muted">
              {description}
            </p>
          )}
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="-m-2 rounded-sm p-2 text-ink-muted hover:bg-brand-100">
          <X aria-hidden className="size-5" />
        </button>
      </div>
      {children && <div className="px-5 py-3">{children}</div>}
      {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-4">{footer}</div>}
    </dialog>
  );
}
