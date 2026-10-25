import Link from 'next/link';
import { APP_NAME } from '@/config/app';
import { SignOutButton } from '@/components/auth/sign-out-button';
import type { Actor } from '@/server/authz';

/** Minimal shared header; the student/staff UIs may replace it. */
export function AppHeader({ actor, home, maxWidth = 'max-w-[1440px]' }: { actor: Actor; home: string; maxWidth?: string }) {
  return (
    <header className="border-b border-line bg-surface">
      <div className={`mx-auto flex h-14 w-full items-center justify-between gap-4 px-4 ${maxWidth}`}>
        <Link href={home} className="font-serif text-lg font-semibold text-ink no-underline">
          {APP_NAME}
        </Link>
        <div className="flex items-center gap-2">
          <span className="hidden truncate text-sm text-ink-muted sm:inline">{actor.email}</span>
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
