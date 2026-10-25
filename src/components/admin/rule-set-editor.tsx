'use client';
import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowDown, ArrowUp, Plus, Save, Send, Trash2 } from 'lucide-react';
import { Button, Card, CardBody, CardHeader, Dialog, inputClass, useToast } from '@/components/ui';
import { STUDENT_TYPES, type StudentType } from '@/domain/types';
import { admin as A } from '@/i18n/admin';
import { interpolate } from '@/i18n';
import type { RuleSetInput } from '@/server/services/rules';
import { deleteRuleSetDraftAction, publishRuleSetAction, saveRuleSetDraftAction } from '@/app/(admin)/actions';

type Doc = RuleSetInput['documents'][number];

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: (id: string, describedBy?: string) => React.ReactNode }) {
  const id = useId();
  const hintId = hint ? `${id}-h` : undefined;
  const errId = error ? `${id}-e` : undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-semibold">
        {label}
      </label>
      {hint && (
        <p id={hintId} className="text-sm text-ink-muted">
          {hint}
        </p>
      )}
      {children(id, [hintId, errId].filter(Boolean).join(' ') || undefined)}
      {error && (
        <p id={errId} className="text-sm font-medium text-bad">
          {error}
        </p>
      )}
    </div>
  );
}

const csvNumbers = (s: string) =>
  s
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n));
const csvCodes = (s: string) =>
  s
    .split(/[,\s]+/)
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);

