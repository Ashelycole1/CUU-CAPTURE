import { formatDate } from '@/domain/dates';
import type { RunwaySummary } from '@/domain/rules';
import { riskLabel } from '@/domain/status';
import { en } from '@/i18n/en';
import { interpolate } from '@/i18n';
import { cn } from '@/lib/cn';
import { RISK_BG_CLASS, RISK_ICONS, RISK_TEXT_CLASS } from '@/components/ui/chip';

/**
 * Visa Runway (design §5). Server-renderable (no hooks). Pass a `RunwaySummary`
 * from `runwaySummary(expiry, todayInKampala(), ruleSet)` in `@/domain/rules`.
 *
 *  TODAY ────●──── APPLY BY ──── EXPIRY ▓▓▓ penalty zone
 *
 * Segments: runway (today→apply-by, band colour), grace (apply-by→expiry, hatched),
 * penalty zone (after expiry, red hatched; shown when expired or close). The marker
 * pulses once on load (disabled under prefers-reduced-motion).
 */
export function runwayHeadline(s: RunwaySummary): string {
  const r = en.runway;
  if (s.band === 'no_pass' || s.daysToExpiry === null) return r.headlineNoPass;
  if (s.daysToExpiry < 0) return interpolate(r.headlineExpired, { days: -s.daysToExpiry, amount: s.penaltyUsd });
  if (s.daysToExpiry === 0) return r.headlineExpiresToday;
  if ((s.daysToApplyBy ?? 0) > 0) return interpolate(r.headlineSafe, { days: s.daysToApplyBy!, date: formatDate(s.applyBy) });
  return interpolate(r.headlineApplyToday, { days: s.daysToExpiry });
}

function rel(days: number): string {
  if (days === 0) return en.runway.todayRel;
  return days > 0 ? interpolate(en.runway.inDays, { days }) : interpolate(en.runway.daysAgo, { days: -days });
}

/** Emphasise the numbers in the headline (design: "You have **15 days** to apply"). */
function Emphasised({ text }: { text: string }) {
  const parts = text.split(/(\d+ days|USD \d+)/g);
  return (
    <>
      {parts.map((p, i) => (/(\d+ days|USD \d+)/.test(p) ? <strong key={i} className="font-bold">{p}</strong> : <span key={i}>{p}</span>))}
    </>
  );
}

interface Geometry {
  runway: [number, number];
  grace: [number, number];
  penalty: [number, number] | null;
  marker: number;
  applyByPos: number;
  expiryPos: number;
}

/** Positions (0–100%) on an axis from min(today, apply-by) to after the expiry. */
export function runwayGeometry(s: RunwaySummary): Geometry | null {
  if (s.daysToExpiry === null || s.daysToApplyBy === null) return null;
  const dA = s.daysToApplyBy;
  const dE = s.daysToExpiry;
  const start = Math.min(0, dA);
  const showPenalty = dE <= 30;
  const tail = showPenalty ? Math.max(7, Math.round((Math.max(dE, 0) - start) * 0.2), dE < 0 ? -dE + 5 : 0) : 0;
  const end = Math.max(0, dE) + tail;
  const span = Math.max(1, end - start);
  const pos = (d: number) => Math.min(100, Math.max(0, ((d - start) / span) * 100));
  return {
    runway: [pos(start), pos(Math.max(dA, start))],
    grace: [pos(dA), pos(dE)],
    penalty: showPenalty ? [pos(dE), 100] : null,
    marker: pos(0),
    applyByPos: pos(dA),
    expiryPos: pos(dE),
  };
}

export interface RunwayProps {
  summary: RunwaySummary;
  className?: string;
  /** Hide the headline sentence (e.g. when the page renders its own). */
  hideHeadline?: boolean;
}

