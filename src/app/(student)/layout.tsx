import { requireActor } from '@/server/auth/current';
import { AppHeader } from '@/components/layout/app-header';

/** Server-side guard: students only. Staff/admin are redirected to /dashboard. */
export default async function StudentLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor(['student']);
  return (
    <>
      <AppHeader actor={actor} home="/apply" maxWidth="max-w-[560px]" />
      <main id="main" className="mx-auto w-full max-w-[560px] px-4 py-6 pb-28">
        {children}
      </main>
    </>
  );
}
