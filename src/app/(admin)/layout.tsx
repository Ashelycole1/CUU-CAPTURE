import { requireActor } from '@/server/auth/current';
import { AppHeader } from '@/components/layout/app-header';

/** Server-side guard: DOS admins only. */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor(['dos_admin']);
  return (
    <>
      <AppHeader actor={actor} home="/dashboard" />
      <main id="main" className="mx-auto w-full max-w-[1440px] px-4 py-6">
        {children}
      </main>
    </>
  );
}
