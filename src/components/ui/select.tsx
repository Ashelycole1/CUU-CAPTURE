'use client';
import { forwardRef, useId, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import { inputClass } from './field-styles';
import type { FieldProps } from './input';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement>, FieldProps {
  options: SelectOption[];
  placeholder?: string;
}

/** Native select (best on low-end phones), labelled, with error wiring. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, options, placeholder, className, id, ...rest },
  ref,
) {
  const autoId = useId();
  const selId = id ?? autoId;
  const hintId = hint ? `${selId}-hint` : undefined;
  const errId = error ? `${selId}-err` : undefined;
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={selId} className="block text-sm font-semibold">
        {label}
      </label>
      {hint && (
        <p id={hintId} className="text-sm text-ink-muted">
          {hint}
        </p>
      )}
      <div className="relative">
        <select
          ref={ref}
          id={selId}
          aria-invalid={error ? true : undefined}
          aria-describedby={[hintId, errId].filter(Boolean).join(' ') || undefined}
          className={cn(inputClass, 'appearance-none pr-10')}
          {...rest}
        >
          {placeholder && <option value="">{placeholder}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-ink-muted" />
      </div>
      {error && (
        <p id={errId} className="text-sm font-medium text-bad">
          {error}
        </p>
      )}
    </div>
  );
});
