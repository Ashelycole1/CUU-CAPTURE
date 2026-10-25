import { requireActor } from '@/server/auth/current';
import { StaffAppHeader } from '@/components/staff/app-header';

/** Server-side guard: DOS staff and admins. Services still check roles (layouts are UX, not security). */
export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor(['dos_staff', 'dos_admin']);
  return (
    <>
      <StaffAppHeader actor={actor} />
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1440px] px-4 py-6 outline-none">
        {children}
      </main>
    </>
  );
}
