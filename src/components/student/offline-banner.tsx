'use client';
import { useSyncExternalStore } from 'react';
import { WifiOff } from 'lucide-react';
import { studentText } from '@/i18n/student';

function subscribe(cb: () => void) {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

/** Offline state (design §8). Progress is saved server-side and in the upload queue. */
export function OfflineBanner() {
  const offline = useSyncExternalStore(
    subscribe,
    () => !navigator.onLine,
    () => false,
  );
  return (
    <div aria-live="polite" role="status">
      {offline && (
        <p className="flex items-center gap-2 border-b border-line bg-[color-mix(in_srgb,var(--warn)_12%,var(--surface))] px-4 py-2 text-sm font-medium text-ink">
          <WifiOff aria-hidden className="size-4 shrink-0 text-warn" />
          {studentText.common.offline}
        </p>
      )}
    </div>
  );
}
