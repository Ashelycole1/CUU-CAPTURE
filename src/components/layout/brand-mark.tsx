import { BookOpen } from 'lucide-react';
import { APP_NAME, UNIVERSITY_LOGO_SRC, UNIVERSITY_NAME } from '@/config/app';
import { cn } from '@/lib/cn';

/** University crest (or shield placeholder) + wordmark. `size="lg"` for the sign-in page. */
export function BrandMark({ size = 'md', className }: { size?: 'md' | 'lg'; className?: string }) {
  const lg = size === 'lg';
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      {UNIVERSITY_LOGO_SRC ? (
        // eslint-disable-next-line @next/next/no-img-element -- static crest, no optimisation needed
        <img src={UNIVERSITY_LOGO_SRC} alt={UNIVERSITY_NAME} className={lg ? 'h-14 w-auto' : 'h-10 w-auto'} />
      ) : (
        <svg aria-hidden viewBox="0 0 40 46" className={lg ? 'h-14 w-auto' : 'h-10 w-auto'}>
          <path d="M20 2 37 8v14c0 11-7.5 18.5-17 22C10.5 40.5 3 33 3 22V8L20 2Z" fill="var(--brand-500)" stroke="var(--edge)" strokeWidth="2.5" strokeLinejoin="round" />
          <path d="M3 22h34" stroke="var(--silver)" strokeWidth="2.5" />
          <foreignObject x="10" y="7" width="20" height="14">
            <BookOpen color="white" width={20} height={14} strokeWidth={2.25} />
          </foreignObject>
        </svg>
      )}
      <span className="flex flex-col leading-none">
        <span className={cn('font-serif font-extrabold tracking-tight text-ink', lg ? 'text-3xl' : 'text-xl')}>{APP_NAME}</span>
        <span className="mt-0.5 text-[0.6875rem] font-bold tracking-wider text-ink-muted uppercase">Cavendish University</span>
      </span>
    </span>
  );
}
