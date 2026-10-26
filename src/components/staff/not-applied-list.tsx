import Link from 'next/link';
import { MailX } from 'lucide-react';
import { Chip, RiskChip } from '@/components/ui/chip';
import { flagEmoji } from '@/components/staff/dashboard-params';
import { formatDate } from '@/domain/dates';
import type { RunwayFlagView } from '@/server/services/runway-flags';
import { fmt, staffText } from '@/i18n/staff';

const T = staffText.dashboard;
const N = T.notApplied;

function daysText(days: number): string {
  if (days < 0) return fmt(N.expired, { days: -days });
  if (days === 0) return N.today;
  return fmt(N.daysLeft, { days });
}

/**
 * PRD story 4 / FR-RUN-3: students with an open Runway flag (no submitted application)
 * listed at the top of the dashboard, most urgent first. Server component.
 */
export function NotAppliedList({ flags, total }: { flags: RunwayFlagView[]; total: number }) {
  if (flags.length === 0) return null;
  return (
    <section aria-labelledby="not-applied-title" className="rounded-md border border-line bg-surface p-4 shadow-1">
      <h2 id="not-applied-title" className="font-sans text-base font-semibold">
        {N.title} <span className="font-normal text-ink-muted tabular">({total})</span>
      </h2>
      <p className="text-sm text-ink-muted">{N.intro}</p>
      <ul className="mt-3 divide-y divide-line">
        {flags.map((f) => {
          const name = f.fullName ?? f.email;
          return (
            <li key={f.flagId} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
              <div className="min-w-0">
                {f.draftApplicationId ? (
                  <Link href={`/applications/${f.draftApplicationId}`} className="font-semibold" aria-label={fmt(N.openDraft, { name })}>
                    {name}
                  </Link>
                ) : (
                  <span className="font-semibold">{name}</span>
                )}
                <span className="block font-mono text-xs text-ink-muted tabular">
                  {f.studentNo ?? f.email}
                  {f.nationality && (
                    <>
                      {' · '}
                      <span aria-hidden>{flagEmoji(f.nationality)} </span>
                      {f.nationality}
                    </>
                  )}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <RiskChip band={f.band} />
                <span className="tabular">
                  {daysText(f.daysToExpiry)} <span className="text-ink-muted">({formatDate(f.expiry)})</span>
                </span>
                <Chip tone={f.draftApplicationId ? 'info' : 'neutral'} className="text-xs">
                  {f.draftApplicationId ? N.draft : N.none}
                </Chip>
                {f.emailBounced && (
                  <Chip tone="bad" icon={MailX} className="text-xs">
                    {T.unreachable}
                  </Chip>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {total > flags.length && <p className="mt-2 text-sm text-ink-muted">{fmt(N.more, { shown: flags.length, count: total })}</p>}
    </section>
  );
}
