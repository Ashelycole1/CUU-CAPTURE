import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { VerifyForm } from '@/components/auth/verify-form';
import { emailSchema } from '@/domain/schemas';
import { en } from '@/i18n/en';

export const metadata: Metadata = { title: en.auth.codeTitle };

export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const { email } = await searchParams;
  const parsed = emailSchema.safeParse(email ?? '');
  if (!parsed.success) redirect('/login');
  return (
    <>
      <h1 className="mb-4">{en.auth.codeTitle}</h1>
      <VerifyForm email={parsed.data} />
    </>
  );
}
