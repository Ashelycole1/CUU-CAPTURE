'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { cancelAccountDeletionAction, requestAccountDeletionAction } from '@/app/(student)/actions';
import { formatDate, todayInKampala } from '@/domain/dates';
import { studentText } from '@/i18n/student';

export interface AccountDeletionProps {
  /** Latest request, if any. */
  request: { status: 'pending' | 'approved' | 'rejected' | 'completed'; requestedAt: string } | null;
  /** The active application blocks deletion (submitted or later); a draft does not. */
  blockedByActive: boolean;
  /** The only active application is an unsubmitted draft (it is withdrawn on request). */
  hasDraft: boolean;
}

/** "Your data" (FR-AUD-3, SECURITY §6): request or cancel account deletion. An admin decides. */
export function AccountDeletion({ request, blockedByActive, hasDraft }: AccountDeletionProps) {
  const a = studentText.account;
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function run(fn: () => Promise<{ ok: boolean; error?: { message: string } }>, done: string) {
    setError(null);
    start(async () => {
      const r = await fn();
      if (r.ok) {
        setOpen(false);
        toast({ title: done, tone: 'success' });
        router.refresh();
      } else {
        setError(r.error?.message ?? studentText.common.errorTitle);
      }
    });
  }

  const isPending = request?.status === 'pending' || request?.status === 'approved';

  return (
    <section aria-labelledby="account-title" className="space-y-3 rounded-md border border-line bg-surface p-4">
      <h2 id="account-title" className="text-lg">
        {a.title}
      </h2>
      {isPending ? (
        <>
          <p role="status">{a.pending.replace('{date}', formatDate(todayInKampala(new Date(request.requestedAt))))}</p>
          {request.status === 'pending' && (
            <Button variant="secondary" fullWidth loading={pending} onClick={() => run(cancelAccountDeletionAction, a.cancelled)}>
              {a.cancel}
            </Button>
          )}
        </>
      ) : (
        <>
          <p className="text-ink-muted">{a.intro}</p>
          {request?.status === 'rejected' && <p className="text-sm">{a.rejected}</p>}
          {blockedByActive ? (
            <p className="text-sm font-medium">{a.blockedActive}</p>
          ) : (
            <Button variant="danger" fullWidth onClick={() => setOpen(true)} icon={<Trash2 aria-hidden className="size-4" />}>
              {a.request}
            </Button>
          )}
        </>
      )}
      {error && !open && (
        <p role="alert" className="text-sm font-medium text-bad">
          {error}
        </p>
      )}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={a.dialogTitle}
        description={a.dialogBody}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {a.keep}
            </Button>
            <Button variant="danger" loading={pending} onClick={() => run(() => requestAccountDeletionAction(hasDraft), a.requested)}>
              {a.confirm}
            </Button>
          </>
        }
      >
        <div className="space-y-2 text-sm">
          {hasDraft && <p className="font-medium">{a.dialogDraft}</p>}
          <p className="text-ink-muted">{a.dialogKept}</p>
          {error && (
            <p role="alert" className="font-medium text-bad">
              {error}
            </p>
          )}
        </div>
      </Dialog>
    </section>
  );
}
