import type { Metadata } from 'next';
import Link from 'next/link';
import { Download, ShieldAlert, ShieldCheck } from 'lucide-react';
import { requireActor } from '@/server/auth/current';
import { getAuditChainStatus, listAuditActions, listAuditLog, type AuditFilters } from '@/server/services/admin';
import { auditFiltersFrom as filtersFrom } from '@/components/admin/audit-filters';
import { inputClass, Table, TableContainer, TBody, TD, TH, THead, TR } from '@/components/ui';
import { admin as A } from '@/i18n/admin';
import { interpolate } from '@/i18n';
import { formatDateTime } from '@/domain/dates';

export const metadata: Metadata = { title: 'Audit log' };

type SP = Promise<Record<string, string | string[] | undefined>>;

function qs(f: AuditFilters, extra: Record<string, string | number | undefined> = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ action: f.action, actor: f.actor, targetType: f.targetType, targetId: f.targetId, from: f.from, to: f.to, ...extra })) {
    if (v !== undefined && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** FR-ADM-4 / FR-AUD-1: filterable viewer, chain verification, CSV export. */
export default async function AuditPage({ searchParams }: { searchParams: SP }) {
  const actor = await requireActor(['dos_admin']);
  const f = filtersFrom(await searchParams);
  const [chain, actions, page] = await Promise.all([getAuditChainStatus(actor), listAuditActions(actor), listAuditLog(actor, { ...f, limit: 50 })]);
  const field = (name: keyof AuditFilters, label: string, type = 'text') => (
    <div className="space-y-1">
      <label htmlFor={`f-${name}`} className="block text-sm font-semibold">
        {label}
      </label>
      <input id={`f-${name}`} name={name} type={type} defaultValue={(f[name] as string | undefined) ?? ''} className={inputClass} />
    </div>
  );

  return (
    <div className="space-y-6">
      <header>
        <h1>{A.audit.title}</h1>
        <p className="mt-1 max-w-3xl text-ink-muted">{A.audit.intro}</p>
      </header>

      <div role="status" className={`flex items-start gap-2 rounded-md border p-4 ${chain.ok ? 'border-ok text-ok' : 'border-bad text-bad'}`}>
        {chain.ok ? <ShieldCheck aria-hidden className="mt-0.5 size-5 shrink-0" /> : <ShieldAlert aria-hidden className="mt-0.5 size-5 shrink-0" />}
        <p className="font-semibold">
          {chain.ok
            ? interpolate(A.audit.chainOk, { count: chain.checked })
            : interpolate(A.audit.chainBroken, { id: chain.brokenAtId ?? '?', reason: chain.reason ?? '' })}
        </p>
      </div>

      <form method="get" className="grid gap-3 rounded-md border border-line bg-surface p-4 sm:grid-cols-2 lg:grid-cols-4" aria-label={A.audit.filters}>
        <div className="space-y-1">
          <label htmlFor="f-action" className="block text-sm font-semibold">
            {A.audit.action}
          </label>
          <select id="f-action" name="action" defaultValue={f.action ?? ''} className={inputClass}>
            <option value="">{A.audit.allActions}</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        {field('actor', A.audit.actor)}
        {field('targetType', A.audit.targetType)}
        {field('targetId', A.audit.targetId)}
        {field('from', A.audit.from, 'date')}
        {field('to', A.audit.to, 'date')}
        <div className="flex items-end gap-2 lg:col-span-2">
          <button type="submit" className="min-h-12 rounded-sm bg-brand-500 px-4 font-semibold text-on-brand hover:bg-brand-700">
            {A.common.filter}
          </button>
          <Link href="/audit" className="inline-flex min-h-12 items-center rounded-sm border border-line px-4 font-semibold text-ink no-underline hover:bg-brand-100">
            {A.common.clear}
          </Link>
          <a
            href={`/audit/export${qs(f)}`}
            className="ml-auto inline-flex min-h-12 items-center gap-2 rounded-sm border border-line px-4 font-semibold text-ink no-underline hover:bg-brand-100"
          >
            <Download aria-hidden className="size-4" />
            {A.audit.exportCsv}
          </a>
        </div>
      </form>

      <p className="text-sm text-ink-muted" aria-live="polite">
        {interpolate(A.audit.showing, { count: page.rows.length })}
      </p>
      <TableContainer>
        <Table>
          <caption className="sr-only">{A.audit.title}</caption>
          <THead>
            <TR>
              <TH>{A.audit.colId}</TH>
              <TH>{A.audit.colAt}</TH>
              <TH>{A.audit.colActor}</TH>
              <TH>{A.audit.colAction}</TH>
              <TH>{A.audit.colTarget}</TH>
              <TH>{A.audit.colMeta}</TH>
              <TH>{A.audit.colHash}</TH>
            </TR>
          </THead>
          <TBody>
            {page.rows.map((r) => (
              <TR key={r.id} className={chain.brokenAtId === r.id ? 'bg-[color-mix(in_srgb,var(--bad)_10%,transparent)]' : undefined}>
                <TD className="font-mono tabular">{r.id}</TD>
                <TD className="whitespace-nowrap">{formatDateTime(r.at)}</TD>
                <TD className="text-sm">{r.actorId ? r.actorLabel : A.audit.system}</TD>
                <TD className="font-mono text-sm">{r.action}</TD>
                <TD className="font-mono text-xs">
                  {r.targetType}
                  {r.targetId ? `:${r.targetId.slice(0, 12)}` : ''}
                </TD>
                <TD className="max-w-xs truncate font-mono text-xs" title={r.meta}>
                  {r.meta}
                </TD>
                <TD className="font-mono text-xs" title={r.hash}>
                  {r.hash.slice(0, 10)}…
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </TableContainer>
      <nav aria-label="Pagination" className="flex justify-between">
        {f.beforeId ? (
          <Link href={`/audit${qs(f)}`} className="font-semibold">
            {A.common.prev}
          </Link>
        ) : (
          <span />
        )}
        {page.nextBeforeId && (
          <Link href={`/audit${qs(f, { before: page.nextBeforeId })}`} className="font-semibold">
            {A.common.next}
          </Link>
        )}
      </nav>
    </div>
  );
}
