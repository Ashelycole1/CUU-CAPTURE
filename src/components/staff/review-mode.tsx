'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, ChevronLeft, ChevronRight, CircleHelp, ExternalLink, Keyboard, Lock, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Dialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { inputClass } from '@/components/ui/field-styles';
import { cn } from '@/lib/cn';
import { formatDate, formatDateTime } from '@/domain';
import { fmt, staffText } from '@/i18n/staff';
import { claimAction, getReviewContextAction, releaseClaimAction, reviewDocumentAction, type ReviewContext } from '@/app/(staff)/actions';
import { DocViewer, type DocViewerHandle } from './doc-viewer';
import { ReasonPicker, type ReasonTemplateOption } from './reason-picker';
import { flagEmoji } from './dashboard-params';

const T = staffText.review;
/** Design §7.3: undo toast for 8 seconds. The decision is committed only after it. */
export const UNDO_MS = 8000;
const HEARTBEAT_MS = 60_000;
const ACTIVE_WINDOW_MS = 5 * 60_000;

export interface QueueItem {
  documentId: string;
  docCode: string;
  docName: string;
  applicationId: string;
  ref: string | null;
  studentName: string | null;
  studentNo: string | null;
  submittedAt: string | null;
  versionIds: string[];
}

type Decision = { decision: 'approve' | 'reject'; reasonCode: string | null; note: string | null; status: 'pending' | 'saving' | 'saved' };
type ClaimState = { state: 'mine' | 'other' | 'unknown'; until: string | null };

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

/**
 * FR-REV-1..6 Review Mode. Decisions are held client-side for UNDO_MS so Undo
 * never has to reverse a committed write (or an already-queued corrections
 * email); commits run strictly in order through one promise chain, and any still
 * pending are flushed immediately when the reviewer leaves the page.
 */
