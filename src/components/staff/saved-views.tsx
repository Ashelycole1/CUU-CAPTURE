'use client';
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bookmark, BookmarkPlus, Trash2, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import type { StaffListFilters, StaffSort } from '@/domain';
import { staffText } from '@/i18n/staff';
import { createSavedViewAction, deleteSavedViewAction } from '@/app/(staff)/actions';
import { dashboardSearch, hasActiveFilters, sameFilters } from './dashboard-params';

const T = staffText.dashboard;

export interface SavedViewItem {
  id: string;
  name: string;
  shared: boolean;
  canDelete: boolean;
  filters: StaffListFilters & { sort?: StaffSort };
}

/** Built-in presets (design §7.1) shown before the user's own views. */
const PRESETS: { id: string; name: string; filters: StaffListFilters & { sort?: StaffSort } }[] = [
  { id: 'preset-urgent', name: T.presets.urgent, filters: { riskBand: ['expired', 'critical'] } },
  { id: 'preset-mine', name: T.presets.mine, filters: { claimedByMe: true } },
  { id: 'preset-approved', name: T.presets.approved, filters: { status: ['approved'] } },
];

/** FR-DOS-1 saved views: apply (link), save current, delete own (admins: any). */
export function SavedViews({ views, current }: { views: SavedViewItem[]; current: StaffListFilters & { sort?: StaffSort } }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [pending, start] = useTransition();
  const canSave = hasActiveFilters(current) || (current.sort && current.sort !== 'risk');

  const save = () =>
    start(async () => {
      const r = await createSavedViewAction({ name, filters: current, shared });
      if (!r.ok) {
        setError(r.error.fieldErrors?.name ?? r.error.message);
        return;
      }
      setOpen(false);
      setName('');
      setShared(false);
      toast({ title: T.viewSaved, tone: 'success' });
      router.refresh();
    });

  const remove = (id: string) =>
    start(async () => {
      const r = await deleteSavedViewAction(id);
      toast(r.ok ? { title: T.viewDeleted, tone: 'success' } : { title: r.error.message, tone: 'error' });
      router.refresh();
    });

  const pill = (id: string, label: string, filters: StaffListFilters & { sort?: StaffSort }, extra?: React.ReactNode) => {
    const active = sameFilters(current, filters);
    return (
      <li key={id} className="flex items-center">
        <Link
          href={`/dashboard${dashboardSearch(filters)}`}
          aria-current={active ? 'true' : undefined}
          className={cn(
            'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-sm no-underline',
            active ? 'border-brand-500 bg-brand-100 font-semibold text-brand-700' : 'border-line bg-surface text-ink hover:border-brand-500',
          )}
        >
          <Bookmark aria-hidden className="size-3.5" />
          {label}
        </Link>
        {extra}
      </li>
    );
  };

  return (
    <section aria-label={T.savedViews} className="flex flex-wrap items-center gap-2">
      <h2 className="sr-only">{T.savedViews}</h2>
      <ul className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => pill(p.id, p.name, p.filters))}
        {views.map((v) =>
          pill(
            v.id,
            v.name,
            v.filters,
            <>
              {v.shared && (
                <span className="ml-1 inline-flex items-center gap-0.5 text-xs text-ink-muted">
                  <Users aria-hidden className="size-3" />
                  {T.sharedTag}
                </span>
              )}
              {v.canDelete && (
                <button
                  type="button"
                  onClick={() => remove(v.id)}
                  disabled={pending}
                  className="ml-0.5 rounded-sm p-1.5 text-ink-muted hover:bg-brand-100 hover:text-bad"
                  aria-label={`${T.deleteView}: ${v.name}`}
                >
                  <Trash2 aria-hidden className="size-3.5" />
                </button>
              )}
            </>,
          ),
        )}
      </ul>
      <Button size="sm" variant="ghost" icon={<BookmarkPlus aria-hidden className="size-4" />} disabled={!canSave} onClick={() => setOpen(true)}>
        {T.saveView}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={T.saveViewTitle}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {staffText.common.cancel}
            </Button>
            <Button onClick={save} loading={pending} disabled={!name.trim()}>
              {staffText.common.save}
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) save();
          }}
          className="space-y-3"
        >
          <Input label={T.saveViewName} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} error={error} autoFocus />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-[var(--brand-500)]" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            {T.saveViewShared}
          </label>
        </form>
      </Dialog>
    </section>
  );
}
