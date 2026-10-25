import { requireActor } from '@/server/auth/current';
import { AppHeader } from '@/components/layout/app-header';
import { OfflineBanner } from '@/components/student/offline-banner';
import { PendingUploads } from '@/components/student/pending-uploads';
import { StudentNav } from '@/components/student/student-nav';

/**
 * Server-side guard: students only (staff/admin are redirected to /dashboard).
 * Mobile-first single column, 560 px max (design §4). Pages add their own sticky
 * bottom action bar, so `main` leaves room for it.
 */
export default async function StudentLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor(['student']);
  return (
    <>
      <AppHeader actor={actor} home="/apply" maxWidth="max-w-[560px]" />
      <StudentNav />
      <OfflineBanner />
      <PendingUploads />
      <main id="main" className="mx-auto w-full max-w-[560px] px-4 py-6 pb-36">
        {children}
      </main>
    </>
  );
}
