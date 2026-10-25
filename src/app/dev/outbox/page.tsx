import { notFound } from 'next/navigation';
import { desc } from 'drizzle-orm';
import { getDb } from '@/server/db/client';
import { outbox } from '@/server/db/schema';
import { formatDateTime } from '@/domain/dates';

/** Dev mail sink: read OTP codes and emails sent by DevOutboxChannel. 404 in production. */
export default async function DevOutboxPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  const rows = await getDb().select().from(outbox).orderBy(desc(outbox.createdAt)).limit(100);
  return (
    <div className="space-y-4">
      <h1>Dev outbox</h1>
      <p className="text-ink-muted">Latest 100 messages. Refresh to update.</p>
      {rows.length === 0 && <p>No messages yet.</p>}
      <ul className="space-y-3">
        {rows.map((m) => (
          <li key={m.id} className="rounded-md border border-line bg-surface p-4">
            <p className="text-sm text-ink-muted">
              {formatDateTime(m.createdAt)} · to <span className="font-mono">{m.to}</span> · {m.kind}
            </p>
            <p className="font-semibold">{m.subject}</p>
            <pre className="mt-2 font-mono text-sm whitespace-pre-wrap">{m.text}</pre>
          </li>
        ))}
      </ul>
    </div>
  );
}
