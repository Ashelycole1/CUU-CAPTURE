import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { EmailForm } from '@/components/auth/email-form';
import { getActor, homePathFor } from '@/server/auth/current';
import { getAllowedEmailDomains } from '@/server/services/settings';
import { getDb } from '@/server/db/client';
import { en } from '@/i18n/en';

export const metadata: Metadata = { title: en.auth.signInTitle };

export default async function LoginPage() {
  const actor = await getActor();
  if (actor) redirect(homePathFor(actor));
  const domains = await getAllowedEmailDomains(getDb());
  return (
    <>
      <h1 className="mb-6">{en.auth.signInTitle}</h1>
      <EmailForm domain={domains[0] ?? 'cavendish.ac.ug'} />
    </>
  );
}