export function RuleSetEditor({
  draftId,
  draftVersion,
  initial,
  canPublish,
}: {
  draftId: string | null;
  draftVersion: number;
  initial: RuleSetInput;
  canPublish: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [form, setForm] = useState<RuleSetInput>(initial);
  const [reminders, setReminders] = useState(initial.reminderDays.join(', '));
  const [exempt, setExempt] = useState(initial.exemptCountries.join(', '));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const set = <K extends keyof RuleSetInput>(k: K, v: RuleSetInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setDoc = (i: number, patch: Partial<Doc>) => setForm((f) => ({ ...f, documents: f.documents.map((d, j) => (j === i ? { ...d, ...patch } : d)) }));
  const moveDoc = (i: number, dir: -1 | 1) =>
    setForm((f) => {
      const docs = [...f.documents];
      const j = i + dir;
      if (j < 0 || j >= docs.length) return f;
      [docs[i], docs[j]] = [docs[j]!, docs[i]!];
      return { ...f, documents: docs.map((d, k) => ({ ...d, sort: k + 1 })) };
    });

  const save = () =>
    start(async () => {
      const input: RuleSetInput = {
        ...form,
        reminderDays: csvNumbers(reminders),
        exemptCountries: csvCodes(exempt),
        documents: form.documents.map((d, k) => ({ ...d, sort: k + 1, appliesToTypes: d.appliesToTypes && d.appliesToTypes.length ? d.appliesToTypes : null })),
      };
      const res = await saveRuleSetDraftAction(draftId, input);
      if (res.ok) {
        setErrors({});
        toast({ title: A.rules.draftSaved, tone: 'success' });
        router.refresh();
      } else {
        setErrors(res.error.fieldErrors ?? {});
        toast({ title: res.error.message, tone: 'error' });
      }
    });

  const publish = () =>
    start(async () => {
      if (!draftId) return;
      const res = await publishRuleSetAction(draftId);
      setConfirmPublish(false);
      if (res.ok) {
        toast({ title: interpolate(A.rules.published_ok, { version: res.data }), tone: 'success' });
        router.refresh();
      } else toast({ title: res.error.message, tone: 'error' });
    });

  const remove = () =>
    start(async () => {
      if (!draftId) return;
      const res = await deleteRuleSetDraftAction(draftId);
      setConfirmDelete(false);
      if (res.ok) router.refresh();
      else toast({ title: res.error.message, tone: 'error' });
    });

  const num = (k: 'feeUsd' | 'penaltyUsdPerDay' | 'applyBeforeDays' | 'maxPassMonths', label: string) => (
    <Field label={label} error={errors[k]}>
      {(id, d) => (
        <input id={id} aria-describedby={d} type="number" inputMode="numeric" min={0} className={inputClass} value={form[k]} onChange={(e) => set(k, Number(e.target.value))} />
      )}
    </Field>
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title={A.rules.sections.policy} />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          {num('feeUsd', A.rules.fields.feeUsd)}
          {num('penaltyUsdPerDay', A.rules.fields.penaltyUsdPerDay)}
          {num('applyBeforeDays', A.rules.fields.applyBeforeDays)}
          {num('maxPassMonths', A.rules.fields.maxPassMonths)}
          <Field label={A.rules.fields.feeNote} hint={A.rules.hints.feeNote} error={errors.feeNote}>
            {(id, d) => <input id={id} aria-describedby={d} className={inputClass} value={form.feeNote ?? ''} onChange={(e) => set('feeNote', e.target.value || null)} />}
          </Field>
          <Field label={A.rules.fields.submissionEmail} error={errors.submissionEmail}>
            {(id, d) => (
              <input id={id} aria-describedby={d} type="email" className={inputClass} value={form.submissionEmail ?? ''} onChange={(e) => set('submissionEmail', e.target.value || null)} />
            )}
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`${A.rules.sections.reminders} · ${A.rules.sections.exempt}`} />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label={A.rules.fields.reminderDays} hint={A.rules.hints.reminderDays} error={errors.reminderDays}>
            {(id, d) => <input id={id} aria-describedby={d} className={`${inputClass} font-mono`} value={reminders} onChange={(e) => setReminders(e.target.value)} />}
          </Field>
          <Field label={A.rules.fields.exemptCountries} hint={A.rules.hints.exemptCountries} error={errors.exemptCountries}>
            {(id, d) => <input id={id} aria-describedby={d} className={`${inputClass} font-mono`} value={exempt} onChange={(e) => setExempt(e.target.value)} />}
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={A.rules.sections.documents}
          action={
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus aria-hidden className="size-4" />}
              onClick={() =>
                set('documents', [
                  ...form.documents,
                  { code: '', name: '', helpText: '', whereToGet: '', examplePath: null, appliesToTypes: null, minFiles: 1, source: 'notice', sort: form.documents.length + 1 },
                ])
              }
            >
              {A.rules.addDocument}
            </Button>
          }
        />
        <CardBody>
          {errors.documents && <p className="mb-3 text-sm font-medium text-bad">{errors.documents}</p>}
          <ol className="space-y-4">
            {form.documents.map((d, i) => (
              <li key={i} className="rounded-md border border-line p-4">
                <fieldset className="grid gap-4 sm:grid-cols-2">
                  <legend className="sr-only">{d.name || `${A.rules.docFields.name} ${i + 1}`}</legend>
                  <Field label={A.rules.docFields.name}>
                    {(id) => <input id={id} className={inputClass} value={d.name} onChange={(e) => setDoc(i, { name: e.target.value })} />}
                  </Field>
                  <Field label={A.rules.docFields.code} hint={A.rules.docHints.code}>
                    {(id, h) => <input id={id} aria-describedby={h} className={`${inputClass} font-mono`} value={d.code} onChange={(e) => setDoc(i, { code: e.target.value.trim() })} />}
                  </Field>
                  <Field label={A.rules.docFields.helpText}>
                    {(id) => <textarea id={id} rows={2} className={inputClass} value={d.helpText ?? ''} onChange={(e) => setDoc(i, { helpText: e.target.value })} />}
                  </Field>
                  <Field label={A.rules.docFields.whereToGet}>
                    {(id) => <textarea id={id} rows={2} className={inputClass} value={d.whereToGet ?? ''} onChange={(e) => setDoc(i, { whereToGet: e.target.value })} />}
                  </Field>
                  <Field label={A.rules.docFields.minFiles}>
                    {(id) => (
                      <input id={id} type="number" min={1} max={10} className={inputClass} value={d.minFiles} onChange={(e) => setDoc(i, { minFiles: Number(e.target.value) })} />
                    )}
                  </Field>
                  <Field label={A.rules.docFields.source}>
                    {(id) => (
                      <select id={id} className={inputClass} value={d.source} onChange={(e) => setDoc(i, { source: e.target.value as Doc['source'] })}>
                        <option value="notice">{A.rules.sources.notice}</option>
                        <option value="student_addition">{A.rules.sources.student_addition}</option>
                      </select>
                    )}
                  </Field>
                  <Field label={A.rules.docFields.examplePath}>
                    {(id) => (
                      <input id={id} className={`${inputClass} font-mono`} value={d.examplePath ?? ''} onChange={(e) => setDoc(i, { examplePath: e.target.value || null })} />
                    )}
                  </Field>
                  <fieldset>
                    <legend className="text-sm font-semibold">{A.rules.docFields.appliesToTypes}</legend>
                    <p className="text-sm text-ink-muted">{A.rules.docHints.appliesToTypes}</p>
                    <div className="mt-2 flex flex-wrap gap-4">
                      {STUDENT_TYPES.map((st: StudentType) => (
                        <label key={st} className="inline-flex min-h-11 items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="size-5"
                            checked={!!d.appliesToTypes?.includes(st)}
                            onChange={(e) => {
                              const cur = new Set(d.appliesToTypes ?? []);
                              if (e.target.checked) cur.add(st);
                              else cur.delete(st);
                              setDoc(i, { appliesToTypes: cur.size ? STUDENT_TYPES.filter((x) => cur.has(x)) : null });
                            }}
                          />
                          {A.rules.audience[st]}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </fieldset>
                <div className="mt-3 flex flex-wrap justify-end gap-2">
                  <Button variant="ghost" size="sm" aria-label={interpolate(A.rules.moveUp, { name: d.name })} icon={<ArrowUp aria-hidden className="size-4" />} disabled={i === 0} onClick={() => moveDoc(i, -1)} />
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={interpolate(A.rules.moveDown, { name: d.name })}
                    icon={<ArrowDown aria-hidden className="size-4" />}
                    disabled={i === form.documents.length - 1}
                    onClick={() => moveDoc(i, 1)}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 aria-hidden className="size-4" />}
                    onClick={() => set('documents', form.documents.filter((_, j) => j !== i))}
                  >
                    {interpolate(A.rules.removeDocument, { name: d.name || '' })}
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        </CardBody>
      </Card>

      <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-paper/95 py-3 backdrop-blur">
        {draftId && (
          <Button variant="ghost" icon={<Trash2 aria-hidden className="size-4" />} onClick={() => setConfirmDelete(true)} disabled={pending}>
            {A.rules.deleteDraft}
          </Button>
        )}
        <Button variant="secondary" icon={<Save aria-hidden className="size-4" />} loading={pending} onClick={save}>
          {A.rules.saveDraft}
        </Button>
        {draftId && canPublish && (
          <Button icon={<Send aria-hidden className="size-4" />} onClick={() => setConfirmPublish(true)} disabled={pending}>
            {interpolate(A.rules.publish, { version: draftVersion })}
          </Button>
        )}
      </div>

      <Dialog
        open={confirmPublish}
        onClose={() => setConfirmPublish(false)}
        title={interpolate(A.rules.publishConfirmTitle, { version: draftVersion })}
        description={A.rules.publishConfirmBody}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmPublish(false)}>
              {A.common.cancel}
            </Button>
            <Button loading={pending} onClick={publish}>
              {interpolate(A.rules.publish, { version: draftVersion })}
            </Button>
          </>
        }
      />
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={A.rules.deleteDraft}
        description={A.rules.deleteConfirm}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              {A.common.cancel}
            </Button>
            <Button variant="danger" loading={pending} onClick={remove}>
              {A.rules.deleteDraft}
            </Button>
          </>
        }
      />
    </div>
  );
}
