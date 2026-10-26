import Link from 'next/link';
import { BrandMark } from '@/components/layout/brand-mark';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { SignOutButton } from '@/components/auth/sign-out-button';
import type { Actor } from '@/server/authz';
import { StaffNavLinks } from './staff-nav';

/** Staff header: brand, section nav, signed-in identity, sign out. */
export function StaffAppHeader({ actor }: { actor: Actor }) {
  return (
    <header className="sticky top-0 z-30 border-b-2 border-line bg-surface">
      <div className="mx-auto flex h-16 w-full max-w-[1440px] items-center justify-between gap-4 px-4">
        <div className="flex items-center gap-6">
          <Link href="/dashboard" className="no-underline">
            <BrandMark />
          </Link>
          <StaffNavLinks isAdmin={actor.role === 'dos_admin'} />
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden truncate text-sm text-ink-muted lg:inline">{actor.fullName ?? actor.email}</span>
          <ThemeToggle />
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
