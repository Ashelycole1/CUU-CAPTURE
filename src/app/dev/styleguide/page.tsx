import { notFound } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Chip, RiskChip } from '@/components/ui/chip';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { Stepper } from '@/components/ui/stepper';
import { TableContainer, Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { Runway, RunwayCompact } from '@/components/runway';
import { addDays, todayInKampala } from '@/domain/dates';
import { runwaySummary } from '@/domain/rules';
import { documentStateChip } from '@/domain/status';
import { DOCUMENT_STATES, RISK_BANDS } from '@/domain/types';
import { InteractiveDemos } from './interactive';

const RULES = { applyBeforeDays: 30, penaltyUsdPerDay: 20 }; // styleguide sample data only

function Showcase() {
  const today = todayInKampala();
  const samples: [string, number | null][] = [
    ['Safe (90 days)', 90],
    ['Plan (45 days)', 45],
    ['Urgent (20 days)', 20],
    ['Critical (5 days)', 5],
    ['Expires today', 0],
    ['Expired (3 days ago)', -3],
    ['No pass', null],
  ];
  return (
    <div className="space-y-10">
      <section className="space-y-3">
        <h2>Buttons</h2>
        <div className="flex flex-wrap gap-2">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="success">Approve</Button>
          <Button variant="danger">Reject</Button>
          <Button loading>Saving</Button>
          <Button disabled>Disabled</Button>
          <Button size="sm">Small</Button>
        </div>
      </section>
      <section className="space-y-3">
        <h2>Chips</h2>
        <div className="flex flex-wrap gap-2">
          {DOCUMENT_STATES.map((s) => {
            const c = documentStateChip(s);
            return (
              <Chip key={s} tone={c.tone}>
                {c.label}
              </Chip>
            );
          })}
          <Chip tone="info" spinning>
            Checking
          </Chip>
          <Chip tone="bad">Rejected</Chip>
          <Chip tone="neutral">{documentStateChip('uploaded', false).label}</Chip>
        </div>
        <div className="flex flex-wrap gap-4">
          {RISK_BANDS.map((b) => (
            <RiskChip key={b} band={b} />
          ))}
        </div>
      </section>
      <section className="space-y-3">
        <h2>Runway</h2>
        {samples.map(([label, d]) => (
          <div key={label} className="space-y-1">
            <p className="text-sm text-ink-muted">{label}</p>
            <Runway summary={runwaySummary(d === null ? null : addDays(today, d), today, RULES)} />
          </div>
        ))}
        <h3 className="font-semibold">Compact</h3>
        <ul className="space-y-2">
          {samples.map(([label, d]) => (
            <li key={label}>
              <RunwayCompact summary={runwaySummary(d === null ? null : addDays(today, d), today, RULES)} />
            </li>
          ))}
        </ul>
      </section>
      <section className="space-y-3">
        <h2>Card, stepper, skeleton</h2>
        <Card>
          <CardHeader title="Passport data page" description="The page with your photo." action={<Chip tone="teal">Uploaded</Chip>} />
          <CardBody>
            <Stepper
              current={1}
              steps={[
                { id: 'profile', label: 'Profile' },
                { id: 'docs', label: 'Documents' },
                { id: 'review', label: 'Review' },
                { id: 'submit', label: 'Submit' },
              ]}
            />
          </CardBody>
        </Card>
        <div className="grid gap-3 sm:grid-cols-3">
          <Skeleton className="h-24" />
          <SkeletonText />
        </div>
      </section>
      <section className="space-y-3">
        <h2>Table</h2>
        <TableContainer>
          <Table>
            <THead>
              <TR>
                <TH>Student</TH>
                <TH>Ref</TH>
                <TH>Runway</TH>
              </TR>
            </THead>
            <TBody>
              <TR>
                <TD>Amani Wanjiru</TD>
                <TD className="font-mono">VD-2026-00042</TD>
                <TD>
                  <RunwayCompact summary={runwaySummary(addDays(today, 12), today, RULES)} />
                </TD>
              </TR>
            </TBody>
          </Table>
        </TableContainer>
      </section>
      <section className="space-y-3">
        <h2>Forms, dialog, toast, tabs</h2>
        <InteractiveDemos />
      </section>
    </div>
  );
}

/** /dev/styleguide renders every component in both themes. 404 in production. */
export default function StyleguidePage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <div className="space-y-8">
      <h1>Styleguide</h1>
      <div data-theme="light" className="rounded-lg border border-line bg-paper p-4 text-ink sm:p-8">
        <p className="mb-6 font-mono text-sm text-ink-muted">Light theme</p>
        <Showcase />
      </div>
      <div data-theme="dark" className="rounded-lg border border-line bg-paper p-4 text-ink sm:p-8">
        <p className="mb-6 font-mono text-sm text-ink-muted">Dark theme</p>
        <Showcase />
      </div>
    </div>
  );
}
