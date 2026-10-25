'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { UserPlus } from 'lucide-react';
import { Button, Chip, Input, Select, Table, TableContainer, TBody, TD, TH, THead, TR, useToast } from '@/components/ui';
import { admin as A } from '@/i18n/admin';
import { interpolate } from '@/i18n';
import { formatDateTime } from '@/domain/dates';
import { inviteStaffAction, setStaffStatusAction } from '@/app/(admin)/actions';

type StaffRole = 'dos_staff' | 'dos_admin' | 'liaison';
export interface StaffRow {
  id: string;
  email: string;
  fullName: string | null;
  role: StaffRole;
  status: 'active' | 'disabled';
  lastLoginAt: string | null;
}

const ROLE_OPTIONS = (['dos_staff', 'dos_admin', 'liaison'] as const).map((r) => ({ value: r, label: A.staff.roles[r] }));

export function StaffManager({ rows, meId }: { rows: StaffRow[]; meId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<StaffRole>('dos_staff');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const invite = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const res = await inviteStaffAction({ email, fullName, role });
      if (res.ok) {
        toast({ title: interpolate(A.staff.invited, { email: res.data.email }), tone: 'success' });
        setEmail('');
        setFullName('');
        setErrors({});
        router.refresh();
      } else {
        setErrors(res.error.fieldErrors ?? {});
        toast({ title: res.error.message, tone: 'error' });
      }
    });
  };

  const changeRole = (row: StaffRow, next: StaffRole) =>
    start(async () => {
      const res = await inviteStaffAction({ email: row.email, fullName: row.fullName ?? undefined, role: next });
      toast(res.ok ? { title: A.staff.roleChanged, tone: 'success' } : { title: res.error.message, tone: 'error' });
      router.refresh();
    });

  const toggle = (row: StaffRow) =>
    start(async () => {
      const next = row.status === 'active' ? 'disabled' : 'active';
      const res = await setStaffStatusAction(row.id, next);
      toast(res.ok ? { title: interpolate(A.staff.statusChanged, { status: next }), tone: 'success' } : { title: res.error.message, tone: 'error' });
      router.refresh();
    });

  return (
    <div className="space-y-6">
      <form onSubmit={invite} className="grid gap-4 rounded-md border border-line bg-surface p-4 sm:grid-cols-[2fr_2fr_1.5fr_auto] sm:items-end">
        <h2 className="text-lg sm:col-span-4">{A.staff.inviteHeading}</h2>
        <Input label={A.staff.email} type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
        <Input label={A.staff.fullName} value={fullName} onChange={(e) => setFullName(e.target.value)} />
        <Select label={A.staff.role} options={ROLE_OPTIONS} value={role} onChange={(e) => setRole(e.target.value as StaffRole)} error={errors.role} />
        <Button type="submit" loading={pending} icon={<UserPlus aria-hidden className="size-4" />}>
          {A.staff.invite}
        </Button>
      </form>

      <TableContainer>
        <Table>
          <THead>
            <TR>
              <TH>{A.staff.email}</TH>
              <TH>{A.staff.fullName}</TH>
              <TH>{A.staff.role}</TH>
              <TH>{A.common.status}</TH>
              <TH>{A.staff.lastLogin}</TH>
              <TH>
                <span className="sr-only">{A.common.status}</span>
              </TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((r) => (
              <TR key={r.id}>
                <TD className="font-mono text-sm">
                  {r.email} {r.id === meId && <span className="text-ink-muted">{A.staff.you}</span>}
                </TD>
                <TD>{r.fullName ?? '—'}</TD>
                <TD>
                  <label className="sr-only" htmlFor={`role-${r.id}`}>
                    {interpolate(A.staff.changeRole, { email: r.email })}
                  </label>
                  <select
                    id={`role-${r.id}`}
                    className="min-h-9 rounded-sm border border-line bg-surface px-2 text-sm"
                    value={r.role}
                    disabled={pending || r.id === meId}
                    onChange={(e) => changeRole(r, e.target.value as StaffRole)}
                  >
                    {ROLE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </TD>
                <TD>
                  <Chip tone={r.status === 'active' ? 'ok' : 'neutral'}>{r.status === 'active' ? A.common.active : A.staff.disabled}</Chip>
                </TD>
                <TD>{r.lastLoginAt ? formatDateTime(r.lastLoginAt) : A.staff.never}</TD>
                <TD className="text-right">
                  {r.id !== meId && (
                    <Button size="sm" variant={r.status === 'active' ? 'ghost' : 'secondary'} disabled={pending} onClick={() => toggle(r)}>
                      {r.status === 'active' ? A.staff.disable : A.staff.enable}
                    </Button>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </TableContainer>
    </div>
  );
}
