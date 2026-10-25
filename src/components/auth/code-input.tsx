'use client';
import { useRef, type ClipboardEvent, type KeyboardEvent } from 'react';
import { interpolate } from '@/i18n';
import { en } from '@/i18n/en';
import { cn } from '@/lib/cn';

/**
 * 6-digit code input: one box per digit, auto-advance, backspace to previous,
 * paste of the full code fills every box, `autocomplete="one-time-code"` for SMS/
 * email autofill. Calls `onComplete` when all 6 digits are present.
 */
export function CodeInput({
  value,
  onChange,
  onComplete,
  invalid,
  describedBy,
  length = 6,
}: {
  value: string;
  onChange: (v: string) => void;
  onComplete?: (v: string) => void;
  invalid?: boolean;
  describedBy?: string;
  length?: number;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length }, (_, i) => value[i] ?? '');

  const set = (next: string) => {
    const clean = next.replace(/\D/g, '').slice(0, length);
    onChange(clean);
    if (clean.length === length) onComplete?.(clean);
  };

  const onInput = (i: number, raw: string) => {
    const d = raw.replace(/\D/g, '');
    if (!d) return;
    if (d.length > 1) {
      // Autofill can drop the whole code into one box.
      set(d);
      refs.current[Math.min(d.length, length - 1)]?.focus();
      return;
    }
    const arr = digits.slice();
    arr[i] = d;
    set(arr.join(''));
    refs.current[Math.min(i + 1, length - 1)]?.focus();
  };

  const onKeyDown = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      const arr = digits.slice();
      if (arr[i]) arr[i] = '';
      else if (i > 0) {
        arr[i - 1] = '';
        refs.current[i - 1]?.focus();
      }
      onChange(arr.join('').slice(0, length));
    } else if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus();
    else if (e.key === 'ArrowRight' && i < length - 1) refs.current[i + 1]?.focus();
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text').replace(/\D/g, '');
    if (!text) return;
    e.preventDefault();
    set(text);
    refs.current[Math.min(text.length, length) - 1]?.focus();
  };

  return (
    <div role="group" aria-label={en.auth.codeLabel} aria-describedby={describedBy} className="flex justify-between gap-2">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          value={d}
          onChange={(e) => onInput(i, e.target.value)}
          onKeyDown={(e) => onKeyDown(i, e)}
          onPaste={onPaste}
          onFocus={(e) => e.target.select()}
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={length}
          aria-label={interpolate(en.auth.digitLabel, { n: i + 1 })}
          aria-invalid={invalid || undefined}
          autoFocus={i === 0}
          className={cn(
            'h-14 w-full max-w-12 rounded-sm border bg-surface text-center font-mono text-2xl tabular text-ink',
            'focus:border-brand-500 focus:outline-2 focus:outline-focus',
            invalid ? 'border-bad' : 'border-line',
          )}
        />
      ))}
    </div>
  );
}
