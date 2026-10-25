import { notFound } from 'next/navigation';

/** /dev/* is disabled in production. */
export default function DevLayout({ children }: { children: React.ReactNode }) {
  if (process.env.NODE_ENV === 'production') notFound();
  return <main id="main" className="mx-auto w-full max-w-5xl px-4 py-8">{children}</main>;
}
