import type { Metadata } from 'next';
import Link from 'next/link';
import { Flag } from 'lucide-react';
import { requireActor } from '@/server/auth/current';
import { isServiceError } from '@/server/errors';
import { getDashboardSummary, listApplicationsForStaff, listSavedViews, type StaffListResult } from '@/server/services';
import { todayInKampala } from '@/domain/dates';
import type { StaffListFilters, StaffSort } from '@/domain';
import { fmt, staffText } from '@/i18n/staff';
import { SummaryTiles } from '@/components/staff/summary-tiles';
import { DashboardFilters } from '@/components/staff/dashboard-filters';
import { SavedViews, type SavedViewItem } from '@/components/staff/saved-views';
import { ApplicationsTable, type DashboardRow } from '@/components/staff/applications-table';
import { dashboardSearch, parseDashboardParams, type RawSearchParams } from '@/components/staff/dashboard-params';

export const metadata: Metadata = { title: staffText.dashboard.title };

const PAGE_SIZE = 50;
const T = staffText.dashboard;

/**
 * FR-DOS-1/2/3. Server component: fetches ONE keyset page (50 rows, a single
 * aggregated query in listApplicationsForStaff, no N+1), the summary counts and
 * saved views in parallel. Filters/sort/cursor live in the URL.
 */
export default async function DashboardPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const actor = await requireActor(['dos_staff', 'dos_admin']);
  const { filters, sort, cursor } = parseDashboardParams(await searchParams);
  const today = todayInKampala();

  const listPage = (c: string | null): Promise<StaffListResult> => listApplicationsForStaff(actor, { filters, sort, cursor: c, limit: PAGE_SIZE, today });
  const [summary, views, list] = await Promise.all([
    getDashboardSummary(actor, today),
    listSavedViews(actor),
    listPage(cursor).catch((e: unknown) => {
      // A stale/hand-edited cursor: fall back to the first page instead of failing.
      if (isServiceError(e) && e.code === 'VALIDATION' && cursor) return listPage(null);
      throw e;
    }),
  ]);

  const now = new Date().toISOString();
  const rows: DashboardRow[] = list.items.map((i) => {
    const claimActive = !!i.claimedBy && !!i.claimedUntil && i.claimedUntil > now;
    return {
      id: i.id,
      ref: i.ref,
      status: i.status,
      studentName: i.studentName,
      studentEmail: i.studentEmail,
      studentNo: i.studentNo,
      studentType: i.studentType,
      nationality: i.nationality,
      feeStatus: i.feeStatus,
      docsRequired: i.docsRequired,
      docsApproved: i.docsApproved,
      docsPending: i.docsPending,
      docsRejected: i.docsRejected,
      lastActivityAt: i.lastActivityAt,
      claimedByMe: claimActive && i.claimedBy === actor.id,
      claimedByOther: claimActive && i.claimedBy !== actor.id,
      emailBounced: i.emailBounced,
      runway: i.runway,
    };
  });

  const savedViews: SavedViewItem[] = views.map((v) => ({
    id: v.id,
    name: v.name,
    shared: v.shared,
    canDelete: v.ownerId === actor.id || actor.role === 'dos_admin',
    filters: v.filters as StaffListFilters & { sort?: StaffSort },
  }));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1>{T.title}</h1>
          <p className="text-sm text-ink-muted">{T.subtitle}</p>
        </div>
      </div>

      <SummaryTiles
        current={filters}
        counts={{
          needsReview: summary.needsReview,
          correctionsPending: summary.correctionsPending,
          criticalOrExpired: summary.criticalOrExpired,
          readyForImmigration: summary.readyForImmigration,
          feesUnpaid: summary.feesUnpaid,
        }}
      />

      {summary.openRunwayFlags > 0 && (
        <p className="flex items-center gap-2 rounded-md border border-line bg-surface px-4 py-2 text-sm">
          <Flag aria-hidden className="size-4 text-risk-urgent" />
          {fmt(T.runwayFlags, { count: summary.openRunwayFlags })}
        </p>
      )}

      <SavedViews views={savedViews} current={{ ...filters, sort }} />
      <DashboardFilters key={JSON.stringify([filters, sort])} filters={filters} sort={sort} />

      <ApplicationsTable key={`${JSON.stringify([filters, sort])}:${cursor ?? ''}`} rows={rows} total={list.total} />

      <nav aria-label="Pagination" className="flex items-center justify-end gap-2">
        {cursor && (
          <Link href={`/dashboard${dashboardSearch(filters, sort)}`} className="inline-flex min-h-9 items-center rounded-sm border border-line bg-surface px-3 text-sm font-semibold no-underline">
            {T.firstPage}
          </Link>
        )}
        {list.nextCursor && (
          <Link
            href={`/dashboard${dashboardSearch(filters, sort, list.nextCursor)}`}
            className="inline-flex min-h-9 items-center rounded-sm border border-line bg-surface px-3 text-sm font-semibold no-underline"
          >
            {T.nextPage}
          </Link>
        )}
      </nav>
    </div>
  );
}
