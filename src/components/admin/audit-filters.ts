import type { AuditFilters } from '@/server/services/admin';

function one(v: string | string[] | null | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : undefined;
}

/** Parse audit filters from URL search params (page and CSV export share this). */
export function auditFiltersFrom(sp: Record<string, string | string[] | undefined> | URLSearchParams): AuditFilters {
  const get = (k: string) => (sp instanceof URLSearchParams ? sp.get(k) : sp[k]);
  const before = Number(one(get('before')));
  return {
    action: one(get('action')),
    actor: one(get('actor')),
    targetType: one(get('targetType')),
    targetId: one(get('targetId')),
    from: one(get('from')),
    to: one(get('to')),
    beforeId: Number.isInteger(before) && before > 0 ? before : undefined,
  };
}
