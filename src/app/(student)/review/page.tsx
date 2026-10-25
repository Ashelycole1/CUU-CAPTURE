import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Pencil, Plus } from 'lucide-react';
import { requireActor } from '@/server/auth/current';
import { getChecklistForApplication, getMyActiveApplication, getStudentProfile, getSubmitBlockers } from '@/server/services';
import { Chip } from '@/components/ui/chip';
import { ReviewSubmit } from '@/components/student/review-submit';
import { countryName, flagEmoji } from '@/components/student/countries';
import { docHref, slotsFor } from '@/components/student/logic';
import { documentStateChip } from '@/domain/status';
import { formatDate, formatDateTime } from '@/domain/dates';
import { interpolate } from '@/i18n';
import { studentText } from '@/i18n/student';

export const metadata: Metadata = { title: 'Review and submit' };

/** Review & submit (design §6.2 screen 5, FR-SUB-1/2). */
export default async function ReviewPage() {
  const actor = await requireActor(['student']);
  const app = await getMyActiveApplication(actor);
  if (!app) redirect('/apply');
  if (app.status !== 'draft') redirect('/status');
  const [c, blockers, profile] = await Promise.all([getChecklistForApplication(actor, app.id), getSubmitBlockers(actor, app.id), getStudentProfile(actor)]);
  const r = studentText.review;
  const f = r.fields;
  const none = r.none;

  const details: { label: string; value: string; href: string }[] = [
    { label: f.fullName, value: profile.fullName ?? none, href: '/profile?field=fullName' },
    { label: f.studentNo, value: profile.studentNo ?? none, href: '/profile?field=studentNo' },
    { label: f.phone, value: profile.phone || none, href: '/profile?field=phone' },
    { label: f.studentType, value: profile.studentType ? studentText.profile.types[profile.studentType].title : none, href: '/profile?field=studentType' },
    {
      label: f.nationality,
      value: profile.nationality ? `${flagEmoji(profile.nationality)} ${countryName(profile.nationality)}` : none,
      href: '/profile?field=nationality',
    },
    { label: f.programme, value: profile.programme ?? none, href: '/profile?field=programme' },
    { label: f.passExpiry, value: app.noPass ? r.noPass : app.currentExpiry ? formatDate(app.currentExpiry) : none, href: '/profile?field=passExpiry' },
    {
      label: f.requestedMonths,
      value: app.requestedMonths ? interpolate(studentText.profile.months, { n: app.requestedMonths }) : none,
      href: '/profile?field=requestedMonths',
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1>{r.title}</h1>
        <p className="mt-1 text-ink-muted">{r.intro}</p>
      </div>

      <section aria-labelledby="docs-title" className="space-y-3">
        <h2 id="docs-title" className="text-xl">
          {r.documents}
        </h2>
        <ul className="grid grid-cols-2 gap-3">
          {c.items.map((e) => {
            const chip = documentStateChip(e.document?.state ?? 'missing');
            const slots = slotsFor(e.item.minFiles, e.currentVersions);
            return (
              <li key={e.item.code} className="flex flex-col overflow-hidden rounded-md border border-line bg-surface">
                <div className="grid grid-cols-1 gap-px bg-line">
                  {slots.map((s) => {
                    const v = e.currentVersions.find((x) => x.page === s.page);
                    return v ? (
                      // eslint-disable-next-line @next/next/no-img-element -- authz-checked, decrypted thumbnail from our own API
                      <img
                        key={s.page}
                        src={`/api/files/${v.id}?variant=thumb`}
                        alt={interpolate(r.thumbAlt, { doc: e.item.name, page: s.page, date: formatDateTime(v.uploadedAt) })}
                        loading="lazy"
                        className="aspect-[4/3] w-full bg-paper object-contain"
                      />
                    ) : (
                      <Link key={s.page} href={docHref(e.item.code, s.page)} className="grid aspect-[4/3] w-full place-items-center bg-paper text-ink-muted">
                        <Plus aria-hidden className="size-6" />
                        <span className="sr-only">{interpolate(studentText.capture.pageAdd, { n: s.page })}</span>
                      </Link>
                    );
                  })}
                </div>
                <div className="flex flex-1 flex-col gap-2 p-3">
                  <p className="text-sm leading-snug font-semibold">{e.item.name}</p>
                  <Chip tone={chip.tone} className="self-start">
                    {chip.label}
                  </Chip>
                  {e.canUpload && (
                    <Link href={docHref(e.item.code)} className="mt-auto inline-flex min-h-10 items-center gap-1 text-sm font-semibold">
                      <Pencil aria-hidden className="size-3.5" />
                      {r.edit}
                      <span className="sr-only"> {e.item.name}</span>
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="details-title" className="space-y-3">
        <h2 id="details-title" className="text-xl">
          {r.details}
        </h2>
        <dl className="divide-y divide-line rounded-md border border-line bg-surface">
          {details.map((d) => (
            <div key={d.label} className="flex items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <dt className="text-sm text-ink-muted">{d.label}</dt>
                <dd className="font-medium break-words">{d.value}</dd>
              </div>
              <Link href={d.href} className="inline-flex min-h-12 shrink-0 items-center px-2 text-sm font-semibold">
                {r.edit}
                <span className="sr-only"> {d.label}</span>
              </Link>
            </div>
          ))}
        </dl>
      </section>

      <ReviewSubmit applicationId={app.id} blockers={blockers} items={c.items.map((e) => ({ item: { code: e.item.code, name: e.item.name } }))} />
    </div>
  );
}
