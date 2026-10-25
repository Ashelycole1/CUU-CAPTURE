'use client';
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { submitApplicationAction } from '@/app/(student)/actions';
import { interpolate } from '@/i18n';
import { studentText } from '@/i18n/student';
import { submitIssues, type Blockers } from './logic';
import { StickyBar } from './sticky-bar';

/**
 * Confirmation checkbox + Submit (FR-SUB-1/2). The button stays disabled until
 * nothing blocks submission and lists what is missing with jump links. The
 * server re-checks everything (`submitApplication`).
 */
export function ReviewSubmit({ applicationId, blockers, items }: { applicationId: string; blockers: Blockers; items: { item: { code: string; name: string } }[] }) {
  const r = studentText.review;
  const router = useRouter();
  const toast = useToast();
  const [confirmed, setConfirmed] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const issues = submitIssues(blockers, items, confirmed);
  const blocked = issues.length > 0;

  function submit() {
    setServerError(null);
    start(async () => {
      const res = await submitApplicationAction(applicationId, confirmed);
      if (res.ok) {
        toast({ title: interpolate(r.submittedToast, { ref: res.data.ref ?? '' }), tone: 'success', duration: 8000 });
        router.push('/status');
      } else {
        setServerError(res.error.message);
        router.refresh();
      }
    });
  }

  return (
    <>
      <label id="confirm" className="flex min-h-12 cursor-pointer items-start gap-3 rounded-md border border-line bg-surface p-4">
        <input type="checkbox" className="mt-0.5 size-5 shrink-0 accent-[var(--brand-500)]" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        <span className="font-medium">{r.confirm}</span>
      </label>

      {serverError && (
        <p role="alert" className="rounded-sm border border-bad p-3 text-sm font-medium text-bad">
          {serverError}
        </p>
      )}

      {blocked && (
        <section aria-labelledby="blocked-title" className="rounded-md border border-warn bg-[color-mix(in_srgb,var(--warn)_8%,var(--surface))] p-4">
          <h2 id="blocked-title" className="text-base font-semibold">
            {r.blockedTitle}
          </h2>
          <ul className="mt-2 space-y-1">
            {issues.map((i) => (
              <li key={i.key}>
                <Link href={i.href} className="inline-flex min-h-10 items-center gap-1.5 font-medium">
                  <ArrowRight aria-hidden className="size-4" />
                  {i.label}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <StickyBar>
        <Button fullWidth size="lg" disabled={blocked} loading={pending} onClick={submit} aria-describedby={blocked ? 'blocked-title' : undefined} icon={<Send aria-hidden className="size-5" />}>
          {pending ? r.submitting : r.submit}
        </Button>
      </StickyBar>
    </>
  );
}
