import type { Metadata } from 'next';
import { requireActor } from '@/server/auth/current';
import { getDashboardSummary, listApplicationsForStaff } from '@/server/services';
import { RunwayCompact } from '@/components/runway';
import { Chip } from '@/components/ui/chip';
import { TableContainer, Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { todayInKampala } from '@/domain/dates';
import { applicationStatusTone, staffStatusLabel } from '@/domain/status';

export const metadata: Metadata = { title: 'Dashboard' };

/** STUB (foundation) — replaced by the staff-UI agent (filters, saved views, bulk actions). */
export default async function DashboardPage() {
  const actor = await requireActor(['dos_staff', 'dos_admin']);
  const today = todayInKampala();
  const [summary, list] = await Promise.all([getDashboardSummary(actor, today), listApplicationsForStaff(actor, { today, limit: 50 })]);
  const tiles: [string, number][] = [
    ['Needs review', summary.needsReview],
    ['Corrections pending', summary.correctionsPending],
    ['Critical / expired', summary.criticalOrExpired],
    ['Ready for immigration', summary.readyForImmigration],
    ['Fees unpaid', summary.feesUnpaid],
  ];
  return (
    <div className="space-y-6">
      <h1>Dashboard</h1>
      <ul className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {tiles.map(([label, n]) => (
          <li key={label} className="rounded-md border border-line bg-surface p-4 shadow-1">
            <p className="text-sm text-ink-muted">{label}</p>
            <p className="font-mono text-2xl font-semibold tabular">{n}</p>
          </li>
        ))}
      </ul>
      <TableContainer>
        <Table>
          <THead>
            <TR>
              <TH>Student</TH>
              <TH>Ref</TH>
              <TH>Runway</TH>
              <TH>Status</TH>
              <TH>Docs</TH>
            </TR>
          </THead>
          <TBody>
            {list.items.map((i) => (
              <TR key={i.id}>
                <TD>
                  <span className="font-semibold">{i.studentName ?? i.studentEmail}</span>
                  <span className="block text-xs text-ink-muted">{i.studentNo}</span>
                </TD>
                <TD className="font-mono">{i.ref}</TD>
                <TD>
                  <RunwayCompact summary={i.runway} />
                </TD>
                <TD>
                  <Chip tone={applicationStatusTone(i.status)}>{staffStatusLabel(i.status)}</Chip>
                </TD>
                <TD className="tabular">
                  {i.docsApproved}/{i.docsRequired}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </TableContainer>
    </div>
  );
}
