'use client';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { SearchX } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { BellRing, ChevronRight, Download, FolderArchive, Lock, MailX, Wallet, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Dialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { RunwayCompact } from '@/components/runway';
import { cn } from '@/lib/cn';
import { applicationStatusTone, formatDateTime, staffStatusLabel, type ApplicationStatus, type FeeStatus, type RunwaySummary, type StudentType } from '@/domain';
import { fmt, staffText } from '@/i18n/staff';
import { bulkExportPacketsAction, bulkMarkFeePaidAction, bulkRemindAction, type BulkOutcome } from '@/app/(staff)/actions';
import { flagEmoji } from './dashboard-params';

const T = staffText.dashboard;

export interface DashboardRow {
  id: string;
  ref: string | null;
  status: ApplicationStatus;
  studentName: string | null;
  studentEmail: string;
  studentNo: string | null;
  studentType: StudentType | null;
  nationality: string | null;
  feeStatus: FeeStatus;
  docsRequired: number;
  docsApproved: number;
  docsPending: number;
  docsRejected: number;
  lastActivityAt: string;
  claimedByMe: boolean;
  claimedByOther: boolean;
  emailBounced: boolean;
  runway: RunwaySummary;
}

const FEE_TONE = { paid: 'ok', unpaid: 'warn', not_required: 'neutral' } as const;

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

/**
 * FR-DOS-1/3 table: one server page of rows, row selection with a bulk-action bar,
 * keyboard `/` search, `j`/`k` move, `Enter` open, `x` select.
 */
export function ApplicationsTable({ rows, total }: { rows: DashboardRow[]; total: number }) {
  const router = useRouter();
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState(-1);
  const [pending, start] = useTransition();
  const [exported, setExported] = useState<{ applicationId: string; packetId: string; ref: string | null }[] | null>(null);
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);

  const ids = useMemo(() => rows.map((r) => r.id), [rows]);
  // The dashboard remounts this table (key) when filters/cursor change, so selection never outlives its page.

  const focusRow = useCallback((i: number) => {
    setActive(i);
    rowRefs.current[i]?.focus();
  }, []);

  const toggle = useCallback((id: string) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/' && !isTyping(e.target)) {
        e.preventDefault();
        document.getElementById('dashboard-search')?.focus();
        return;
      }
      if (isTyping(e.target) || document.querySelector('dialog[open]')) return;
      if (e.key === 'j' || e.key === 'ArrowDown') {
        if (!rows.length) return;
        e.preventDefault();
        focusRow(Math.min(rows.length - 1, active + 1));
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        if (!rows.length) return;
        e.preventDefault();
        focusRow(Math.max(0, active <= 0 ? 0 : active - 1));
      } else if (e.key === 'Enter' && active >= 0 && rowRefs.current[active] === document.activeElement) {
        e.preventDefault();
        router.push(`/applications/${rows[active]!.id}`);
      } else if (e.key === 'x' && active >= 0) {
        e.preventDefault();
        toggle(rows[active]!.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, rows, router, focusRow, toggle]);

  const selRows = rows.filter((r) => selected.has(r.id));
  const unpaid = selRows.filter((r) => r.feeStatus === 'unpaid');
  const exportable = selRows.filter((r) => r.status === 'approved' || r.status === 'sent_to_immigration');
  const allOnPage = rows.length > 0 && selected.size === rows.length;

  const report = (outcome: BulkOutcome, doneMsg: string) => {
    const parts = [fmt(doneMsg, { count: outcome.done.length })];
    if (outcome.skipped.length) parts.push(fmt(T.bulk.skipped, { count: outcome.skipped.length }));
    if (outcome.failed.length) parts.push(fmt(T.bulk.failed, { count: outcome.failed.length }));
    toast({ title: parts[0]!, description: parts.slice(1).join(' ') || undefined, tone: outcome.failed.length ? 'error' : 'success' });
  };

  const runBulk = (kind: 'remind' | 'fee' | 'export') =>
    start(async () => {
      if (kind === 'remind') {
        const r = await bulkRemindAction(selRows.map((x) => x.id));
        if (!r.ok) return toast({ title: r.error.message, tone: 'error' });
        report(r.outcome, T.bulk.remindDone);
      } else if (kind === 'fee') {
        const r = await bulkMarkFeePaidAction(unpaid.map((x) => x.id));
        if (!r.ok) return toast({ title: r.error.message, tone: 'error' });
        report(r.outcome, T.bulk.feePaidDone);
      } else {
        const r = await bulkExportPacketsAction(exportable.map((x) => x.id));
        if (!r.ok) return toast({ title: r.error.message, tone: 'error' });
        report(r.outcome, T.bulk.exportDone);
        if (r.packets.length) setExported(r.packets);
      }
      setSelected(new Set());
      router.refresh();
    });

  if (rows.length === 0) {
    return (
      <EmptyState icon={SearchX} title={T.empty} hint={T.emptyHint} />
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-ink-muted">
        <p aria-live="polite">{fmt(T.showing, { count: rows.length, total })}</p>
        <p className="hidden md:block">{T.keyboardHint}</p>
      </div>
      <div className="overflow-x-auto rounded-md border border-line bg-surface shadow-1">
        <table className="w-full min-w-[1100px] border-collapse text-sm">
          <caption className="sr-only">{T.title}</caption>
          <thead className="bg-paper text-left text-xs font-semibold tracking-wide text-ink-muted uppercase">
            <tr>
              <th scope="col" className="w-10 px-3 py-2">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--brand-500)]"
                  aria-label={T.selectAll}
                  checked={allOnPage}
                  onChange={(e) => setSelected(e.target.checked ? new Set(ids) : new Set())}
                />
              </th>
              <th scope="col" className="px-3 py-2">{T.columns.student}</th>
              <th scope="col" className="px-3 py-2">{T.columns.type}</th>
              <th scope="col" className="px-3 py-2">{T.columns.nationality}</th>
              <th scope="col" className="px-3 py-2">{T.columns.runway}</th>
              <th scope="col" className="px-3 py-2">{T.columns.status}</th>
              <th scope="col" className="px-3 py-2">{T.columns.docs}</th>
              <th scope="col" className="px-3 py-2">{T.columns.fee}</th>
              <th scope="col" className="px-3 py-2">{T.columns.activity}</th>
              <th scope="col" className="w-8 px-2 py-2">
                <span className="sr-only">{T.openColumn}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const name = r.studentName ?? r.studentEmail;
              const isSel = selected.has(r.id);
              return (
                <tr
                  key={r.id}
                  ref={(el) => {
                    rowRefs.current[i] = el;
                  }}
                  tabIndex={active === i || (active < 0 && i === 0) ? 0 : -1}
                  aria-selected={isSel}
                  onFocus={() => setActive(i)}
                  onDoubleClick={() => router.push(`/applications/${r.id}`)}
                  className={cn(
                    'group border-t border-line outline-none transition-colors duration-150 hover:bg-brand-100/50 focus-visible:bg-brand-100 focus-visible:shadow-[inset_3px_0_0_var(--brand-500)]',
                    isSel && 'bg-brand-100/70',
                  )}
                >
                  <td className="px-3 py-2.5">
                    <input
                      type="checkbox"
                      tabIndex={-1}
                      className="size-4 accent-[var(--brand-500)]"
                      aria-label={fmt(T.selectRow, { name })}
                      checked={isSel}
                      onChange={() => toggle(r.id)}
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <Link href={`/applications/${r.id}`} tabIndex={-1} className="font-semibold text-ink no-underline hover:underline">
                      {name}
                    </Link>
                    <span className="block font-mono text-xs text-ink-muted tabular">
                      {r.studentNo ?? '-'}
                      {r.ref ? ` · ${r.ref}` : ''}
                    </span>
                    <span className="mt-0.5 flex flex-wrap gap-1">
                      {r.emailBounced && (
                        <Chip tone="bad" icon={MailX} className="text-xs" >
                          <span title={T.unreachableHint}>{T.unreachable}</span>
                        </Chip>
                      )}
                      {(r.claimedByMe || r.claimedByOther) && (
                        <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
                          <Lock aria-hidden className="size-3" />
                          {r.claimedByMe ? staffText.common.you : T.claimed}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">{r.studentType ? T.types[r.studentType] : '-'}</td>
                  <td className="px-3 py-2.5">
                    {r.nationality ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span aria-hidden className="text-base leading-none">
                          {flagEmoji(r.nationality)}
                        </span>
                        <span className="font-mono">{r.nationality}</span>
                      </span>
                    ) : (
                      '-'
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <RunwayCompact summary={r.runway} />
                  </td>
                  <td className="px-3 py-2.5">
                    <Chip tone={applicationStatusTone(r.status)}>{staffStatusLabel(r.status)}</Chip>
                  </td>
                  <td className="px-3 py-2.5 tabular">
                    <span className="font-semibold">{fmt(T.docsApproved, { approved: r.docsApproved, required: r.docsRequired })}</span>
                    {(r.docsPending > 0 || r.docsRejected > 0) && (
                      <span className="block text-xs text-ink-muted">{fmt(T.docsDetail, { pending: r.docsPending, rejected: r.docsRejected })}</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <Chip tone={FEE_TONE[r.feeStatus]}>{T.fees[r.feeStatus]}</Chip>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-ink-muted tabular">{formatDateTime(r.lastActivityAt)}</td>
                  <td className="px-2 py-2.5">
                    <Link href={`/applications/${r.id}`} tabIndex={-1} aria-label={name} className="text-ink-muted">
                      <ChevronRight aria-hidden className="size-4" />
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selected.size > 0 && (
        <div role="region" aria-label={T.bulk.label} className="sticky bottom-4 z-20 mx-auto flex w-fit max-w-full flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-4 py-3 shadow-1">
          <span className="font-semibold tabular" aria-live="polite">
            {fmt(T.bulk.selected, { count: selected.size })}
          </span>
          <Button size="sm" variant="secondary" icon={<BellRing aria-hidden className="size-4" />} loading={pending} onClick={() => runBulk('remind')}>
            {T.bulk.remind}
          </Button>
          <Button size="sm" variant="secondary" icon={<Wallet aria-hidden className="size-4" />} disabled={!unpaid.length || pending} onClick={() => runBulk('fee')}>
            {T.bulk.feePaid} ({unpaid.length})
          </Button>
          <Button size="sm" variant="secondary" icon={<FolderArchive aria-hidden className="size-4" />} disabled={!exportable.length || pending} onClick={() => runBulk('export')}>
            {T.bulk.export} ({exportable.length})
          </Button>
          <Button size="sm" variant="ghost" icon={<X aria-hidden className="size-4" />} onClick={() => setSelected(new Set())}>
            {T.bulk.clear}
          </Button>
        </div>
      )}

      <Dialog open={!!exported} onClose={() => setExported(null)} title={T.bulk.exportTitle}>
        <ul className="space-y-2">
          {exported?.map((p) => (
            <li key={p.packetId}>
              <a href={`/api/packets/${p.applicationId}/${p.packetId}`} className="inline-flex items-center gap-2 font-semibold" download>
                <Download aria-hidden className="size-4" />
                {fmt(T.bulk.exportDownload, { ref: p.ref ?? p.applicationId.slice(0, 8) })}
              </a>
            </li>
          ))}
        </ul>
      </Dialog>
    </div>
  );
}
