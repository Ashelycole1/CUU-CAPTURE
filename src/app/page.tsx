import { redirect } from 'next/navigation';
import { getActor, homePathFor } from '@/server/auth/current';

/** Role-based entry: student → /apply, staff/admin → /dashboard, signed out → /login. */
export default async function Home() {
  const actor = await getActor();
  redirect(actor ? homePathFor(actor) : '/login');
}
