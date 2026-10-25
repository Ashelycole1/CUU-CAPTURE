import { APP_NAME, UNIVERSITY_NAME } from '@/config/app';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main id="main" className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col justify-center px-4 py-10">
      <div className="mb-8">
        <p className="font-mono text-sm tracking-wide text-ink-muted uppercase">{UNIVERSITY_NAME}</p>
        <p className="font-serif text-3xl font-semibold text-brand-700 dark:text-ink">{APP_NAME}</p>
      </div>
      <div className="rounded-md border border-line bg-surface p-5 shadow-1 sm:p-8">{children}</div>
    </main>
  );
}
