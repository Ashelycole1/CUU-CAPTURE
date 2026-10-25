import type { Metadata } from 'next';
import { requireActor } from '@/server/auth/current';
import { listAllReasonTemplates } from '@/server/services/admin';
import { NOTIFICATION_KINDS, renderEmail } from '@/server/notify';
import { config } from '@/server/config';
import { ReasonTemplates } from '@/components/admin/reason-templates';
import { admin as A } from '@/i18n/admin';
import { addDays, todayInKampala } from '@/domain/dates';

export const metadata: Metadata = { title: 'Templates' };

/** FR-ADM-2: reason templates (editable) and email previews (copy is versioned in src/i18n/jobs.ts). */
export default async function TemplatesPage() {
  const actor = await requireActor(['dos_admin']);
  const reasons = await listAllReasonTemplates(actor);
  const c = config();
  const today = todayInKampala();
  const expiry = addDays(today, 30);
  const sample = {
    appName: c.appName,
    appUrl: c.appUrl,
    recipientName: 'Amina Okello',
    ref: 'VD-2026-00042',
    rejected: [{ name: 'Passport data page', reason: 'Glare hides details', note: null }],
    newExpiry: addDays(today, 365),
    expiry,
    applyBy: addDays(expiry, -30),
    day: 30,
    messagePreview: 'Please bring your original passport on Monday.',
    text: '2 students without a submitted application have an expired Student Pass.',
    today,
  };
  return (
    <div className="space-y-8">
      <header>
        <h1>{A.templates.title}</h1>
        <p className="mt-1 max-w-3xl text-ink-muted">{A.templates.intro}</p>
      </header>
      <section aria-labelledby="reasons-h" className="space-y-3">
        <h2 id="reasons-h" className="text-xl">
          {A.templates.reasonsHeading}
        </h2>
        <ReasonTemplates rows={reasons.map((r) => ({ code: r.code, label: r.label, body: r.body, active: r.active, sort: r.sort }))} />
      </section>
      <section aria-labelledby="emails-h" className="space-y-3">
        <h2 id="emails-h" className="text-xl">
          {A.templates.emailsHeading}
        </h2>
        <p className="max-w-3xl text-ink-muted">{A.templates.emailsIntro}</p>
        <div className="space-y-3">
          {NOTIFICATION_KINDS.map((kind) => {
            const m = renderEmail(kind, sample);
            return (
              <details key={kind} className="rounded-md border border-line bg-surface">
                <summary className="cursor-pointer p-4 font-semibold">
                  {A.templates.kinds[kind]} <span className="font-normal text-ink-muted">· {m.subject}</span>
                </summary>
                <div className="border-t border-line p-4">
                  <p className="text-sm">
                    <strong>{A.templates.previewSubject}:</strong> {m.subject}
                  </p>
                  <h3 className="mt-3 text-sm font-semibold">{A.templates.previewText}</h3>
                  <pre className="mt-1 overflow-x-auto rounded-sm bg-paper p-3 text-sm whitespace-pre-wrap">{m.text}</pre>
                </div>
              </details>
            );
          })}
        </div>
      </section>
    </div>
  );
}
