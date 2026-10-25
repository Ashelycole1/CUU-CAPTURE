import type { Metadata } from 'next';
import { requireActor } from '@/server/auth/current';
import { getRetentionReport } from '@/server/services/admin';
import { listDeletionRequests } from '@/server/services/privacy';
import { Card, CardBody, CardHeader, Chip, Table, TableContainer, TBody, TD, TH, THead, TR } from '@/components/ui';
import { DeletionDecision, RetentionDaysForm } from '@/components/admin/retention-controls';
import { admin as A } from '@/i18n/admin';
import { interpolate } from '@/i18n';
import { formatDate, formatDateTime, todayInKampala } from '@/domain/dates';

export const metadata: Metadata = { title: 'Retention' };

/** FR-ADM-3 retention settings + dry run (same plan the nightly sweep executes), FR-AUD-3 deletion requests. */
export default async function RetentionPage() {
  const actor = await requireActor(['dos_admin']);
  const [report, requests] = await Promise.all([getRetentionReport(actor), listDeletionRequests(actor)]);
  const { plan } = report;
  return (
    <div className="space-y-6">
      <header>
        <h1>{A.retention.title}</h1>
        <p className="mt-1 max-w-3xl text-ink-muted">{A.retention.intro}</p>
      </header>

      <Card>
        <CardHeader title={A.retention.settingsHeading} />
        <CardBody>
          <RetentionDaysForm days={report.retentionDays} />
        </CardBody>
      </Card>

      <section aria-labelledby="dry-h" className="space-y-3">
        <h2 id="dry-h" className="text-xl">
          {A.retention.dryRunHeading}
        </h2>
        <p className="text-ink-muted">
          {A.retention.dryRunIntro} {interpolate(A.retention.cutoff, { date: formatDate(todayInKampala(new Date(plan.cutoff))) })}.
        </p>
        <p className="font-semibold">{interpolate(A.retention.totals, plan.totals)}</p>
        {plan.applications.length === 0 ? (
          <p className="text-ink-muted">{A.retention.nothing}</p>
        ) : (
          <TableContainer>
            <Table>
              <caption className="sr-only">{A.retention.dryRunHeading}</caption>
              <THead>
                <TR>
                  <TH>{A.retention.colRef}</TH>
                  <TH>{A.retention.colStatus}</TH>
                  <TH>{A.retention.colEnded}</TH>
                  <TH className="text-right">{A.retention.colFiles}</TH>
                  <TH className="text-right">{A.retention.colMessages}</TH>
                </TR>
              </THead>
              <TBody>
                {plan.applications.map((a) => (
                  <TR key={a.applicationId}>
                    <TD className="font-mono">{a.ref ?? a.applicationId.slice(0, 8)}</TD>
                    <TD>{a.status}</TD>
                    <TD>{formatDateTime(a.endedAt)}</TD>
                    <TD className="text-right font-mono tabular">{a.files}</TD>
                    <TD className="text-right font-mono tabular">{a.messages}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableContainer>
        )}
      </section>

      <section aria-labelledby="del-h" className="space-y-3">
        <h2 id="del-h" className="text-xl">
          {A.retention.deletionHeading}
        </h2>
        <p className="max-w-3xl text-ink-muted">{A.retention.deletionIntro}</p>
        {requests.length === 0 ? (
          <p className="text-ink-muted">{A.retention.noRequests}</p>
        ) : (
          <TableContainer>
            <Table>
              <THead>
                <TR>
                  <TH>{A.retention.colStudent}</TH>
                  <TH>{A.retention.colRequested}</TH>
                  <TH>
                    <span className="sr-only">{A.common.status}</span>
                  </TH>
                </TR>
              </THead>
              <TBody>
                {requests.map((r) => (
                  <TR key={r.id}>
                    <TD>
                      {r.fullName ?? '—'} <span className="font-mono text-sm text-ink-muted">{r.email}</span>
                    </TD>
                    <TD>{formatDateTime(r.requestedAt)}</TD>
                    <TD>
                      <DeletionDecision requestId={r.id} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableContainer>
        )}
      </section>

      <section aria-labelledby="runs-h" className="space-y-3">
        <h2 id="runs-h" className="text-xl">
          {A.retention.runsHeading}
        </h2>
        <TableContainer>
          <Table>
            <THead>
              <TR>
                <TH>{A.retention.colJob}</TH>
                <TH>{A.retention.colRun}</TH>
                <TH>{A.retention.colStarted}</TH>
                <TH>{A.retention.colResult}</TH>
                <TH className="text-right">{A.retention.colAttempts}</TH>
              </TR>
            </THead>
            <TBody>
              {report.runs.map((r) => (
                <TR key={r.id}>
                  <TD className="font-mono">{r.job}</TD>
                  <TD className="font-mono">{r.runKey}</TD>
                  <TD>{formatDateTime(r.startedAt)}</TD>
                  <TD>
                    <Chip tone={r.status === 'done' ? 'ok' : r.status === 'failed' ? 'bad' : 'warn'}>{r.status}</Chip>{' '}
                    <span className="font-mono text-xs text-ink-muted">
                      {Object.entries(r.stats)
                        .filter(([, v]) => v)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(' ')}
                    </span>
                  </TD>
                  <TD className="text-right font-mono tabular">{r.attempts}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableContainer>
      </section>
    </div>
  );
}