export function Runway({ summary: s, className, hideHeadline }: RunwayProps) {
  const Icon = RISK_ICONS[s.band];
  const headline = runwayHeadline(s);
  const g = runwayGeometry(s);
  return (
    <section aria-label={en.runway.label} className={cn('rounded-md border border-line bg-surface p-4 shadow-1 sm:p-5', className)}>
      {!hideHeadline && (
        <p className="flex items-start gap-2 text-base sm:text-lg">
          <Icon aria-hidden className={cn('mt-1 size-5 shrink-0', RISK_TEXT_CLASS[s.band])} strokeWidth={2} />
          <span>
            <span className={cn('mr-1 font-semibold', RISK_TEXT_CLASS[s.band])}>{riskLabel(s.band)}.</span>
            <Emphasised text={headline} />
          </span>
        </p>
      )}

      {g ? (
        <div className="mt-5" role="img" aria-label={`${riskLabel(s.band)}. ${headline} ${en.runway.applyBy} ${formatDate(s.applyBy)}. ${en.runway.expiry} ${formatDate(s.expiry)}.`}>
          <div className="relative h-4 w-full overflow-hidden rounded-full bg-line/60">
            <div className={cn('absolute inset-y-0', RISK_BG_CLASS[s.band])} style={{ left: `${g.runway[0]}%`, width: `${g.runway[1] - g.runway[0]}%` }} />
            <div className="runway-hatch absolute inset-y-0" style={{ left: `${g.grace[0]}%`, width: `${Math.max(0, g.grace[1] - g.grace[0])}%` }} />
            {g.penalty && <div className="runway-penalty absolute inset-y-0" style={{ left: `${g.penalty[0]}%`, width: `${g.penalty[1] - g.penalty[0]}%` }} />}
          </div>
          <div className="relative h-0">
            <span
              aria-hidden
              className="absolute top-[-8px] block size-5 rounded-full border-[3px] border-surface bg-ink shadow-1 motion-safe:animate-marker-pulse"
              style={{ left: `${g.marker}%`, transform: 'translate(-50%, -50%)' }}
            />
          </div>
          <div className="relative mt-3 h-12 text-xs sm:text-sm" aria-hidden>
            <Tick pos={g.marker} label={en.runway.today} value={formatDate(s.today)} align="start" />
            <Tick pos={g.applyByPos} label={en.runway.applyBy} value={formatDate(s.applyBy)} />
            <Tick pos={g.expiryPos} label={en.runway.expiry} value={formatDate(s.expiry)} align="end" />
          </div>
          {g.penalty && (
            <p className="mt-1 text-sm text-ink-muted">
              <span className="font-semibold text-risk-expired">{en.runway.penaltyZone}</span>: {interpolate(en.runway.penaltyRate, { rate: s.penaltyUsdPerDay })}
              {s.band === 'expired' && <> · {en.runway.penaltyEstimateNote}</>}
            </p>
          )}
        </div>
      ) : (
        <div className="mt-4 h-4 w-full rounded-full bg-line/60" aria-hidden />
      )}
    </section>
  );
}

function Tick({ pos, label, value, align }: { pos: number; label: string; value: string; align?: 'start' | 'end' }) {
  // Keep labels on-screen near the edges.
  const shift = align === 'start' || pos < 12 ? '0%' : align === 'end' || pos > 88 ? '-100%' : '-50%';
  const textAlign = shift === '0%' ? 'text-left' : shift === '-100%' ? 'text-right' : 'text-center';
  return (
    <span className={cn('absolute top-0 whitespace-nowrap', textAlign)} style={{ left: `${pos}%`, transform: `translateX(${shift})` }}>
      <span className="block font-semibold tracking-wide text-ink-muted uppercase">{label}</span>
      <span className="block font-mono tabular">{value}</span>
    </span>
  );
}

/** 120px bar + dot for the staff table (design §5). Details in title + sr-only text. */
export function RunwayCompact({ summary: s, className }: { summary: RunwaySummary; className?: string }) {
  const Icon = RISK_ICONS[s.band];
  const g = runwayGeometry(s);
  const text = s.expiry
    ? interpolate(en.runway.compactSummary, { band: riskLabel(s.band), date: formatDate(s.expiry), rel: rel(s.daysToExpiry ?? 0) })
    : riskLabel(s.band);
  return (
    <span className={cn('inline-flex items-center gap-2', className)} title={text}>
      <Icon aria-hidden className={cn('size-4 shrink-0', RISK_TEXT_CLASS[s.band])} strokeWidth={2} />
      <span aria-hidden className="relative block h-2 w-[120px] rounded-full bg-line">
        {g && (
          <>
            <span className={cn('absolute inset-y-0 rounded-l-full', RISK_BG_CLASS[s.band])} style={{ left: 0, width: `${g.applyByPos}%` }} />
            {g.penalty && <span className="runway-penalty absolute inset-y-0 rounded-r-full" style={{ left: `${g.penalty[0]}%`, right: 0 }} />}
            <span className="absolute top-1/2 block size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-ink" style={{ left: `${g.marker}%` }} />
          </>
        )}
      </span>
      <span className="sr-only">{text}</span>
      <span aria-hidden className="font-mono text-xs tabular text-ink-muted">
        {s.daysToExpiry === null ? '—' : `${s.daysToExpiry}d`}
      </span>
    </span>
  );
}
