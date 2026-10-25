'use client';
import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { inputClass } from '@/components/ui/field-styles';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/domain';
import { staffText } from '@/i18n/staff';
import { postMessageAction } from '@/app/(staff)/actions';

const D = staffText.detail;

export interface ThreadMessage {
  id: string;
  body: string;
  internal: boolean;
  at: string;
  sender: string;
  fromStudent: boolean;
}

/**
 * FR-NOT-2/3 + FR-DOS-4: per-application thread. Internal notes (staff only, no
 * email) are visually distinct: gold-tinted background, dashed border, lock icon.
 */
export function MessageThread({ applicationId, messages }: { applicationId: string; messages: ThreadMessage[] }) {
  const router = useRouter();
  const toast = useToast();
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    setError(null);
    start(async () => {
      const r = await postMessageAction(applicationId, { body, internal });
      if (!r.ok) {
        setError(r.error.fieldErrors?.body ?? r.error.message);
        return;
      }
      setBody('');
      toast({ title: internal ? D.noteSaved : D.messageSent, tone: 'success' });
      router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      {messages.length === 0 ? (
        <p className="text-sm text-ink-muted">{D.noMessages}</p>
      ) : (
        <ol className="max-h-[28rem] space-y-2 overflow-y-auto pr-1" aria-label={D.messages}>
          {messages.map((m) => (
            <li
              key={m.id}
              className={cn(
                'rounded-md border p-3 text-sm',
                m.internal
                  ? 'border-dashed border-[color-mix(in_srgb,var(--accent-500)_60%,transparent)] bg-[color-mix(in_srgb,var(--accent-500)_12%,transparent)]'
                  : m.fromStudent
                    ? 'mr-6 border-line bg-paper'
                    : 'ml-6 border-[color-mix(in_srgb,var(--brand-500)_30%,transparent)] bg-brand-100/60',
              )}
            >
              <p className="flex flex-wrap items-center gap-x-2 text-xs text-ink-muted">
                {m.internal && (
                  <span className="inline-flex items-center gap-1 font-semibold text-ink">
                    <Lock aria-hidden className="size-3" />
                    {D.internalTag}
                  </span>
                )}
                <span className="font-semibold text-ink">{m.sender}</span>
                <time dateTime={m.at} className="tabular">
                  {formatDateTime(m.at)}
                </time>
              </p>
              <p className="mt-1 whitespace-pre-wrap">{m.body}</p>
            </li>
          ))}
        </ol>
      )}

      <form
        onSubmit={submit}
        className={cn(
          'space-y-2 rounded-md border p-3',
          internal ? 'border-dashed border-[color-mix(in_srgb,var(--accent-500)_60%,transparent)] bg-[color-mix(in_srgb,var(--accent-500)_10%,transparent)]' : 'border-line bg-surface',
        )}
      >
        <label htmlFor="msg-body" className="sr-only">
          {internal ? D.notePlaceholder : D.messagePlaceholder}
        </label>
        <textarea
          id="msg-body"
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={internal ? D.notePlaceholder : D.messagePlaceholder}
          maxLength={5000}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'msg-err' : 'msg-hint'}
          className={cn(inputClass, 'min-h-20 resize-y')}
        />
        {error && (
          <p id="msg-err" className="text-sm font-medium text-bad">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-semibold">
            <input
              type="checkbox"
              role="switch"
              aria-checked={internal}
              checked={internal}
              onChange={(e) => setInternal(e.target.checked)}
              className="size-4 accent-[var(--accent-500)]"
            />
            <Lock aria-hidden className="size-3.5" />
            {D.internalToggle}
          </label>
          <Button type="submit" size="sm" loading={pending} disabled={!body.trim()} icon={<Send aria-hidden className="size-4" />}>
            {internal ? D.addNote : D.send}
          </Button>
        </div>
        <p id="msg-hint" className="text-xs text-ink-muted">
          {internal ? D.internalHint : ' '}
        </p>
      </form>
    </div>
  );
}
