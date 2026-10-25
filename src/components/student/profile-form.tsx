'use client';
import { useRef, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, BookOpen, Check, CloudOff, GraduationCap, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Stepper } from '@/components/ui/stepper';
import { saveApplicationFieldsAction, saveProfileAction } from '@/app/(student)/actions';
import { penaltyEstimate } from '@/domain/rules';
import { formatDate, todayInKampala } from '@/domain/dates';
import { profileSchema } from '@/domain/schemas';
import { REQUESTED_MONTHS, type StudentType } from '@/domain/types';
import { interpolate } from '@/i18n';
import { studentText } from '@/i18n/student';
import { cn } from '@/lib/cn';
import { NationalitySelect } from './nationality-select';
import { StickyBar } from './sticky-bar';

export interface ProfileFormValues {
  fullName: string;
  studentNo: string;
  phone: string;
  studentType: StudentType | null;
  nationality: string | null;
  programme: string;
  passExpiry: string;
  noPass: boolean;
  requestedMonths: 3 | 6 | 12 | null;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';
type ProfileField = 'fullName' | 'studentNo' | 'phone' | 'studentType' | 'nationality' | 'programme';

const STEP_FIELDS: Record<number, (ProfileField | 'passExpiry' | 'requestedMonths')[]> = {
  1: ['fullName', 'studentNo', 'phone'],
  2: ['studentType', 'nationality', 'programme'],
  3: ['passExpiry', 'requestedMonths'],
};

const TYPE_ICONS: Record<StudentType, typeof Sparkles> = { new: Sparkles, continuing: BookOpen, masters: GraduationCap };

/**
 * Welcome/profile (design §6.2 screen 2): three questions per step, every valid
 * change autosaves through a server action (FR-APP-3), so the student can leave
 * and resume on any device.
 */
export function ProfileForm({
  applicationId,
  initial,
  initialStep = 1,
  penaltyUsdPerDay,
}: {
  applicationId: string;
  initial: ProfileFormValues;
  initialStep?: number;
  penaltyUsdPerDay: number;
}) {
  const t = studentText.profile;
  const router = useRouter();
  const [step, setStep] = useState(Math.min(3, Math.max(1, initialStep)));
  const [v, setV] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [save, setSave] = useState<SaveState>('idle');
  const [navigating, startNav] = useTransition();
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const headingRef = useRef<HTMLHeadingElement>(null);

  /** Serialise saves so they land in order. */
  function enqueue(run: () => Promise<{ ok: boolean; error?: { fieldErrors?: Record<string, string>; message: string } }>, field: string) {
    setSave('saving');
    chain.current = chain.current.then(async () => {
      try {
        const r = await run();
        if (r.ok) {
          setSave('saved');
          setErrors((e) => {
            const { [field]: _drop, ...rest } = e;
            return rest;
          });
        } else {
          setSave('error');
          setErrors((e) => ({ ...e, [field]: r.error?.fieldErrors?.[field] ?? r.error?.message ?? studentText.common.saveFailed }));
        }
      } catch {
        setSave('error');
      }
    });
    return chain.current;
  }

  function fieldError(field: ProfileField, value: unknown): string | null {
    const shape = profileSchema.shape[field];
    const r = shape.safeParse(value);
    return r.success ? null : (r.error.issues[0]?.message ?? 'Invalid');
  }

  /** Validate locally, then autosave one profile field. */
  function saveProfileField(field: ProfileField, value: string) {
    if (field === 'phone' && value.trim() === '') {
      void enqueue(() => saveProfileAction({ phone: '' }), field);
      return;
    }
    const err = fieldError(field, value);
    if (err) {
      setErrors((e) => ({ ...e, [field]: err }));
      return;
    }
    void enqueue(() => saveProfileAction({ [field]: value }), field);
  }

  function set<K extends keyof ProfileFormValues>(k: K, value: ProfileFormValues[K]) {
    setV((x) => ({ ...x, [k]: value }));
  }

  function validateStep(n: number): boolean {
    const errs: Record<string, string> = {};
    for (const f of STEP_FIELDS[n]!) {
      if (f === 'passExpiry') {
        if (!v.noPass && !v.passExpiry) errs.passExpiry = studentText.profile.passExpiryHint;
      } else if (f === 'requestedMonths') {
        if (!v.requestedMonths) errs.requestedMonths = 'Choose 3, 6 or 12 months.';
      } else if (f === 'phone') {
        if (v.phone.trim()) {
          const e = fieldError('phone', v.phone);
          if (e) errs.phone = e;
        }
      } else {
        const e = fieldError(f, v[f] ?? '');
        if (e) errs[f] = e;
      }
    }
    setErrors(errs);
    if (Object.keys(errs).length) {
      const first = Object.keys(errs)[0]!;
      document.getElementById(`pf-${first}`)?.focus();
      return false;
    }
    return true;
  }

  function goto(n: number) {
    setStep(n);
    setTimeout(() => headingRef.current?.focus(), 0);
  }

  async function next() {
    if (!validateStep(step)) return;
    await chain.current;
    if (step < 3) goto(step + 1);
    else startNav(() => router.push('/apply'));
  }

  const today = todayInKampala();
  const expired = !v.noPass && v.passExpiry && v.passExpiry < today;
  const penalty = expired ? penaltyEstimate(v.passExpiry, today, penaltyUsdPerDay) : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1>{t.title}</h1>
        <p className="mt-1 text-ink-muted">{t.intro}</p>
      </div>
      <Stepper
        steps={[{ id: 's1', label: t.step1 }, { id: 's2', label: t.step2 }, { id: 's3', label: t.step3 }]}
        current={step - 1}
      />
      <div className="flex items-center justify-between">
        <h2 ref={headingRef} tabIndex={-1} className="text-xl outline-none">
          {[t.step1, t.step2, t.step3][step - 1]}
          <span className="sr-only"> ({interpolate(t.stepOf, { n: step, total: 3 })})</span>
        </h2>
        <SaveIndicator state={save} />
      </div>

      {step === 1 && (
        <div className="space-y-5">
          <Input
            id="pf-fullName"
            label={t.fullName}
            hint={t.fullNameHint}
            autoComplete="name"
            value={v.fullName}
            error={errors.fullName}
            onChange={(e) => set('fullName', e.target.value)}
            onBlur={(e) => saveProfileField('fullName', e.target.value)}
          />
          <Input
            id="pf-studentNo"
            label={t.studentNo}
            autoCapitalize="characters"
            value={v.studentNo}
            error={errors.studentNo}
            onChange={(e) => set('studentNo', e.target.value)}
            onBlur={(e) => saveProfileField('studentNo', e.target.value)}
          />
          <Input
            id="pf-phone"
            label={t.phone}
            hint={t.phoneHint}
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            value={v.phone}
            error={errors.phone}
            onChange={(e) => set('phone', e.target.value)}
            onBlur={(e) => saveProfileField('phone', e.target.value)}
          />
        </div>
      )}

      {step === 2 && (
        <div className="space-y-5">
          <fieldset id="pf-studentType" tabIndex={-1} aria-describedby={errors.studentType ? 'pf-studentType-err' : undefined}>
            <legend className="mb-2 text-sm font-semibold">{t.studentTypeQuestion}</legend>
            <div className="grid gap-3">
              {(['new', 'continuing', 'masters'] as const).map((type) => {
                const Icon = TYPE_ICONS[type];
                const checked = v.studentType === type;
                return (
                  <label
                    key={type}
                    className={cn(
                      'flex min-h-16 cursor-pointer items-center gap-4 rounded-md border bg-surface p-4 shadow-1 transition-colors',
                      'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus',
                      checked ? 'border-brand-500 bg-brand-100' : 'border-line hover:border-brand-500',
                    )}
                  >
                    <input
                      type="radio"
                      name="studentType"
                      value={type}
                      checked={checked}
                      className="sr-only"
                      onChange={() => {
                        set('studentType', type);
                        void enqueue(() => saveProfileAction({ studentType: type }), 'studentType');
                      }}
                    />
                    <Icon aria-hidden className={cn('size-7 shrink-0', checked ? 'text-brand-500' : 'text-ink-muted')} />
                    <span className="flex-1">
                      <span className="block text-lg font-semibold">{t.types[type].title}</span>
                      <span className="block text-sm text-ink-muted">{t.types[type].body}</span>
                    </span>
                    {checked && <Check aria-hidden className="size-5 text-brand-500" />}
                  </label>
                );
              })}
            </div>
            {errors.studentType && (
              <p id="pf-studentType-err" className="mt-1.5 text-sm font-medium text-bad">
                {errors.studentType}
              </p>
            )}
          </fieldset>
          <div id="pf-nationality" tabIndex={-1}>
            <NationalitySelect
              value={v.nationality}
              error={errors.nationality}
              onChange={(code) => {
                set('nationality', code);
                void enqueue(() => saveProfileAction({ nationality: code }), 'nationality');
              }}
            />
          </div>
          <Input
            id="pf-programme"
            label={t.programme}
            hint={t.programmeHint}
            value={v.programme}
            error={errors.programme}
            onChange={(e) => set('programme', e.target.value)}
            onBlur={(e) => saveProfileField('programme', e.target.value)}
          />
        </div>
      )}

      {step === 3 && (
        <div className="space-y-5">
          <div className="space-y-3">
            <Input
              id="pf-passExpiry"
              label={t.passExpiry}
              hint={t.passExpiryHint}
              type="date"
              value={v.noPass ? '' : v.passExpiry}
              disabled={v.noPass}
              error={errors.passExpiry}
              onChange={(e) => {
                const d = e.target.value;
                set('passExpiry', d);
                if (/^\d{4}-\d{2}-\d{2}$/.test(d)) void enqueue(() => saveApplicationFieldsAction(applicationId, { currentExpiry: d, noPass: false }), 'passExpiry');
              }}
            />
            <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-sm border border-line bg-surface px-3">
              <input
                type="checkbox"
                className="size-5 accent-[var(--brand-500)]"
                checked={v.noPass}
                onChange={(e) => {
                  const noPass = e.target.checked;
                  set('noPass', noPass);
                  void enqueue(
                    () => saveApplicationFieldsAction(applicationId, noPass ? { noPass: true } : { noPass: false, currentExpiry: v.passExpiry || null }),
                    'passExpiry',
                  );
                }}
              />
              <span className="font-medium">{t.noPass}</span>
            </label>
            {expired && (
              <div role="alert" className="rounded-sm border border-[color-mix(in_srgb,var(--risk-expired)_50%,transparent)] bg-[color-mix(in_srgb,var(--risk-expired)_8%,var(--surface))] p-3 text-sm">
                <p className="font-semibold text-risk-expired">{t.expiredWarning}</p>
                <p className="mt-1">
                  {interpolate(studentText.checklist.penaltyEstimate, { amount: penalty, rate: penaltyUsdPerDay })}{' '}
                  <span className="text-ink-muted">{studentText.checklist.penaltyNote}</span>
                </p>
                <p className="mt-1 font-mono text-ink-muted tabular-nums">{formatDate(v.passExpiry)}</p>
              </div>
            )}
          </div>
          <fieldset id="pf-requestedMonths" tabIndex={-1}>
            <legend className="mb-1 text-sm font-semibold">{t.requestedMonths}</legend>
            <p className="mb-2 text-sm text-ink-muted">{t.requestedMonthsHint}</p>
            <div className="grid grid-cols-3 gap-2">
              {REQUESTED_MONTHS.map((m) => (
                <label
                  key={m}
                  className={cn(
                    'flex min-h-12 cursor-pointer items-center justify-center rounded-sm border font-semibold',
                    'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus',
                    v.requestedMonths === m ? 'border-brand-500 bg-brand-100' : 'border-line bg-surface',
                  )}
                >
                  <input
                    type="radio"
                    name="requestedMonths"
                    className="sr-only"
                    checked={v.requestedMonths === m}
                    onChange={() => {
                      set('requestedMonths', m);
                      void enqueue(() => saveApplicationFieldsAction(applicationId, { requestedMonths: m }), 'requestedMonths');
                    }}
                  />
                  {interpolate(t.months, { n: m })}
                </label>
              ))}
            </div>
            {errors.requestedMonths && <p className="mt-1.5 text-sm font-medium text-bad">{errors.requestedMonths}</p>}
          </fieldset>
        </div>
      )}

      <StickyBar>
        <div className="flex gap-2">
          {step > 1 && (
            <Button variant="secondary" onClick={() => goto(step - 1)} icon={<ArrowLeft aria-hidden className="size-4" />}>
              {studentText.common.back}
            </Button>
          )}
          <Button className="flex-1" onClick={next} loading={navigating}>
            {step < 3 ? studentText.common.next : t.finish}
            <ArrowRight aria-hidden className="size-4" />
          </Button>
        </div>
      </StickyBar>
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  const c = studentText.common;
  const content: Record<SaveState, ReactNode> = {
    idle: null,
    saving: (
      <>
        <Loader2 aria-hidden className="size-4 animate-spin" /> {c.saving}
      </>
    ),
    saved: (
      <>
        <Check aria-hidden className="size-4 text-ok" /> {c.saved}
      </>
    ),
    error: (
      <>
        <CloudOff aria-hidden className="size-4 text-warn" /> {c.saveFailed}
      </>
    ),
  };
  return (
    <p role="status" aria-live="polite" className="flex items-center gap-1.5 text-sm text-ink-muted">
      {content[state]}
    </p>
  );
}
