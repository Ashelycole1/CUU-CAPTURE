'use client';
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, useToast } from '@/components/ui';
import { admin as A } from '@/i18n/admin';
import { interpolate } from '@/i18n';
import { migrateDraftsAction } from '@/app/(admin)/actions';

export function MigrateDraftsButton({ count, version }: { count: number; version: number }) {
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  return (
    <Button
      variant="secondary"
      loading={pending}
      onClick={() =>
        start(async () => {
          const res = await migrateDraftsAction();
          if (res.ok) {
            toast({ title: interpolate(A.rules.migrated, { count: res.data.migrated }), tone: 'success' });
            router.refresh();
          } else toast({ title: res.error.message, tone: 'error' });
        })
      }
    >
      {interpolate(A.rules.migrateButton, { count, version })}
    </Button>
  );
}
