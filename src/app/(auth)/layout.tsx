import { BellRing, ListChecks, ScanLine } from 'lucide-react';
import { UNIVERSITY_NAME } from '@/config/app';
import { en } from '@/i18n/en';
import { BrandMark } from '@/components/layout/brand-mark';
import { ThemeToggle } from '@/components/ui/theme-toggle';

const steps = [
  { icon: ListChecks, block: 'bg-sky text-ink' },
  { icon: ScanLine, block: 'bg-silver text-ink' },
  { icon: BellRing, block: 'bg-surface text-ink' },
];

/**
 * Sign-in shell, flat-block style: a Cavendish-blue welcome panel with bold type and
 * three coloured step tiles beside the form; stacks (form first) on phones.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const w = en.app.welcome;
  return (
    <main id="main" tabIndex={-1} className="mx-auto flex min-h-dvh w-full max-w-[1120px] flex-col px-4 py-6 outline-none">
      <div className="flex items-center justify-between">
        <BrandMark />
        <ThemeToggle />
      </div>
      <div className="grid flex-1 items-center gap-6 py-8 md:grid-cols-[1.15fr_1fr] md:gap-10">
        <section aria-labelledby="welcome-title" className="relative order-2 overflow-hidden rounded-lg border-2 border-edge bg-brand-500 p-6 text-white sm:p-10 md:order-1">
          {/* Flat decorative shapes (silver ring, sky dot) */}
          <span aria-hidden className="absolute -top-16 -right-16 size-48 rounded-full border-[18px] border-silver/40" />
          <span aria-hidden className="absolute right-10 bottom-10 hidden size-6 rounded-full bg-sky md:block" />
          <p className="relative text-xs font-bold tracking-widest text-white/80 uppercase">{UNIVERSITY_NAME}</p>
          <p id="welcome-title" className="relative mt-3 max-w-md font-serif text-4xl leading-[1.02] font-extrabold tracking-tight sm:text-5xl">
            {w.title}
          </p>
          <p className="relative mt-4 max-w-md text-lg text-white/90">{w.body}</p>
          <ol className="relative mt-8 grid gap-3 sm:grid-cols-3">
            {w.steps.map((step, i) => {
              const { icon: Icon, block } = steps[i]!;
              return (
                <li key={step} className={`flex items-center gap-3 rounded-md border-2 border-edge p-3 sm:flex-col sm:items-start ${block}`}>
                  <Icon aria-hidden className="size-6 shrink-0" />
                  <span className="text-sm font-bold">
                    <span className="tabular">{i + 1}. </span>
                    {step}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
        <div className="order-1 rounded-lg border-2 border-edge bg-surface p-5 sm:p-8 md:order-2">{children}</div>
      </div>
    </main>
  );
}
