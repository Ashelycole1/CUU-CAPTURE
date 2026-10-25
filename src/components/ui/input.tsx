'use client';
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { inputClass } from './field-styles';

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement>, FieldProps {}


/** Labelled text input; hint and error are tied with aria-describedby (design §10). */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ label, hint, error, className, id, ...rest }, ref) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errId = error ? `${inputId}-err` : undefined;
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={inputId} className="block text-sm font-semibold">
        {label}
      </label>
      {hint && (
        <p id={hintId} className="text-sm text-ink-muted">
          {hint}
        </p>
      )}
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errId].filter(Boolean).join(' ') || undefined}
        className={inputClass}
        {...rest}
      />
      {error && (
        <p id={errId} className="text-sm font-medium text-bad">
          {error}
        </p>
      )}
    </div>
  );
});