export function ReviewMode({
  items,
  total,
  templates,
  filter,
  appOptions,
  docOptions,
}: {
  items: QueueItem[];
  total: number;
  templates: ReasonTemplateOption[];
  filter: { app: string | null; doc: string | null };
  appOptions: { value: string; label: string }[];
  docOptions: { value: string; label: string }[];
}) {
  const router = useRouter();
  const toast = useToast();
  const viewer = useRef<DocViewerHandle>(null);
  const [index, setIndex] = useState(0);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [rejecting, setRejecting] = useState(false);
  const [help, setHelp] = useState(false);
  const [contexts, setContexts] = useState<Record<string, ReviewContext>>({});
  const [claims, setClaims] = useState<Record<string, ClaimState>>({});
  const [checks, setChecks] = useState<Record<string, boolean>>({});

  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingPayload = useRef(new Map<string, Decision & { item: QueueItem }>());
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const lastActivity = useRef(0);
  const zDown = useRef<number | null>(null);

  const item = items[index];
  const decided = item ? decisions[item.documentId] : undefined;
  const claim = item ? claims[item.applicationId] : undefined;
  const blocked = claim?.state === 'other';
  const ctx = item ? contexts[item.applicationId] : undefined;

  // ------------------------------------------------------------- commits
  const commit = useCallback(
    (documentId: string) => {
      const p = pendingPayload.current.get(documentId);
      if (!p) return;
      pendingPayload.current.delete(documentId);
      timers.current.delete(documentId);
      setDecisions((d) => (d[documentId] ? { ...d, [documentId]: { ...d[documentId]!, status: 'saving' } } : d));
      chain.current = chain.current.then(async () => {
        const r = await reviewDocumentAction({ documentId, decision: p.decision, reasonCode: p.reasonCode, note: p.note });
        if (!r.ok) {
          setDecisions((d) => {
            const { [documentId]: _drop, ...rest } = d;
            return rest;
          });
          toast({ title: fmt(T.saveFailed, { doc: p.item.docName, message: r.error.message }), tone: 'error', duration: 10000 });
          return;
        }
        setDecisions((d) => (d[documentId] ? { ...d, [documentId]: { ...d[documentId]!, status: 'saved' } } : d));
        setClaims((c) => ({ ...c, [p.item.applicationId]: { state: 'mine', until: r.result.claimedUntil } }));
        if (r.result.correctionsNotified) toast({ title: T.notified, tone: 'info' });
        else if (r.result.allDecided && r.result.status === 'under_review') toast({ title: T.allApproved, tone: 'success' });
      });
    },
    [toast],
  );

  const flushAll = useCallback(() => {
    for (const [id, t] of timers.current) {
      clearTimeout(t);
      commit(id);
    }
  }, [commit]);

  // Flush on unmount (in-app navigation) and warn on tab close while decisions are pending.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pendingPayload.current.size === 0) return;
      flushAll();
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      flushAll();
    };
  }, [flushAll]);

  // ------------------------------------------------------------- navigation
  const nextUndecided = useCallback(
    (from: number, ds: Record<string, Decision>) => {
      for (let i = from + 1; i < items.length; i++) if (!ds[items[i]!.documentId]) return i;
      for (let i = 0; i < from; i++) if (!ds[items[i]!.documentId]) return i;
      return Math.min(from + 1, items.length - 1);
    },
    [items],
  );

  const go = useCallback((i: number) => {
    setRejecting(false);
    setIndex(Math.max(0, Math.min(items.length - 1, i)));
  }, [items.length]);

  const undo = useCallback(
    (documentId: string) => {
      const t = timers.current.get(documentId);
      if (!t) return; // already committed
      clearTimeout(t);
      timers.current.delete(documentId);
      pendingPayload.current.delete(documentId);
      setDecisions((d) => {
        const { [documentId]: _drop, ...rest } = d;
        return rest;
      });
      const i = items.findIndex((x) => x.documentId === documentId);
      if (i >= 0) go(i);
      toast({ title: T.undone, tone: 'info', duration: 2500 });
    },
    [items, go, toast],
  );

  const decide = useCallback(
    (decision: 'approve' | 'reject', reasonCode: string | null = null, note: string | null = null) => {
      if (!item || blocked || decisions[item.documentId]) return;
      const d: Decision = { decision, reasonCode, note, status: 'pending' };
      const next = { ...decisions, [item.documentId]: d };
      setDecisions(next);
      pendingPayload.current.set(item.documentId, { ...d, item });
      const id = item.documentId;
      timers.current.set(
        id,
        setTimeout(() => commit(id), UNDO_MS),
      );
      toast({
        title: fmt(decision === 'approve' ? T.approvedToast : T.rejectedToast, { doc: item.docName }),
        tone: decision === 'approve' ? 'success' : 'info',
        duration: UNDO_MS,
        action: { label: T.undo, onClick: () => undo(id) },
      });
      setRejecting(false);
      go(nextUndecided(index, next));
    },
    [item, blocked, decisions, commit, toast, undo, go, nextUndecided, index],
  );

  // ------------------------------------------------------------- claims + context
  const appId = item?.applicationId;
  useEffect(() => {
    if (!appId) return;
    let cancelled = false;
    const pending = pendingPayload.current;
    lastActivity.current = Date.now();
    (async () => {
      const [c, cx] = await Promise.all([claimAction(appId), contexts[appId] ? null : getReviewContextAction(appId)]);
      if (cancelled) return;
      if (cx && cx.ok) setContexts((m) => ({ ...m, [appId]: cx.context }));
      if (c.ok) setClaims((m) => ({ ...m, [appId]: { state: 'mine', until: c.claimedUntil } }));
      else if (c.error.code === 'CONFLICT') setClaims((m) => ({ ...m, [appId]: { state: 'other', until: (c.error.details?.claimedUntil as string) ?? null } }));
      else toast({ title: `${T.claimFailed} ${c.error.message}`, tone: 'error' });
    })();
    const beat = setInterval(async () => {
      if (Date.now() - lastActivity.current > ACTIVE_WINDOW_MS) return; // claims lapse after 15 min of inactivity
      const r = await claimAction(appId);
      if (r.ok) setClaims((m) => ({ ...m, [appId]: { state: 'mine', until: r.claimedUntil } }));
    }, HEARTBEAT_MS);
    return () => {
      cancelled = true;
      clearInterval(beat);
      // Release after any pending decisions for this application have committed.
      const pendingHere = [...pending.values()].some((p) => p.item.applicationId === appId);
      if (!pendingHere) chain.current = chain.current.then(() => releaseClaimAction(appId)).catch(() => undefined);
    };
    // contexts intentionally omitted: only (re)claim when the application changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  // ------------------------------------------------------------- keys
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      lastActivity.current = Date.now();
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') {
        if (help) setHelp(false);
        else if (rejecting) setRejecting(false);
        return;
      }
      if (isTyping(e.target) || help) return;
      const k = e.key.toLowerCase();
      if (k === 'z') {
        e.preventDefault();
        if (!e.repeat) {
          zDown.current = Date.now();
          viewer.current?.setLoupe(true);
        }
        return;
      }
      if (rejecting) return; // the ReasonPicker owns Enter/Escape and typing
      if (k === 'a') {
        e.preventDefault();
        decide('approve');
      } else if (k === 'r') {
        e.preventDefault();
        if (item && !blocked && !decisions[item.documentId]) setRejecting(true);
      } else if (k === 'n') {
        e.preventDefault();
        go(index + 1);
      } else if (k === 'p') {
        e.preventDefault();
        go(index - 1);
      } else if (e.key === '?') {
        e.preventDefault();
        setHelp(true);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'z' || zDown.current === null) return;
      const held = Date.now() - zDown.current;
      zDown.current = null;
      viewer.current?.setLoupe(false);
      if (held < 250) viewer.current?.toggleZoom();
    };
    const onActivity = () => {
      lastActivity.current = Date.now();
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('pointermove', onActivity, { passive: true });
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('pointermove', onActivity);
    };
  }, [help, rejecting, decide, go, index, item, blocked, decisions]);

  const pages = useMemo(
    () =>
      (item?.versionIds ?? []).map((v, i, arr) => ({
        src: `/api/files/${v}`,
        alt: `${item?.docName ?? ''}${arr.length > 1 ? `, ${fmt(staffText.viewer.page, { n: i + 1, total: arr.length })}` : ''}`,
      })),
    [item],
  );

  const setFilter = (key: 'app' | 'doc', value: string) => {
    const p = new URLSearchParams();
    const next = { ...filter, [key]: value || null };
    if (next.app) p.set('app', next.app);
    if (next.doc) p.set('doc', next.doc);
    flushAll();
    router.push(`/review-mode${p.size ? `?${p}` : ''}`);
  };

  const doneCount = Object.keys(decisions).length;
  const checkList = (item && (staffText.checks[item.docCode] ?? staffText.checks.default)) || [];

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-paper text-ink">
      {/* Top bar: title, filters, progress, help, exit */}
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-2">
        <h1 className="font-serif text-lg">{T.title}</h1>
        <label className="flex items-center gap-1.5 text-sm">
          <span className="sr-only">{T.filterApp}</span>
          <select value={filter.app ?? ''} onChange={(e) => setFilter('app', e.target.value)} className={cn(inputClass, 'min-h-9 w-auto max-w-[16rem] py-1 text-sm')} aria-label={T.filterApp}>
            <option value="">{T.allApps}</option>
            {appOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-sm">
          <span className="sr-only">{T.filterDoc}</span>
          <select value={filter.doc ?? ''} onChange={(e) => setFilter('doc', e.target.value)} className={cn(inputClass, 'min-h-9 w-auto max-w-[14rem] py-1 text-sm')} aria-label={T.filterDoc}>
            <option value="">{T.allDocs}</option>
            {docOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {items.length > 0 && (
          <div className="flex min-w-[12rem] flex-1 items-center gap-2" aria-live="polite">
            <span className="font-mono text-sm font-semibold tabular whitespace-nowrap">{fmt(T.progress, { n: index + 1, total })}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line" aria-hidden>
              <div className="h-full bg-ok motion-safe:transition-[width]" style={{ width: `${total ? (doneCount / total) * 100 : 0}%` }} />
            </div>
          </div>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" icon={<Keyboard aria-hidden className="size-4" />} onClick={() => setHelp(true)} aria-keyshortcuts="?">
            {T.help}
          </Button>
          <Link href="/dashboard" onClick={flushAll} className="inline-flex min-h-9 items-center gap-1 rounded-sm px-3 text-sm font-semibold text-ink no-underline hover:bg-brand-100">
            <X aria-hidden className="size-4" />
            {T.exit}
          </Link>
        </div>
      </header>

      {!item ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <Check aria-hidden className="size-10 text-ok" />
          <p className="text-lg font-semibold">{T.queueEmpty}</p>
          <p className="text-sm text-ink-muted">{T.queueEmptyHint}</p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <div className="flex min-h-[50vh] flex-col lg:w-[65%]">
            <DocViewer key={item.documentId} ref={viewer} pages={pages} className="flex-1" />
          </div>

          <aside className="flex min-h-0 flex-col overflow-y-auto border-l border-line bg-surface lg:w-[35%]" aria-label={item.docName}>
            {claim?.state === 'other' && (
              <p role="status" className="flex items-start gap-2 bg-[color-mix(in_srgb,var(--warn)_14%,transparent)] px-4 py-2 text-sm font-medium">
                <Lock aria-hidden className="mt-0.5 size-4 shrink-0" />
                {fmt(T.claimOther, { time: claim.until ? formatDateTime(claim.until) : '' })}
              </p>
            )}
            {claim?.state === 'mine' && claim.until && (
              <p className="flex items-center gap-2 border-b border-line px-4 py-1.5 text-xs text-ink-muted">
                <Lock aria-hidden className="size-3" />
                {fmt(T.claimMine, { time: formatDateTime(claim.until) })}
              </p>
            )}

            <div className="space-y-4 p-4">
              <div>
                <p className="text-xs text-ink-muted">
                  <span className="font-mono">{item.ref ?? '-'}</span>
                  {item.submittedAt ? ` · ${fmt(T.submittedOn, { date: formatDateTime(item.submittedAt) })}` : ''}
                </p>
                <h2 className="text-xl">{item.docName}</h2>
                <p className="text-sm">
                  {item.studentName ?? '-'} <span className="font-mono text-ink-muted">{item.studentNo ?? ''}</span>
                </p>
                <Link href={`/applications/${item.applicationId}`} onClick={flushAll} className="mt-1 inline-flex items-center gap-1 text-sm font-semibold">
                  <ExternalLink aria-hidden className="size-3.5" />
                  {T.openDetail}
                </Link>
              </div>

              <section aria-labelledby="rv-check">
                <h3 id="rv-check" className="text-xs font-semibold tracking-wide text-ink-muted uppercase">
                  {T.checklist}
                </h3>
                <ul className="mt-1 space-y-1">
                  {checkList.map((c) => {
                    const key = `${item.documentId}:${c}`;
                    return (
                      <li key={c}>
                        <label className="flex items-start gap-2 text-sm">
                          <input type="checkbox" className="mt-0.5 size-4 accent-[var(--ok)]" checked={!!checks[key]} onChange={(e) => setChecks((m) => ({ ...m, [key]: e.target.checked }))} />
                          {c}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </section>

              <section aria-labelledby="rv-entered">
                <h3 id="rv-entered" className="text-xs font-semibold tracking-wide text-ink-muted uppercase">
                  {T.entered}
                </h3>
                {ctx ? (
                  <dl className="mt-1 grid grid-cols-[8rem_1fr] gap-x-2 gap-y-1 text-sm">
                    <dt className="text-ink-muted">{staffText.cover.name}</dt>
                    <dd className="font-semibold">{ctx.student.fullName ?? '-'}</dd>
                    <dt className="text-ink-muted">{staffText.detail.studentNo}</dt>
                    <dd className="font-mono">{ctx.student.studentNo ?? '-'}</dd>
                    <dt className="text-ink-muted">{staffText.detail.nationality}</dt>
                    <dd>
                      <span aria-hidden>{flagEmoji(ctx.student.nationality)} </span>
                      <span className="font-mono">{ctx.student.nationality ?? '-'}</span>
                    </dd>
                    <dt className="text-ink-muted">{staffText.detail.type}</dt>
                    <dd>{ctx.student.studentType ? (staffText.dashboard.types as Record<string, string>)[ctx.student.studentType] : '-'}</dd>
                    <dt className="text-ink-muted">{staffText.detail.programme}</dt>
                    <dd>{ctx.student.programme ?? '-'}</dd>
                    <dt className="text-ink-muted">{staffText.detail.currentExpiry}</dt>
                    <dd className="font-mono">{ctx.noPass ? staffText.detail.noPass : formatDate(ctx.currentExpiry)}</dd>
                    <dt className="text-ink-muted">{staffText.detail.requestedMonths}</dt>
                    <dd>{ctx.requestedMonths ? fmt(staffText.detail.months, { n: ctx.requestedMonths }) : '-'}</dd>
                  </dl>
                ) : (
                  <p className="text-sm text-ink-muted">{staffText.common.loading}</p>
                )}
              </section>

              <section className="space-y-3 border-t border-line pt-4">
                {decided ? (
                  <p className="flex items-center gap-2">
                    <Chip tone={decided.decision === 'approve' ? 'ok' : 'warn'} spinning={decided.status === 'saving'}>
                      {decided.decision === 'approve' ? T.approve : T.reject}
                    </Chip>
                    <span className="text-sm text-ink-muted">{decided.status === 'pending' ? T.decided : decided.status === 'saving' ? T.saving : ''}</span>
                    {decided.status === 'pending' && (
                      <Button size="sm" variant="ghost" onClick={() => undo(item.documentId)}>
                        {T.undo}
                      </Button>
                    )}
                  </p>
                ) : rejecting ? (
                  <ReasonPicker templates={templates} onCancel={() => setRejecting(false)} onSubmit={({ reasonCode, note }) => decide('reject', reasonCode, note)} />
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <Button variant="success" size="lg" disabled={blocked} onClick={() => decide('approve')} aria-keyshortcuts="A">
                      {T.approve} <kbd className="ml-1 rounded border border-white/40 px-1 font-mono text-xs">A</kbd>
                    </Button>
                    <Button variant="danger" size="lg" disabled={blocked} onClick={() => setRejecting(true)} aria-keyshortcuts="R">
                      {T.reject} <kbd className="ml-1 rounded border border-white/40 px-1 font-mono text-xs">R</kbd>
                    </Button>
                  </div>
                )}
                <div className="flex justify-between">
                  <Button size="sm" variant="ghost" icon={<ChevronLeft aria-hidden className="size-4" />} disabled={index === 0} onClick={() => go(index - 1)} aria-keyshortcuts="P">
                    {T.previous}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={index >= items.length - 1} onClick={() => go(index + 1)} aria-keyshortcuts="N">
                    {T.next}
                    <ChevronRight aria-hidden className="size-4" />
                  </Button>
                </div>
              </section>
            </div>
          </aside>
        </div>
      )}

      <Dialog open={help} onClose={() => setHelp(false)} title={T.help}>
        <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-2 text-sm">
          {(
            [
              ['A', T.keys.a],
              ['R', T.keys.r],
              ['Enter', T.keys.enter],
              ['N', T.keys.n],
              ['P', T.keys.p],
              ['Z', T.keys.z],
              ['+ / -', T.keys.plus],
              ['← ↑ → ↓', T.keys.arrows],
              ['[ / ]', T.keys.rotate],
              ['0', T.keys.zero],
              ['Esc', T.keys.esc],
              ['?', T.keys.help],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="contents">
              <dt>
                <kbd className="rounded border border-line bg-paper px-1.5 py-0.5 font-mono text-xs">{k}</kbd>
              </dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 flex items-center gap-1 text-xs text-ink-muted">
          <CircleHelp aria-hidden className="size-3.5" />
          {staffText.viewer.instructions}
        </p>
      </Dialog>
    </div>
  );
}
