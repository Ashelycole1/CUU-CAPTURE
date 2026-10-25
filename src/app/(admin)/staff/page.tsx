import type { Metadata } from 'next';
import { requireActor } from '@/server/auth/current';
import { listStaff } from '@/server/services';
import { StaffManager, type StaffRow } from '@/components/admin/staff-manager';
import { admin as A } from '@/i18n/admin';

export const metadata: Metadata = { title: 'Staff' };

/** FR-ADM-2 / FR-AUTH-2: invite staff and assign roles server-side. */
export default async function StaffPage() {
  const actor = await requireActor(['dos_admin']);
  const rows = (await listStaff(actor)).map(
    (p): StaffRow => ({ id: p.id, email: p.email, fullName: p.fullName, role: p.role as StaffRow['role'], status: p.status, lastLoginAt: p.lastLoginAt }),
  );
  return (
    <div className="space-y-6">
      <header>
        <h1>{A.staff.title}</h1>
        <p className="mt-1 max-w-3xl text-ink-muted">{A.staff.intro}</p>
      </header>
      <StaffManager rows={rows} meId={actor.id} />
    </div>
  );
}
