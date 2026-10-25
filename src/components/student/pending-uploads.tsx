'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { listQueued, onUploadSettled, uploadWithRetry } from '@/lib/scan/upload-queue';

/**
 * Resumes scans left in the IndexedDB queue (FR-UP-4): on page load and whenever
 * the connection returns. Renders nothing; refreshes server data after success.
 */
export function PendingUploads() {
  const router = useRouter();
  useEffect(() => {
    let cancelled = false;
    const resume = async () => {
      if (!navigator.onLine) return;
      for (const u of await listQueued()) {
        if (cancelled) return;
        void uploadWithRetry(u);
      }
    };
    void resume();
    window.addEventListener('online', resume);
    const off = onUploadSettled((_id, outcome) => {
      if (outcome.ok) router.refresh();
    });
    return () => {
      cancelled = true;
      window.removeEventListener('online', resume);
      off();
    };
  }, [router]);
  return null;
}
