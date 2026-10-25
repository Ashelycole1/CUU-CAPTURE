'use client';
import { useRef, useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Receipt, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { inputClass } from '@/components/ui/field-styles';
import { cn } from '@/lib/cn';
import { FEE_STATUSES, formatDate, type FeeStatus } from '@/domain';
import { fmt, staffText } from '@/i18n/staff';
import { setFeeStatusAction } from '@/app/(staff)/actions';

const F = staffText.detail.fee;
const FEE_TONE = { paid: 'ok', unpaid: 'warn', not_required: 'neutral' } as const;

export interface FeePayment {
  id: string;
  amountUgx: number;
  paidOn: string;
  reference: string | null;
  hasReceipt: boolean;
}

/** FR-FEE-1/2: fee status, payments, record-payment form (with optional receipt image) and manual override. */
export function FeePanel({
  applicationId,
  feeStatus,
  feeRequired,
  feeUsd,
  payments,
  canRecord,
  today,
}: {
  applicationId: string;
  feeStatus: FeeStatus;
  feeRequired: boolean;
  feeUsd: number;
  payments: FeePayment[];
  canRecord: boolean;
  today: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setErrors({});
    setFormError(null);
    start(async () => {
      try {
        const res = await fetch(`/applications/${applicationId}/payments`, { method: 'POST', body: data, headers: { accept: 'application/json' } });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: { message?: string; fieldErrors?: Record<string, string> } } | null;
          setErrors(body?.error?.fieldErrors ?? {});
          setFormError(body?.error?.message ?? staffText.common.error);
          return;
        }
        toast({ title: F.recorded, tone: 'success' });
        formRef.current?.reset();
        setOpen(false);
        router.refresh();
      } catch {
        setFormError(staffText.common.error);
      }
    });
  };

  const setStatus = (s: FeeStatus) =>
    start(async () => {
      const r = await setFeeStatusAction(applicationId, s);
      toast(r.ok ? { title: F.statusSet, tone: 'success' } : { title: r.error.message, tone: 'error' });
      router.refresh();
    });

  return (
    <section aria-labelledby="fee-title" className="rounded-md border border-line bg-surface p-4 shadow-1">
      <div className="flex items-center justify-between gap-2">
        <h2 id="fee-title" className="flex items-center gap-2 font-sans text-base font-semibold">
          <Wallet aria-hidden className="size-4" />
          {F.title}
        </h2>
        <Chip tone={FEE_TONE[feeStatus]}>{staffText.dashboard.fees[feeStatus]}</Chip>
      </div>
      <p className="mt-1 text-sm text-ink-muted">{feeRequired ? fmt(F.amountDue, { usd: feeUsd }) : F.waived}</p>

      <h3 className="mt-3 text-xs font-semibold tracking-wide text-ink-muted uppercase">{F.payments}</h3>
      {payments.length === 0 ? (
        <p className="text-sm text-ink-muted">{F.noPayments}</p>
      ) : (
        <ul className="mt-1 space-y-1 text-sm">
          {payments.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
              <span className="tabular">
                <span className="font-mono font-semibold">UGX {p.amountUgx.toLocaleString('en-US')}</span> · {formatDate(p.paidOn)}
                {p.reference ? <span className="text-ink-muted"> · {p.reference}</span> : null}
              </span>
              {p.hasReceipt && (
                <a href={`/applications/${applicationId}/payments/${p.id}/receipt`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm">
                  <Receipt aria-hidden className="size-3.5" />
                  {F.viewReceipt}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}

      {canRecord && (
        <div className="mt-3 space-y-3">
          {!open ? (
            <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
              {F.record}
            </Button>
          ) : (
            <form ref={formRef} onSubmit={submit} className="space-y-3 rounded-sm border border-line p-3" encType="multipart/form-data" noValidate>
              {formError && (
                <p role="alert" className="text-sm font-medium text-bad">
                  {formError}
                </p>
              )}
              <Input label={F.amount} name="amountUgx" inputMode="numeric" required error={errors.amountUgx} autoFocus />
              <Input label={F.paidOn} name="paidOn" type="date" defaultValue={today} max={today} required error={errors.paidOn} />
              <Input label={F.reference} name="reference" maxLength={120} error={errors.reference} />
              <div className="space-y-1.5">
                <label htmlFor="receipt" className="block text-sm font-semibold">
                  {F.receipt}
                </label>
                <p id="receipt-hint" className="text-sm text-ink-muted">
                  {F.receiptHint}
                </p>
                <input
                  id="receipt"
                  name="receipt"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  aria-describedby="receipt-hint"
                  className="block w-full text-sm file:mr-3 file:rounded-sm file:border file:border-line file:bg-surface file:px-3 file:py-1.5"
                />
                {errors.receipt && <p className="text-sm font-medium text-bad">{errors.receipt}</p>}
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm" loading={pending}>
                  {F.record}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                  {staffText.common.cancel}
                </Button>
              </div>
            </form>
          )}
          <label className="flex items-center gap-2 text-sm">
            <span className="font-semibold">{F.setStatus}</span>
            <select
              value={feeStatus}
              disabled={pending}
              onChange={(e) => setStatus(e.target.value as FeeStatus)}
              className={cn(inputClass, 'min-h-9 w-auto py-1 text-sm')}
            >
              {FEE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {staffText.dashboard.fees[s]}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </section>
  );
}
