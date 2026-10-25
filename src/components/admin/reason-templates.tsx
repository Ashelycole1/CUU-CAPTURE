'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Save } from 'lucide-react';
import { Button, inputClass, useToast } from '@/components/ui';
import { admin as A } from '@/i18n/admin';
import { saveReasonTemplateAction } from '@/app/(admin)/actions';

export interface ReasonRow {
  code: string;
  label: string;
  body: string;
  active: boolean;
  sort: number;
}

function ReasonForm({ row, isNew, onDone }: { row: ReasonRow; isNew: boolean; onDone?: () => void }) {
  const [v, setV] = useState(row);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const router = useRouter();
  const id = `rt-${isNew ? 'new' : row.code}`;
  return (
    <form
      className="grid gap-3 rounded-md border border-line bg-surface p-4 md:grid-cols-[10rem_1fr_2fr_5rem_auto_auto] md:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const res = await saveReasonTemplateAction(v);
          if (res.ok) {
            setError(null);
            toast({ title: A.templates.saved, tone: 'success' });
            router.refresh();
            onDone?.();
          } else {
            setError(res.error.message);
            toast({ title: res.error.message, tone: 'error' });
          }
        });
      }}
      aria-describedby={error ? `${id}-err` : undefined}
    >
      <div className="space-y-1">
        <label htmlFor={`${id}-code`} className="block text-sm font-semibold">
          {A.templates.code}
        </label>
        <input id={`${id}-code`} className={`${inputClass} font-mono`} value={v.code} readOnly={!isNew} onChange={(e) => setV({ ...v, code: e.target.value.trim() })} required />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-label`} className="block text-sm font-semibold">
          {A.templates.label}
        </label>
        <input id={`${id}-label`} className={inputClass} value={v.label} onChange={(e) => setV({ ...v, label: e.target.value })} required />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-body`} className="block text-sm font-semibold">
          {A.templates.body}
        </label>
        <input id={`${id}-body`} className={inputClass} value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-sort`} className="block text-sm font-semibold">
          {A.templates.sort}
        </label>
        <input id={`${id}-sort`} type="number" min={0} className={inputClass} value={v.sort} onChange={(e) => setV({ ...v, sort: Number(e.target.value) })} />
      </div>
      <label className="inline-flex min-h-12 items-center gap-2 text-sm font-semibold">
        <input type="checkbox" className="size-5" checked={v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} />
        {A.templates.active}
      </label>
      <Button type="submit" variant="secondary" loading={pending} icon={<Save aria-hidden className="size-4" />}>
        {A.common.save}
      </Button>
      {error && (
        <p id={`${id}-err`} className="text-sm font-medium text-bad md:col-span-6">
          {error}
        </p>
      )}
    </form>
  );
}

export function ReasonTemplates({ rows }: { rows: ReasonRow[] }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <ReasonForm key={r.code} row={r} isNew={false} />
      ))}
      {adding ? (
        <ReasonForm row={{ code: '', label: '', body: '', active: true, sort: (rows.at(-1)?.sort ?? 0) + 1 }} isNew onDone={() => setAdding(false)} />
      ) : (
        <Button variant="secondary" icon={<Plus aria-hidden className="size-4" />} onClick={() => setAdding(true)}>
          {A.templates.add}
        </Button>
      )}
    </div>
  );
}
