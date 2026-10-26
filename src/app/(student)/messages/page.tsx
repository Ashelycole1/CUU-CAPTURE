import type { Metadata } from 'next';
import { MessagesSquare } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';
import Link from 'next/link';
import { requireActor } from '@/server/auth/current';
import { getMyActiveApplication, listMessages, listMyApplications } from '@/server/services';
import { MessageForm } from '@/components/student/message-form';
import { formatDateTime } from '@/domain/dates';
import { studentText } from '@/i18n/student';
import { cn } from '@/lib/cn';

export const metadata: Metadata = { title: 'Messages' };

/**
 * Per-application thread (FR-NOT-2/3). `listMessages` never returns internal
 * staff notes to a student; we also filter defensively here.
 */
export default async function MessagesPage() {
  const actor = await requireActor(['student']);
  const m = studentText.messages;
  const app = (await getMyActiveApplication(actor)) ?? (await listMyApplications(actor))[0] ?? null;

  if (!app) {
    return (
      <div className="space-y-4">
        <h1>{m.title}</h1>
        <p className="text-ink-muted">{m.noApplication}</p>
        <Link href="/apply" className="inline-flex min-h-12 items-center font-semibold">
          {studentText.status.start}
        </Link>
      </div>
    );
  }

  const thread = (await listMessages(actor, app.id)).filter((x) => !x.internal);
  const active = app.status !== 'withdrawn' && app.status !== 'closed';

  return (
    <div className="space-y-6">
      <div>
        <h1>{m.title}</h1>
        <p className="mt-1 text-ink-muted">{m.intro}</p>
        {app.ref && <p className="mt-1 font-mono text-sm tabular-nums">{app.ref}</p>}
      </div>

      {thread.length === 0 ? (
        <EmptyState icon={MessagesSquare} title={m.empty} />
      ) : (
        <ol className="space-y-3" aria-label={m.title}>
          {thread.map((msg) => {
            const mine = msg.senderId === actor.id;
            return (
              <li key={msg.id} className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
                <div className={cn('max-w-[85%] rounded-md border p-3', mine ? 'border-brand-500 bg-brand-100' : 'border-line bg-surface')}>
                  <p className="text-sm font-semibold">{mine ? m.you : m.dos}</p>
                  <p className="mt-1 whitespace-pre-wrap break-words">{msg.body}</p>
                  <p className="mt-1 font-mono text-xs text-ink-muted tabular-nums">
                    <time dateTime={msg.at}>{formatDateTime(msg.at)}</time>
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {active && <MessageForm applicationId={app.id} />}
    </div>
  );
}
