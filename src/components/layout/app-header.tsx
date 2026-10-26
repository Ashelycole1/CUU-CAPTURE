import Link from 'next/link';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import type { Actor } from '@/server/authz';
import { BrandMark } from './brand-mark';

/** Shared (student) header: brand, identity, theme, sign out. Translucent so the page wash shows through. */
export function AppHeader({ actor, home, maxWidth = 'max-w-[1440px]' }: { actor: Actor; home: string; maxWidth?: string }) {
  return (
    <header className="sticky top-0 z-30 border-b-2 border-line bg-surface">
      <div className={`mx-auto flex h-16 w-full items-center justify-between gap-4 px-4 ${maxWidth}`}>
        <Link href={home} className="no-underline">
          <BrandMark />
        </Link>
        <div className="flex items-center gap-1">
          <span className="hidden truncate text-sm text-ink-muted sm:inline">{actor.email}</span>
          <ThemeToggle />
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
