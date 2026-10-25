import type { Metadata } from 'next';
import { requireActor } from '@/server/auth/current';
import { getAnalytics } from '@/server/services/admin';
import { BarList, ColumnChart, StatTile } from '@/components/admin/charts';
import { Card, CardBody, CardHeader, RISK_BG_CLASS, RISK_ICONS, RISK_TEXT_CLASS } from '@/components/ui';
import { riskLabel } from '@/domain/status';
import type { RiskBand } from '@/domain/types';
import { formatDate } from '@/domain/dates';
import { admin as A } from '@/i18n/admin';
import { interpolate } from '@/i18n';

export const metadata: Metadata = { title: 'Analytics' };

function duration(hours: number | null): string {
  if (hours === null) return '—';
  return hours >= 48 ? interpolate(A.analytics.days, { n: (hours / 24).toFixed(1) }) : interpolate(A.analytics.hours, { n: hours.toFixed(1) });
}

/** FR-ADM-5. Server-rendered, no chart library; every chart has a table alternative. */
export default async function AnalyticsPage() {
  const actor = await requireActor(['dos_admin']);
  const a = await getAnalytics(actor, { weeks: 12 });
  const weeks = a.submissionsPerWeek.map((w) => ({ key: w.weekStart, label: formatDate(w.weekStart).replace(/ \d{4}$/, ''), value: w.count }));
  const total = weeks.reduce((s, w) => s + w.value, 0);
  const busiest = weeks.reduce((m, w) => (w.value > m.value ? w : m), weeks[0] ?? { key: '', label: '—', value: 0 });
  const bandsTotal = a.riskBands.reduce((s, b) => s + b.count, 0);
  const rejTotal = a.rejectionReasons.reduce((s, r) => s + r.count, 0);

  return (
    <div className="space-y-6">
      <header>
        <h1>{A.analytics.title}</h1>
        <p className="mt-1 text-ink-muted">{interpolate(A.analytics.intro, { weeks: a.weeks })}</p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <StatTile
          label={A.analytics.firstPassHeading}
          value={a.firstPass.rate === null ? '—' : `${Math.round(a.firstPass.rate * 100)}%`}
          detail={interpolate(A.analytics.firstPassBody, { approved: a.firstPass.approvedFirstPass, decided: a.firstPass.decided })}
        />
        <StatTile
          label={A.analytics.reviewTimeHeading}
          value={duration(a.reviewTime.meanHours)}
          detail={interpolate(A.analytics.reviewTimeBody, { count: a.reviewTime.count, median: duration(a.reviewTime.medianHours) })}
        />
      </div>

      <Card>
        <CardHeader title={A.analytics.submissionsHeading} />
        <CardBody>
          <ColumnChart
            data={weeks}
            summary={interpolate(A.analytics.submissionsSummary, { total, weeks: a.weeks, busiest: busiest.label, max: busiest.value })}
            tableCaption={A.analytics.tableToggle}
            colLabel={A.analytics.colWeek}
            colValue={A.analytics.colCount}
          />
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={A.analytics.reasonsHeading} />
          <CardBody>
            {a.rejectionReasons.length === 0 ? (
              <p className="text-ink-muted">{A.analytics.noData}</p>
            ) : (
              <BarList
                data={a.rejectionReasons.map((r) => ({ key: r.code, label: r.label, value: r.count }))}
                summary={interpolate(A.analytics.reasonsSummary, { total: rejTotal })}
                tableCaption={A.analytics.tableToggle}
                colLabel={A.analytics.colReason}
                colValue={A.analytics.colCount}
              />
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={A.analytics.bandsHeading} />
          <CardBody>
            {bandsTotal === 0 ? (
              <p className="text-ink-muted">{A.analytics.noData}</p>
            ) : (
              <BarList
                data={a.riskBands.map((b) => ({ key: b.band, label: riskLabel(b.band), value: b.count, className: RISK_BG_CLASS[b.band] }))}
                icon={(d) => {
                  const Icon = RISK_ICONS[d.key as RiskBand];
                  return <Icon aria-hidden className={`size-4 shrink-0 ${RISK_TEXT_CLASS[d.key as RiskBand]}`} />;
                }}
                summary={interpolate(A.analytics.bandsSummary, { total: bandsTotal })}
                tableCaption={A.analytics.tableToggle}
                colLabel={A.analytics.colBand}
                colValue={A.analytics.colCount}
              />
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
