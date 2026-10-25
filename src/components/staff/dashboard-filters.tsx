'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { inputClass } from '@/components/ui/field-styles';
import { cn } from '@/lib/cn';
import {
  APPLICATION_STATUSES,
  FEE_STATUSES,
  RISK_BANDS,
  STAFF_SORTS,
  STUDENT_TYPES,
  riskLabel,
  staffStatusLabel,
  type StaffListFilters,
  type StaffSort,
} from '@/domain';
import { staffText } from '@/i18n/staff';
import { dashboardSearch, hasActiveFilters } from './dashboard-params';

const T = staffText.dashboard;

function CheckGroup<V extends string>({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string;
  options: readonly { value: V; label: string }[];
  value: V[] | undefined;
  onChange: (v: V[] | undefined) => void;
}) {
  const set = new Set(value ?? []);
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-semibold">{legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const checked = set.has(o.value);
          return (
            <label
              key={o.value}
              className={cn(
                'inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-sm',
                checked ? 'border-brand-500 bg-brand-100 text-brand-700' : 'border-line bg-surface',
              )}
            >
              <input
                type="checkbox"
                className="size-4 accent-[var(--brand-500)]"
                checked={checked}
                onChange={(e) => {
                  const next = new Set(set);
                  if (e.target.checked) next.add(o.value);
                  else next.delete(o.value);
                  onChange(next.size ? [...next] : undefined);
                }}
              />
              {o.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Search + filters held in URL search params (FR-DOS-1). `/` focuses the search box (see the table's key handler). */
export function DashboardFilters({ filters, sort }: { filters: StaffListFilters; sort: StaffSort }) {
  const router = useRouter();
  const [q, setQ] = useState(filters.q ?? '');
  const [draft, setDraft] = useState<StaffListFilters>(filters);
  const [draftSort, setDraftSort] = useState<StaffSort>(sort);
  const [nat, setNat] = useState((filters.nationality ?? []).join(', '));
  const active = hasActiveFilters({ ...filters, q: undefined });

  const go = (f: StaffListFilters, s: StaffSort) => router.push(`/dashboard${dashboardSearch(f, s)}`);

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    go({ ...filters, q: q.trim() || undefined }, sort);
  };

  const onApply = (e: FormEvent) => {
    e.preventDefault();
    const nationality = nat
      .split(/[,\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z]{2}$/.test(s));
    go({ ...draft, q: q.trim() || undefined, nationality: nationality.length ? nationality : undefined }, draftSort);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <form role="search" onSubmit={onSearch} className="flex min-w-[16rem] flex-1 items-end gap-2">
          <div className="flex-1">
            <label htmlFor="dashboard-search" className="sr-only">
              {T.search}
            </label>
            <div className="relative">
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted" />
              <input
                id="dashboard-search"
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={T.searchPlaceholder}
                className={cn(inputClass, 'pl-9')}
                autoComplete="off"
              />
            </div>
          </div>
          <Button type="submit" variant="secondary">
            {T.search}
          </Button>
        </form>
        <label className="flex items-center gap-2 text-sm">
          <span className="font-semibold">{T.sort}</span>
          <select
            value={sort}
            onChange={(e) => go(filters, e.target.value as StaffSort)}
            className={cn(inputClass, 'w-auto min-w-[11rem]')}
            aria-label={T.sort}
          >
            {STAFF_SORTS.map((s) => (
              <option key={s} value={s}>
                {T.sorts[s]}
              </option>
            ))}
          </select>
        </label>
        {active && (
          <Button variant="ghost" icon={<X aria-hidden className="size-4" />} onClick={() => router.push(filters.q ? `/dashboard${dashboardSearch({ q: filters.q })}` : '/dashboard')}>
            {T.clearFilters}
          </Button>
        )}
      </div>

      <details className="group rounded-md border border-line bg-surface" open={false}>
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 text-sm font-semibold">
          <SlidersHorizontal aria-hidden className="size-4" />
          {T.filters}
          {active && <span className="rounded-full bg-brand-500 px-2 text-xs text-on-brand">{T.tiles.active}</span>}
        </summary>
        <form onSubmit={onApply} className="grid gap-4 border-t border-line p-4 md:grid-cols-2 xl:grid-cols-3">
          <CheckGroup
            legend={T.status}
            options={APPLICATION_STATUSES.map((s) => ({ value: s, label: staffStatusLabel(s) }))}
            value={draft.status}
            onChange={(status) => setDraft((d) => ({ ...d, status }))}
          />
          <CheckGroup
            legend={T.risk}
            options={RISK_BANDS.map((b) => ({ value: b, label: riskLabel(b) }))}
            value={draft.riskBand}
            onChange={(riskBand) => setDraft((d) => ({ ...d, riskBand }))}
          />
          <div className="space-y-4">
            <CheckGroup
              legend={T.type}
              options={STUDENT_TYPES.map((s) => ({ value: s, label: T.types[s] }))}
              value={draft.studentType}
              onChange={(studentType) => setDraft((d) => ({ ...d, studentType }))}
            />
            <CheckGroup
              legend={T.fee}
              options={FEE_STATUSES.map((s) => ({ value: s, label: T.fees[s] }))}
              value={draft.feeStatus}
              onChange={(feeStatus) => setDraft((d) => ({ ...d, feeStatus }))}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="f-nat" className="block text-sm font-semibold">
              {T.nationality}
            </label>
            <p id="f-nat-hint" className="text-sm text-ink-muted">
              {T.nationalityHint}
            </p>
            <input id="f-nat" aria-describedby="f-nat-hint" value={nat} onChange={(e) => setNat(e.target.value)} className={inputClass} autoComplete="off" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label htmlFor="f-from" className="block text-sm font-semibold">
                {T.submittedFrom}
              </label>
              <input
                id="f-from"
                type="date"
                value={draft.submittedFrom ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, submittedFrom: e.target.value || undefined }))}
                className={inputClass}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="f-to" className="block text-sm font-semibold">
                {T.submittedTo}
              </label>
              <input
                id="f-to"
                type="date"
                value={draft.submittedTo ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, submittedTo: e.target.value || undefined }))}
                className={inputClass}
              />
            </div>
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-[var(--brand-500)]"
                checked={!!draft.claimedByMe}
                onChange={(e) => setDraft((d) => ({ ...d, claimedByMe: e.target.checked || undefined }))}
              />
              {T.mine}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-[var(--brand-500)]"
                checked={!!draft.includeDrafts}
                onChange={(e) => setDraft((d) => ({ ...d, includeDrafts: e.target.checked || undefined }))}
              />
              {T.drafts}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <span className="font-semibold">{T.sort}</span>
              <select value={draftSort} onChange={(e) => setDraftSort(e.target.value as StaffSort)} className={cn(inputClass, 'w-auto')}>
                {STAFF_SORTS.map((s) => (
                  <option key={s} value={s}>
                    {T.sorts[s]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex items-end gap-2 md:col-span-2 xl:col-span-3">
            <Button type="submit">{T.apply}</Button>
            <Button
              variant="ghost"
              onClick={() => {
                setDraft({});
                setNat('');
                setDraftSort('risk');
              }}
            >
              {T.clearFilters}
            </Button>
          </div>
        </form>
      </details>
    </div>
  );
}
