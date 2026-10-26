import type { Metadata } from 'next';
import Link from 'next/link';
import { requireActor } from '@/server/auth/current';
import { redirect } from 'next/navigation';
import { getActiveRuleSet, getOrCreateDraft, getStudentProfile } from '@/server/services';
import { getMyDeletionRequest } from '@/server/services/privacy';
import { ProfileForm } from '@/components/student/profile-form';
import { countryName } from '@/components/student/countries';
import { formatDate } from '@/domain/dates';
import { studentText } from '@/i18n/student';

export const metadata: Metadata = { title: 'About you' };

const FIELD_STEP: Record<string, number> = { fullName: 1, studentNo: 1, phone: 1, studentType: 2, nationality: 2, programme: 2, passExpiry: 3, requestedMonths: 3 };

/** Welcome / profile (design §6.1–6.2). Three questions per step; autosaves. */
export default async function ProfilePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await requireActor(['student']);
  const sp = await searchParams;
  // A pending deletion request: don't start a new draft (it would block the admin's approval).
  if ((await getMyDeletionRequest(actor))?.status === 'pending') redirect('/status');
  const app = await getOrCreateDraft(actor);
  const [profile, ruleSet] = await Promise.all([getStudentProfile(actor), getActiveRuleSet()]);
  const t = studentText;

  if (app.status !== 'draft') {
    const r = t.review.fields;
    const rows: [string, string][] = [
      [r.fullName, profile.fullName ?? t.review.none],
      [r.studentNo, profile.studentNo ?? t.review.none],
      [r.nationality, profile.nationality ? countryName(profile.nationality) : t.review.none],
      [r.studentType, profile.studentType ? t.profile.types[profile.studentType].title : t.review.none],
      [r.programme, profile.programme ?? t.review.none],
      [r.passExpiry, app.noPass ? t.review.noPass : formatDate(app.currentExpiry)],
    ];
    return (
      <div className="space-y-4">
        <h1>{t.profile.title}</h1>
        <p role="note" className="rounded-sm border border-line bg-brand-100 p-3 text-sm">
          {t.profile.locked}
        </p>
        <dl className="divide-y divide-line rounded-md border border-line bg-surface">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 p-3">
              <dt className="text-ink-muted">{k}</dt>
              <dd className="text-right font-medium">{v}</dd>
            </div>
          ))}
        </dl>
        <Link href="/messages" className="inline-flex min-h-12 items-center font-semibold">
          {t.nav.messages}
        </Link>
      </div>
    );
  }

  const stepParam = Number(sp.step);
  const field = typeof sp.field === 'string' ? sp.field : undefined;
  const initialStep = field && FIELD_STEP[field] ? FIELD_STEP[field] : Number.isInteger(stepParam) ? stepParam : 1;

  return (
    <ProfileForm
      applicationId={app.id}
      initialStep={initialStep}
      penaltyUsdPerDay={ruleSet.penaltyUsdPerDay}
      initial={{
        fullName: profile.fullName ?? '',
        studentNo: profile.studentNo ?? '',
        phone: profile.phone ?? '',
        studentType: profile.studentType,
        nationality: profile.nationality,
        programme: profile.programme ?? '',
        passExpiry: app.currentExpiry ?? '',
        noPass: app.noPass,
        requestedMonths: (app.requestedMonths as 3 | 6 | 12 | null) ?? null,
      }}
    />
  );
}
