/**
 * Minimal i18n. Usage:
 *   import { t, messages } from '@/i18n';
 *   t('auth.codeSentTo', { email })           // dotted key, typed
 *   messages.status.draft.label               // direct access also fine
 * Safe in client and server components (pure, no runtime deps).
 */
import { en, type Messages } from './en';

export const messages: Messages = en;
export const locale = 'en';

type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

export type MessageKey = Leaves<Messages>;

export function interpolate(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  let node: unknown = messages;
  for (const part of key.split('.')) node = (node as Record<string, unknown>)?.[part];
  if (typeof node !== 'string') return key;
  return interpolate(node, vars);
}
