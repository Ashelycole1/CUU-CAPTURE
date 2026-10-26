'use client';
import { useSyncExternalStore } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/cn';
import { THEME_COOKIE, type ThemeChoice } from '@/lib/theme';
import { en } from '@/i18n/en';

const order: ThemeChoice[] = ['system', 'light', 'dark'];
const icons = { system: Monitor, light: Sun, dark: Moon } as const;

function current(): ThemeChoice {
  const t = document.documentElement.dataset.theme;
  return t === 'light' || t === 'dark' ? t : 'system';
}

// The <html data-theme> attribute is the store; hydration uses 'system' then corrects without a mismatch.
function subscribe(cb: () => void) {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => mo.disconnect();
}

/** Cycles System → Light → Dark. Stored in a cookie so the server renders the right theme first time. */
export function ThemeToggle({ className }: { className?: string }) {
  const choice = useSyncExternalStore(subscribe, current, () => 'system' as ThemeChoice);
  const next = order[(order.indexOf(choice) + 1) % order.length]!;
  const Icon = icons[choice];

  function apply() {
    const root = document.documentElement;
    if (next === 'system') {
      delete root.dataset.theme;
      document.cookie = `${THEME_COOKIE}=; path=/; max-age=0; samesite=lax`;
    } else {
      root.dataset.theme = next;
      document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    }
  }

  return (
    <button
      type="button"
      onClick={apply}
      aria-label={en.app.theme.label.replace('{mode}', en.app.theme[choice])}
      title={en.app.theme.label.replace('{mode}', en.app.theme[choice])}
      className={cn(
        'inline-flex size-11 items-center justify-center rounded-full text-ink-muted transition-colors duration-200 hover:bg-brand-100 hover:text-ink',
        className,
      )}
    >
      <Icon aria-hidden className="size-5" />
    </button>
  );
}
