import type { Metadata } from 'next';
import Link from 'next/link';
import { FolderArchive } from 'lucide-react';
import { requireActor } from '@/server/auth/current';
import { listApplicationsForStaff } from '@/server/services';
import { Chip } from '@/components/ui/chip';
import { RunwayCompact } from '@/components/runway';
import { applicationStatusTone, formatDateTime, staffStatusLabel, todayInKampala } from '@/domain';
import { fmt, staffText } from '@/i18n/staff';

export const metadata: Metadata = { title: staffText.packets.title };
const P = staffText.packets;

/** Design §7.4 entry point: approved / sent applications; the PacketPreview lives on each detail page (#packet). */
export default async function PacketsPage() {
  const actor = await requireActor(['dos_staff', 'dos_admin']);
  const today = todayInKampala();
  const [ready, sent] = await Promise.all([
    listApplicationsForStaff(actor, { filters: { status: ['approved'] }, sort: 'risk', limit: 100, today }),
    listApplicationsForStaff(actor, { filters: { status: ['sent_to_immigration'] }, sort: 'activity', limit: 50, today }),
  ]);
  const section = (title: string, items: typeof ready.items) => (
    <section className="space-y-2">
      <h2 className="font-sans text-base font-semibold">
        {title} <span className="font-mono text-sm text-ink-muted">({items.length})</span>
      </h2>
      {items.length === 0 ? (
        <p className="text-sm text-ink-muted">{P.empty}</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line bg-surface shadow-1">
          {items.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="font-semibold">{i.studentName ?? i.studentEmail}</p>
                <p className="font-mono text-xs text-ink-muted">
                  {i.ref ?? '-'} · {i.studentNo ?? '-'}
                </p>
              </div>
              <RunwayCompact summary={i.runway} />
              <Chip tone={applicationStatusTone(i.status)}>{staffStatusLabel(i.status)}</Chip>
              <span className="text-xs text-ink-muted tabular">{formatDateTime(i.lastActivityAt)}</span>
              <Link href={`/applications/${i.id}#packet`} className="inline-flex min-h-9 items-center gap-1.5 rounded-sm border border-line px-3 text-sm font-semibold no-underline hover:bg-brand-100">
                <FolderArchive aria-hidden className="size-4" />
                {P.open}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
  return (
    <div className="space-y-6">
      <div>
        <h1>{P.title}</h1>
        <p className="text-sm text-ink-muted">{P.subtitle}</p>
      </div>
      {section(staffText.dashboard.tiles.readyForImmigration, ready.items)}
      {section(staffStatusLabel('sent_to_immigration'), sent.items)}
      <p className="sr-only">{fmt(staffText.dashboard.showing, { count: ready.items.length + sent.items.length, total: ready.total + sent.total })}</p>
    </div>
  );
}
