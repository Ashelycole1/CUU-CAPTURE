'use client';
import { useActionState } from 'react';
import { Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { en } from '@/i18n/en';
import { interpolate } from '@/i18n';
import { requestCodeAction, type AuthFormState } from '@/app/(auth)/actions';

export function EmailForm({ domain }: { domain: string }) {
  const [state, action, pending] = useActionState<AuthFormState, FormData>(requestCodeAction, {});
  return (
    <form action={action} className="space-y-4" noValidate>
      <Input
        label={en.auth.emailLabel}
        hint={interpolate(en.auth.emailHint, { domain })}
        name="email"
        type="email"
        inputMode="email"
        autoComplete="email"
        autoCapitalize="none"
        spellCheck={false}
        required
        placeholder={`name@${domain}`}
        error={state.error}
      />
      <p className="text-sm text-ink-muted">{en.auth.emailHelp}</p>
      <Button type="submit" fullWidth loading={pending} icon={<Mail aria-hidden className="size-4" />}>
        {en.auth.sendCode}
      </Button>
    </form>
  );
}
