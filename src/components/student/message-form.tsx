'use client';
import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { inputClass } from '@/components/ui/field-styles';
import { useToast } from '@/components/ui/toast';
import { postMessageAction } from '@/app/(student)/actions';
import { studentText } from '@/i18n/student';
import { cn } from '@/lib/cn';

/** Reply box for the per-application thread (FR-NOT-2). */
export function MessageForm({ applicationId }: { applicationId: string }) {
  const m = studentText.messages;
  const router = useRouter();
  const toast = useToast();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const ref = useRef<HTMLTextAreaElement>(null);

  function send() {
    if (!body.trim()) {
      setError(studentText.messages.label);
      ref.current?.focus();
      return;
    }
    setError(null);
    start(async () => {
      const r = await postMessageAction(applicationId, body);
      if (r.ok) {
        setBody('');
        toast({ title: m.sent, tone: 'success' });
        router.refresh();
      } else {
        setError(r.error.fieldErrors?.body ?? r.error.message);
      }
    });
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <label htmlFor="msg-body" className="block text-sm font-semibold">
        {m.label}
      </label>
      <textarea
        id="msg-body"
        ref={ref}
        rows={4}
        maxLength={5000}
        value={body}
        placeholder={m.placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'msg-err' : undefined}
        onChange={(e) => setBody(e.target.value)}
        className={cn(inputClass, 'py-3')}
      />
      {error && (
        <p id="msg-err" role="alert" className="text-sm font-medium text-bad">
          {error}
        </p>
      )}
      <Button type="submit" fullWidth loading={pending} icon={<Send aria-hidden className="size-4" />}>
        {m.send}
      </Button>
    </form>
  );
}
