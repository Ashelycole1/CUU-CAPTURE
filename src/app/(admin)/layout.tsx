import { requireActor } from '@/server/auth/current';
import { StaffAppHeader } from '@/components/staff/app-header';
import { AdminNav } from '@/components/admin/admin-nav';

/** Server-side guard: DOS admins only. Services re-check `assertAdmin` (layouts are UX, not security). */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor(['dos_admin']);
  return (
    <>
      <StaffAppHeader actor={actor} />
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1440px] px-4 py-6 outline-none">
        <AdminNav />
        {children}
      </main>
    </>
  );
}
