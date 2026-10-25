import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireActor } from '@/server/auth/current';
import { getMyActiveApplication } from '@/server/services';
import { studentStatusCopy } from '@/domain/status';

export const metadata: Metadata = { title: 'Status' };

/** STUB (foundation) — replaced by the student-UI agent (timeline, ref copy, fixes). */
export default async function StatusPage() {
  const actor = await requireActor(['student']);
  const app = await getMyActiveApplication(actor);
  if (!app) redirect('/apply');
  const copy = studentStatusCopy(app.status, { newExpiry: app.newExpiry });
  return (
    <div className="space-y-2">
      <h1>{copy.label}</h1>
      <p>{copy.explanation}</p>
      {app.ref && <p className="font-mono">{app.ref}</p>}
    </div>
  );
}
