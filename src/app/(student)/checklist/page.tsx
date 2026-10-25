import { redirect } from 'next/navigation';

/** Alias: the checklist home lives at /apply. */
export default function ChecklistAlias() {
  redirect('/apply');
}
