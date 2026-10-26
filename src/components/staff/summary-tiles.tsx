import Link from 'next/link';
import { CircleCheckBig, ClipboardList, FileWarning, OctagonAlert, Wallet, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { StaffListFilters } from '@/domain';
import { staffText } from '@/i18n/staff';
import { dashboardSearch, sameFilters, TILE_FILTERS, type TileKey } from './dashboard-params';

const TILES: { key: TileKey; icon: LucideIcon; tone: string; tint: string }[] = [
  { key: 'needsReview', icon: ClipboardList, tone: 'text-info', tint: 'var(--info)' },
  { key: 'correctionsPending', icon: FileWarning, tone: 'text-warn', tint: 'var(--warn)' },
  { key: 'criticalOrExpired', icon: OctagonAlert, tone: 'text-risk-critical', tint: 'var(--risk-critical)' },
  { key: 'readyForImmigration', icon: CircleCheckBig, tone: 'text-ok', tint: 'var(--ok)' },
  { key: 'feesUnpaid', icon: Wallet, tone: 'text-grey dark:text-ink-muted', tint: 'var(--grey)' },
];

/** FR-DOS-2: five summary tiles; each is a link that applies its filter (click again to clear). */
export function SummaryTiles({ counts, current }: { counts: Record<TileKey, number>; current: StaffListFilters }) {
  return (
    <section aria-label={staffText.dashboard.tiles.label}>
      <ul className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {TILES.map(({ key, icon: Icon, tone, tint }) => {
          const active = sameFilters(current, TILE_FILTERS[key]);
          return (
            <li key={key}>
              <Link
                href={active ? '/dashboard' : `/dashboard${dashboardSearch(TILE_FILTERS[key])}`}
                aria-current={active ? 'true' : undefined}
                title={staffText.dashboard.tiles.filterHint}
                style={{ '--tint': tint } as React.CSSProperties}
                className={cn(
                  'relative block rounded-md border-2 bg-[color-mix(in_srgb,var(--tint)_9%,var(--surface))] p-4 text-ink no-underline transition-[box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:shadow-2',
                  active ? 'border-edge shadow-2' : 'border-edge/80',
                )}
              >
                <span className="flex items-center gap-2 text-sm font-semibold text-ink-muted">
                  <span aria-hidden className="inline-flex size-8 items-center justify-center rounded-full border-2 border-edge bg-surface">
                    <Icon className={cn('size-4', tone)} />
                  </span>
                  {staffText.dashboard.tiles[key]}
                </span>
                <span className="mt-2 block font-serif text-4xl font-extrabold tabular">{counts[key]}</span>
                {active && <span className="text-xs font-semibold text-brand-500">{staffText.dashboard.tiles.active}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
