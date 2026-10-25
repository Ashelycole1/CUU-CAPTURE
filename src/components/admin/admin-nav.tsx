'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BarChart3, Clock3, FileText, ScrollText, ShieldCheck, Users } from 'lucide-react';
import { cn } from '@/lib/cn';
import { admin as A } from '@/i18n/admin';

const LINKS = [
  { href: '/rules', label: A.nav.rules, icon: ScrollText },
  { href: '/staff', label: A.nav.staff, icon: Users },
  { href: '/templates', label: A.nav.templates, icon: FileText },
  { href: '/retention', label: A.nav.retention, icon: Clock3 },
  { href: '/audit', label: A.nav.audit, icon: ShieldCheck },
  { href: '/analytics', label: A.nav.analytics, icon: BarChart3 },
];

/** Secondary navigation for the admin area (aria-current on the active section). */
export function AdminNav() {
  const pathname = usePathname() ?? '';
  return (
    <nav aria-label={A.nav.label} className="mb-6 overflow-x-auto border-b border-line">
      <ul className="flex min-w-max gap-1">
        {LINKS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  '-mb-px inline-flex min-h-11 items-center gap-1.5 border-b-2 px-3 text-sm font-semibold no-underline',
                  active ? 'border-brand-500 text-brand-700' : 'border-transparent text-ink-muted hover:text-ink',
                )}
              >
                <Icon aria-hidden className="size-4" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
