import Link from 'next/link';
import { CircleCheckBig, ClipboardList, FileWarning, OctagonAlert, Wallet, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { StaffListFilters } from '@/domain';
import { staffText } from '@/i18n/staff';
import { dashboardSearch, sameFilters, TILE_FILTERS, type TileKey } from './dashboard-params';

const TILES: { key: TileKey; icon: LucideIcon; tone: string }[] = [
  { key: 'needsReview', icon: ClipboardList, tone: 'text-info' },
  { key: 'correctionsPending', icon: FileWarning, tone: 'text-warn' },
  { key: 'criticalOrExpired', icon: OctagonAlert, tone: 'text-risk-critical' },
  { key: 'readyForImmigration', icon: CircleCheckBig, tone: 'text-ok' },
  { key: 'feesUnpaid', icon: Wallet, tone: 'text-ink-muted' },
];

/** FR-DOS-2: five summary tiles; each is a link that applies its filter (click again to clear). */
export function SummaryTiles({ counts, current }: { counts: Record<TileKey, number>; current: StaffListFilters }) {
  return (
    <section aria-label={staffText.dashboard.tiles.label}>
      <ul className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {TILES.map(({ key, icon: Icon, tone }) => {
          const active = sameFilters(current, TILE_FILTERS[key]);
          return (
            <li key={key}>
              <Link
                href={active ? '/dashboard' : `/dashboard${dashboardSearch(TILE_FILTERS[key])}`}
                aria-current={active ? 'true' : undefined}
                title={staffText.dashboard.tiles.filterHint}
                className={cn(
                  'block rounded-md border bg-surface p-4 text-ink no-underline shadow-1 transition-colors duration-150 hover:border-brand-500',
                  active ? 'border-brand-500 ring-2 ring-brand-500/30' : 'border-line',
                )}
              >
                <span className="flex items-center gap-2 text-sm text-ink-muted">
                  <Icon aria-hidden className={cn('size-4', tone)} />
                  {staffText.dashboard.tiles[key]}
                </span>
                <span className="mt-1 block font-mono text-3xl font-semibold tabular">{counts[key]}</span>
                {active && <span className="text-xs font-semibold text-brand-500">{staffText.dashboard.tiles.active}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
