'use client';
import { useActionState, useEffect, useState, startTransition } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { en } from '@/i18n/en';
import { interpolate } from '@/i18n';
import { resendCodeAction, verifyCodeAction, type AuthFormState } from '@/app/(auth)/actions';
import { CodeInput } from './code-input';

const RESEND_SECONDS = 60;

export function VerifyForm({ email }: { email: string }) {
  const [code, setCode] = useState('');
  const [state, verify, verifying] = useActionState<AuthFormState, FormData>(verifyCodeAction, {});
  const [resendState, resend, resending] = useActionState<AuthFormState, FormData>(resendCodeAction, {});
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const deadline = (resendState.sentAt ?? mountedAt) + RESEND_SECONDS * 1000;
  const left = Math.max(0, Math.ceil((deadline - now) / 1000));
  useEffect(() => {
    if (left <= 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [left]);

  const submit = (value: string) => {
    const fd = new FormData();
    fd.set('email', email);
    fd.set('code', value);
    startTransition(() => verify(fd));
  };

  const error = state.error ?? resendState.error;
  return (
    <div className="space-y-6">
      <form
        action={verify}
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit(code);
        }}
      >
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="code" value={code} />
        <p className="text-ink-muted">{interpolate(en.auth.codeSentTo, { email })}</p>
        <CodeInput value={code} onChange={setCode} onComplete={submit} invalid={!!state.error} describedBy={error ? 'code-error' : undefined} />
        {error && (
          <p id="code-error" role="alert" className="text-sm font-medium text-bad">
            {error}
          </p>
        )}
        <Button type="submit" fullWidth loading={verifying} disabled={code.length !== 6}>
          {en.auth.verify}
        </Button>
      </form>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <form action={resend}>
          <input type="hidden" name="email" value={email} />
          <Button type="submit" variant="ghost" size="sm" disabled={left > 0} loading={resending} aria-live="polite">
            {left > 0 ? interpolate(en.auth.resendIn, { seconds: left }) : en.auth.resend}
          </Button>
        </form>
        <Link href="/login" className="font-semibold">
          {en.auth.useDifferentEmail}
        </Link>
      </div>
    </div>
  );
}
