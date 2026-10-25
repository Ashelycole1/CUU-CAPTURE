import Link from 'next/link';
import { APP_NAME } from '@/config/app';
import { SignOutButton } from '@/components/auth/sign-out-button';
import type { Actor } from '@/server/authz';
import { StaffNavLinks } from './staff-nav';

/** Staff header: brand, section nav, signed-in identity, sign out. */
export function StaffAppHeader({ actor }: { actor: Actor }) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-[1440px] items-center justify-between gap-4 px-4">
        <div className="flex items-center gap-6">
          <Link href="/dashboard" className="font-serif text-lg font-semibold text-ink no-underline">
            {APP_NAME}
          </Link>
          <StaffNavLinks isAdmin={actor.role === 'dos_admin'} />
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden truncate text-sm text-ink-muted lg:inline">{actor.fullName ?? actor.email}</span>
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
