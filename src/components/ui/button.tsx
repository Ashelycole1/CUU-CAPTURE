import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Icon rendered before the label (lucide element). */
  icon?: ReactNode;
  fullWidth?: boolean;
}

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-brand-500 text-on-brand border-2 border-edge hover:-translate-y-0.5 hover:shadow-2 active:translate-y-0 active:shadow-none',
  secondary: 'bg-surface text-ink border-2 border-edge hover:-translate-y-0.5 hover:shadow-2 active:translate-y-0 active:shadow-none',
  ghost: 'bg-transparent text-ink border border-transparent hover:bg-brand-100',
  danger: 'bg-[#b42318] text-white border border-transparent hover:brightness-95',
  success: 'bg-[#1f7a52] text-white border border-transparent hover:brightness-95',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'min-h-9 px-3 text-sm gap-1.5',
  md: 'min-h-12 px-4 text-base gap-2', // ≥ 48px touch target
  lg: 'min-h-14 px-6 text-lg gap-2',
};

/** Accessible button. `loading` sets aria-busy and disables. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, icon, fullWidth, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center rounded-sm font-bold transition-[background-color,box-shadow,transform] duration-150 ease-out',
        'disabled:cursor-not-allowed disabled:opacity-60 disabled:translate-y-0 disabled:shadow-none',
        variants[variant],
        sizes[size],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 aria-hidden className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});
