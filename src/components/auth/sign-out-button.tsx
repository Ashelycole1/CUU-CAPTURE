import { LogOut } from 'lucide-react';
import { signOutAction } from '@/app/(auth)/actions';
import { en } from '@/i18n/en';

/** POSTs to a server action (CSRF-protected by Next's origin check). */
export function SignOutButton({ className }: { className?: string }) {
  return (
    <form action={signOutAction} className={className}>
      <button type="submit" className="inline-flex min-h-11 items-center gap-2 rounded-sm px-3 text-sm font-semibold text-ink-muted hover:bg-brand-100 hover:text-ink">
        <LogOut aria-hidden className="size-4" />
        {en.app.signOut}
      </button>
    </form>
  );
}
