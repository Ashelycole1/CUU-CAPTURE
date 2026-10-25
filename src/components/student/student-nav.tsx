'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { studentText } from '@/i18n/student';

const links = [
  { href: '/apply', label: studentText.nav.checklist, match: ['/apply', '/documents', '/review', '/profile'] },
  { href: '/status', label: studentText.nav.status, match: ['/status'] },
  { href: '/messages', label: studentText.nav.messages, match: ['/messages'] },
];

/** Three top-level sections; 48 px targets; the current section has aria-current. */
export function StudentNav() {
  const path = usePathname() ?? '';
  return (
    <nav aria-label={studentText.nav.main} className="border-b border-line bg-surface">
      <ul className="mx-auto flex w-full max-w-[560px] px-2">
        {links.map((l) => {
          const active = l.match.some((m) => path === m || path.startsWith(`${m}/`));
          return (
            <li key={l.href} className="flex-1">
              <Link
                href={l.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-12 items-center justify-center border-b-2 text-sm font-semibold no-underline',
                  active ? 'border-brand-500 text-ink' : 'border-transparent text-ink-muted hover:text-ink',
                )}
              >
                {l.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
