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
    <nav aria-label={studentText.nav.main} className="px-4 pt-4">
      <ul className="mx-auto flex w-full max-w-[528px] gap-1 rounded-full border-2 border-edge bg-surface p-1">
        {links.map((l) => {
          const active = l.match.some((m) => path === m || path.startsWith(`${m}/`));
          return (
            <li key={l.href} className="flex-1">
              <Link
                href={l.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-11 items-center justify-center rounded-full text-sm font-bold no-underline transition-colors duration-200',
                  active ? 'bg-brand-900 text-white dark:bg-sky' : 'text-ink-muted hover:bg-silver hover:text-ink',
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
