'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog, Input, useToast } from '@/components/ui';
import { admin as A } from '@/i18n/admin';
import { interpolate } from '@/i18n';
import { decideDeletionAction, setRetentionDaysAction } from '@/app/(admin)/actions';

export function RetentionDaysForm({ days }: { days: number }) {
  const [value, setValue] = useState(String(days));
  const [error, setError] = useState<string | undefined>();
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const res = await setRetentionDaysAction(Number(value));
          if (res.ok) {
            setError(undefined);
            toast({ title: A.retention.saved, tone: 'success' });
            router.refresh();
          } else setError(res.error.message);
        });
      }}
    >
      <Input label={A.retention.days} hint={A.retention.daysHint} type="number" min={7} max={3650} required value={value} onChange={(e) => setValue(e.target.value)} error={error} className="w-60" />
      <Button type="submit" loading={pending}>
        {A.common.save}
      </Button>
    </form>
  );
}

export function DeletionDecision({ requestId }: { requestId: string }) {
  const [confirm, setConfirm] = useState(false);
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  const decide = (d: 'approve' | 'reject') =>
    start(async () => {
      const res = await decideDeletionAction(requestId, d);
      setConfirm(false);
      toast(res.ok ? { title: interpolate(A.retention.decided, { status: res.data }), tone: 'success' } : { title: res.error.message, tone: 'error' });
      router.refresh();
    });
  return (
    <div className="flex justify-end gap-2">
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => decide('reject')}>
        {A.retention.reject}
      </Button>
      <Button size="sm" variant="danger" disabled={pending} onClick={() => setConfirm(true)}>
        {A.retention.approve}
      </Button>
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={A.retention.approve}
        description={A.retention.approveConfirm}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              {A.common.cancel}
            </Button>
            <Button variant="danger" loading={pending} onClick={() => decide('approve')}>
              {A.retention.approve}
            </Button>
          </>
        }
      />
    </div>
  );
}
