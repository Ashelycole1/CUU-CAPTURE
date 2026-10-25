'use client';
import { useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { studentText } from '@/i18n/student';

/** Error state: what happened, what to do, retry (design §8). */
export default function StudentError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="space-y-4 rounded-md border border-line bg-surface p-6">
      <h1 className="text-2xl">{studentText.common.errorTitle}</h1>
      <p className="text-ink-muted">{studentText.common.errorBody}</p>
      <Button onClick={reset} icon={<RefreshCw aria-hidden className="size-4" />}>
        {studentText.common.retry}
      </Button>
    </div>
  );
}
