'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ClipboardCheck, FolderArchive, LayoutDashboard, ScrollText } from 'lucide-react';
import { cn } from '@/lib/cn';
import { staffText } from '@/i18n/staff';

const LINKS = [
  { href: '/dashboard', label: staffText.nav.dashboard, icon: LayoutDashboard, match: ['/dashboard', '/applications'] },
  { href: '/review-mode', label: staffText.nav.reviewMode, icon: ClipboardCheck, match: ['/review-mode'] },
  { href: '/packets', label: staffText.nav.packets, icon: FolderArchive, match: ['/packets'] },
];

/** Primary staff navigation; highlights the current section (aria-current). */
export function StaffNavLinks({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname() ?? '';
  const links = isAdmin ? [...LINKS, { href: '/rules', label: staffText.nav.rules, icon: ScrollText, match: ['/rules'] }] : LINKS;
  return (
    <nav aria-label={staffText.nav.label}>
      <ul className="flex items-center gap-1">
        {links.map(({ href, label, icon: Icon, match }) => {
          const active = match.some((m) => pathname === m || pathname.startsWith(`${m}/`));
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex min-h-9 items-center gap-1.5 rounded-sm px-3 text-sm font-semibold text-ink no-underline transition-colors',
                  active ? 'bg-brand-100 text-brand-700' : 'hover:bg-brand-100',
                )}
              >
                <Icon aria-hidden className="size-4" />
                <span className="hidden md:inline">{label}</span>
                <span className="sr-only md:hidden">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
