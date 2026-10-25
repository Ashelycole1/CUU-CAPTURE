'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { inputClass } from '@/components/ui/field-styles';
import { cn } from '@/lib/cn';
import { staffText } from '@/i18n/staff';

const R = staffText.reasons;

export interface ReasonTemplateOption {
  code: string;
  label: string;
  body: string;
}

/**
 * FR-REV-3 reason picker: template chips (radio group, arrow keys) + note.
 * A reason is mandatory; "other" also needs a note. Enter submits (Shift+Enter = newline).
 */
export function ReasonPicker({
  templates,
  onSubmit,
  onCancel,
  busy,
}: {
  templates: ReasonTemplateOption[];
  onSubmit: (v: { reasonCode: string; note: string | null }) => void;
  onCancel?: () => void;
  busy?: boolean;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const needsNote = code === 'other';

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  const submit = () => {
    if (!code) return setError(R.required);
    if (needsNote && !note.trim()) return setError(R.noteMissing);
    setError(null);
    onSubmit({ reasonCode: code, note: note.trim() || null });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      submit();
    } else if (e.key === 'Escape' && onCancel) {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  return (
    <div onKeyDown={onKeyDown} className="space-y-3">
      <fieldset aria-describedby={error ? `${id}-err` : `${id}-hint`}>
        <legend className="mb-2 text-sm font-semibold">{R.legend}</legend>
        <div className="flex flex-wrap gap-1.5">
          {templates.map((t, i) => (
            <label
              key={t.code}
              title={t.body || undefined}
              className={cn(
                'inline-flex min-h-9 cursor-pointer items-center rounded-full border px-3 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--focus)]',
                code === t.code ? 'border-bad bg-[color-mix(in_srgb,var(--bad)_10%,transparent)] font-semibold text-bad' : 'border-line bg-surface',
              )}
            >
              <input
                ref={i === 0 ? firstRef : undefined}
                type="radio"
                name={`${id}-reason`}
                value={t.code}
                checked={code === t.code}
                onChange={() => {
                  setCode(t.code);
                  setError(null);
                }}
                className="sr-only"
              />
              {t.label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="space-y-1">
        <label htmlFor={`${id}-note`} className="block text-sm font-semibold">
          {needsNote ? R.noteRequired : R.note}
        </label>
        <textarea
          id={`${id}-note`}
          rows={2}
          maxLength={1000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className={cn(inputClass, 'min-h-16 resize-y text-sm')}
          aria-invalid={error === R.noteMissing ? true : undefined}
        />
      </div>
      {error ? (
        <p id={`${id}-err`} role="alert" className="text-sm font-medium text-bad">
          {error}
        </p>
      ) : (
        <p id={`${id}-hint`} className="text-xs text-ink-muted">
          {R.hint}
        </p>
      )}
      <div className="flex gap-2">
        <Button variant="danger" onClick={submit} loading={busy}>
          {R.submit}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            {staffText.common.cancel}
          </Button>
        )}
      </div>
    </div>
  );
}
