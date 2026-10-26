'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Archive, BadgeCheck, CalendarCheck, Lock, LockOpen, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { SENT_METHODS, formatDateTime, type ApplicationStatus, type SentMethod } from '@/domain';
import { fmt, staffText } from '@/i18n/staff';
import {
  approveApplicationAction,
  claimAction,
  closeApplicationAction,
  markSentAction,
  recordPassIssuedAction,
  releaseClaimAction,
  type ActionResult,
} from '@/app/(staff)/actions';

const A = staffText.detail.actions;
const C = staffText.detail.claim;

function useRun() {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ActionResult>, success: string, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) {
        toast({ title: r.error.message, tone: 'error' });
        return;
      }
      toast({ title: success, tone: 'success' });
      after?.();
      router.refresh();
    });
  return { pending, run };
}

/** FR-PKT-3: date + method. Shared by the actions panel and PacketPreview. */
export function MarkSentButton({ applicationId, today, size = 'md' }: { applicationId: string; today: string; size?: 'sm' | 'md' }) {
  const [open, setOpen] = useState(false);
  const [sentOn, setSentOn] = useState(today);
  const [method, setMethod] = useState<SentMethod>('email');
  const { pending, run } = useRun();
  return (
    <>
      <Button size={size} icon={<Send aria-hidden className="size-4" />} onClick={() => setOpen(true)}>
        {A.markSent}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={A.markSent}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {staffText.common.cancel}
            </Button>
            <Button loading={pending} onClick={() => run(() => markSentAction(applicationId, { method, sentOn }), A.sent, () => setOpen(false))}>
              {A.markSent}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input label={A.sentOn} type="date" value={sentOn} max={today} onChange={(e) => setSentOn(e.target.value)} />
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">{A.method}</legend>
            {SENT_METHODS.map((m) => (
              <label key={m} className="flex items-center gap-2 text-sm">
                <input type="radio" name="sent-method" value={m} checked={method === m} onChange={() => setMethod(m)} className="size-4 accent-[var(--brand-500)]" />
                {A.methods[m]}
              </label>
            ))}
          </fieldset>
        </div>
      </Dialog>
    </>
  );
}

function PassIssuedButton({ applicationId }: { applicationId: string }) {
  const [open, setOpen] = useState(false);
  const [newExpiry, setNewExpiry] = useState('');
  const { pending, run } = useRun();
  return (
    <>
      <Button variant="success" icon={<CalendarCheck aria-hidden className="size-4" />} onClick={() => setOpen(true)}>
        {A.passIssued}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={A.passIssued}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {staffText.common.cancel}
            </Button>
            <Button
              variant="success"
              loading={pending}
              disabled={!newExpiry}
              onClick={() => run(() => recordPassIssuedAction(applicationId, { newExpiry }), A.passRecorded, () => setOpen(false))}
            >
              {A.passIssued}
            </Button>
          </>
        }
      >
        <Input label={A.newExpiry} type="date" value={newExpiry} onChange={(e) => setNewExpiry(e.target.value)} required />
      </Dialog>
    </>
  );
}

function CloseButton({ applicationId }: { applicationId: string }) {
  const [open, setOpen] = useState(false);
  const { pending, run } = useRun();
  return (
    <>
      <Button variant="secondary" icon={<Archive aria-hidden className="size-4" />} onClick={() => setOpen(true)}>
        {A.close}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={A.close}
        description={A.closeConfirm}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {staffText.common.cancel}
            </Button>
            <Button loading={pending} onClick={() => run(() => closeApplicationAction(applicationId), A.closed, () => setOpen(false))}>
              {A.close}
            </Button>
          </>
        }
      />
    </>
  );
}

export interface ClaimInfo {
  mine: boolean;
  other: boolean;
  until: string | null;
  /** Display name of the other reviewer (getProfileNames), if known. */
  byName?: string | null;
}

/** Claim banner + claim/release (FR-REV-6) for reviewable applications. */
export function ClaimControl({ applicationId, claim }: { applicationId: string; claim: ClaimInfo }) {
  const { pending, run } = useRun();
  const time = claim.until ? formatDateTime(claim.until) : '';
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-paper px-3 py-2 text-sm">
      <p className="flex items-center gap-2">
        {claim.mine || claim.other ? <Lock aria-hidden className="size-4" /> : <LockOpen aria-hidden className="size-4" />}
        {claim.mine ? fmt(C.mine, { time }) : claim.other ? (claim.byName ? fmt(C.otherNamed, { name: claim.byName, time }) : fmt(C.other, { time })) : C.none}
      </p>
      {claim.mine ? (
        <Button size="sm" variant="ghost" loading={pending} onClick={() => run(() => releaseClaimAction(applicationId), C.release)}>
          {C.release}
        </Button>
      ) : (
        !claim.other && (
          <Button size="sm" variant="secondary" loading={pending} onClick={() => run(() => claimAction(applicationId), C.claim)}>
            {C.claim}
          </Button>
        )
      )}
    </div>
  );
}

/** Lifecycle actions for the current status (FR-REV approve, FR-PKT-3/4, close). */
export function ApplicationActions({
  applicationId,
  status,
  allApproved,
  today,
}: {
  applicationId: string;
  status: ApplicationStatus;
  allApproved: boolean;
  today: string;
}) {
  const { pending, run } = useRun();
  const buttons: React.ReactNode[] = [];
  if (status === 'under_review') {
    buttons.push(
      <div key="approve" className="space-y-1">
        <Button
          variant="success"
          icon={<BadgeCheck aria-hidden className="size-4" />}
          disabled={!allApproved}
          loading={pending}
          aria-describedby={!allApproved ? 'approve-hint' : undefined}
          onClick={() => run(() => approveApplicationAction(applicationId), A.approved)}
        >
          {A.approve}
        </Button>
        {!allApproved && (
          <p id="approve-hint" className="text-xs text-ink-muted">
            {A.approveHint}
          </p>
        )}
      </div>,
    );
  }
  if (status === 'approved') buttons.push(<MarkSentButton key="sent" applicationId={applicationId} today={today} />);
  if (status === 'sent_to_immigration') buttons.push(<PassIssuedButton key="pass" applicationId={applicationId} />);
  if (status === 'sent_to_immigration' || status === 'pass_issued') buttons.push(<CloseButton key="close" applicationId={applicationId} />);

  return (
    <section aria-labelledby="actions-title" className="space-y-2">
      <h2 id="actions-title" className="sr-only">
        {A.title}
      </h2>
      {buttons.length ? <div className="flex flex-wrap items-start gap-2">{buttons}</div> : <p className="text-sm text-ink-muted">{A.nothing}</p>}
      {['draft', 'submitted', 'under_review', 'corrections_needed'].includes(status) && <p className="text-xs text-ink-muted">{A.withdrawNote}</p>}
    </section>
  );
}
