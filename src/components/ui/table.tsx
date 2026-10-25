import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/** Semantic table primitives; wrap in <TableContainer> for horizontal scroll on small screens. */
export function TableContainer({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('w-full overflow-x-auto rounded-md border border-line bg-surface', className)} {...rest} />;
}
export function Table({ className, ...rest }: HTMLAttributes<HTMLTableElement>) {
  return <table className={cn('w-full border-collapse text-left text-sm', className)} {...rest} />;
}
export function THead({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('bg-paper text-ink-muted', className)} {...rest} />;
}
export function TBody(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody {...props} />;
}
export function TR({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('border-b border-line last:border-b-0', className)} {...rest} />;
}
export function TH({ className, scope = 'col', ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope={scope} className={cn('px-3 py-2.5 font-semibold whitespace-nowrap', className)} {...rest} />;
}
export function TD({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-3 py-3 align-middle', className)} {...rest} />;
}
