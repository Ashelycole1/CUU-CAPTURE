import type { ReactNode } from 'react';
import { Ban, Check, CircleDashed, CircleHelp, Clock3, Loader2, OctagonAlert, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { ChipTone } from '@/domain/status';
import type { RiskBand } from '@/domain/types';
import { riskLabel } from '@/domain/status';

const toneClass: Record<ChipTone, string> = {
  neutral: 'text-ink-muted border-line bg-surface',
  info: 'text-info border-[color-mix(in_srgb,var(--info)_40%,transparent)] bg-[color-mix(in_srgb,var(--info)_10%,transparent)]',
  teal: 'text-teal border-[color-mix(in_srgb,var(--teal)_40%,transparent)] bg-[color-mix(in_srgb,var(--teal)_10%,transparent)]',
  warn: 'text-warn border-[color-mix(in_srgb,var(--warn)_40%,transparent)] bg-[color-mix(in_srgb,var(--warn)_10%,transparent)]',
  ok: 'text-ok border-[color-mix(in_srgb,var(--ok)_40%,transparent)] bg-[color-mix(in_srgb,var(--ok)_10%,transparent)]',
  bad: 'text-bad border-[color-mix(in_srgb,var(--bad)_40%,transparent)] bg-[color-mix(in_srgb,var(--bad)_10%,transparent)]',
};

const toneIcon: Record<ChipTone, LucideIcon> = {
  neutral: CircleDashed,
  info: Clock3,
  teal: Check,
  warn: TriangleAlert,
  ok: Check,
  bad: X,
};

export interface ChipProps {
  tone?: ChipTone;
  /** Override the default icon for the tone. `null` hides it (avoid: icon + text is the rule). */
  icon?: LucideIcon | null;
  /** Show a spinner (e.g. "Checking…"). */
  spinning?: boolean;
  children: ReactNode;
  className?: string;
}

/** Status chip: always icon + text, never colour alone (design §8). */
export function Chip({ tone = 'neutral', icon, spinning, children, className }: ChipProps) {
  const Icon = spinning ? Loader2 : icon === undefined ? toneIcon[tone] : icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-sm font-medium whitespace-nowrap',
        toneClass[tone],
        className,
      )}
    >
      {Icon && <Icon aria-hidden className={cn('size-3.5 shrink-0', spinning && 'animate-spin')} strokeWidth={2} />}
      {children}
    </span>
  );
}

export const RISK_ICONS: Record<RiskBand, LucideIcon> = {
  safe: Check,
  plan: Clock3,
  urgent: TriangleAlert,
  critical: OctagonAlert,
  expired: Ban,
  no_pass: CircleHelp,
};

export const RISK_TEXT_CLASS: Record<RiskBand, string> = {
  safe: 'text-risk-safe',
  plan: 'text-risk-plan',
  urgent: 'text-risk-urgent',
  critical: 'text-risk-critical',
  expired: 'text-risk-expired',
  no_pass: 'text-risk-nopass',
};

export const RISK_BG_CLASS: Record<RiskBand, string> = {
  safe: 'bg-risk-safe',
  plan: 'bg-risk-plan',
  urgent: 'bg-risk-urgent',
  critical: 'bg-risk-critical',
  expired: 'bg-risk-expired',
  no_pass: 'bg-risk-nopass',
};

/** Risk band chip (icon + label). */
export function RiskChip({ band, className }: { band: RiskBand; className?: string }) {
  const Icon = RISK_ICONS[band];
  return (
    <span className={cn('inline-flex items-center gap-1 text-sm font-semibold', RISK_TEXT_CLASS[band], className)}>
      <Icon aria-hidden className="size-4" strokeWidth={2} />
      {riskLabel(band)}
    </span>
  );
}
