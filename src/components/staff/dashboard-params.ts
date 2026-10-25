/**
 * Dashboard filters ⇄ URL search params (FR-DOS-1). Pure; used by the server page
 * (parse) and the client filter bar / saved views (serialise). Unknown or invalid
 * values are dropped rather than raising, so a hand-edited URL never 500s.
 *
 *   ?q=okello&status=submitted,under_review&type=new&nat=KE,NG&risk=critical
 *   &fee=unpaid&from=2026-10-01&to=2026-10-31&sort=risk&mine=1&drafts=1&cursor=…
 */
import {
  APPLICATION_STATUSES,
  FEE_STATUSES,
  RISK_BANDS,
  STAFF_SORTS,
  STUDENT_TYPES,
  isIsoDate,
  type ApplicationStatus,
  type FeeStatus,
  type RiskBand,
  type StaffListFilters,
  type StaffSort,
  type StudentType,
} from '@/domain';

export type RawSearchParams = Record<string, string | string[] | undefined>;

export interface DashboardQuery {
  filters: StaffListFilters;
  sort: StaffSort;
  cursor: string | null;
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function list<T extends string>(v: string | string[] | undefined, allowed: readonly T[]): T[] | undefined {
  const raw = (Array.isArray(v) ? v.join(',') : (v ?? '')).split(',').map((s) => s.trim()).filter(Boolean);
  const out = raw.filter((s): s is T => (allowed as readonly string[]).includes(s));
  return out.length ? [...new Set(out)] : undefined;
}

export function parseDashboardParams(sp: RawSearchParams): DashboardQuery {
  const filters: StaffListFilters = {};
  const q = first(sp.q)?.trim();
  if (q) filters.q = q.slice(0, 120);
  const status = list<ApplicationStatus>(sp.status, APPLICATION_STATUSES);
  if (status) filters.status = status;
  const type = list<StudentType>(sp.type, STUDENT_TYPES);
  if (type) filters.studentType = type;
  const risk = list<RiskBand>(sp.risk, RISK_BANDS);
  if (risk) filters.riskBand = risk;
  const fee = list<FeeStatus>(sp.fee, FEE_STATUSES);
  if (fee) filters.feeStatus = fee;
  const nat = (first(sp.nat) ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z]{2}$/.test(s));
  if (nat.length) filters.nationality = [...new Set(nat)];
  const from = first(sp.from);
  if (from && isIsoDate(from)) filters.submittedFrom = from;
  const to = first(sp.to);
  if (to && isIsoDate(to)) filters.submittedTo = to;
  if (first(sp.mine) === '1') filters.claimedByMe = true;
  if (first(sp.drafts) === '1') filters.includeDrafts = true;
  const sortRaw = first(sp.sort);
  const sort: StaffSort = sortRaw && (STAFF_SORTS as readonly string[]).includes(sortRaw) ? (sortRaw as StaffSort) : 'risk';
  const cursor = first(sp.cursor)?.trim() || null;
  return { filters, sort, cursor: cursor && /^[A-Za-z0-9_-]{1,2000}$/.test(cursor) ? cursor : null };
}

/** Serialise; `risk` sort and empty values are omitted so URLs stay short and stable. */
export function dashboardSearch(filters: StaffListFilters & { sort?: StaffSort }, sort?: StaffSort, cursor?: string | null): string {
  const p = new URLSearchParams();
  if (filters.q) p.set('q', filters.q);
  if (filters.status?.length) p.set('status', filters.status.join(','));
  if (filters.studentType?.length) p.set('type', filters.studentType.join(','));
  if (filters.nationality?.length) p.set('nat', filters.nationality.map((n) => n.toUpperCase()).join(','));
  if (filters.riskBand?.length) p.set('risk', filters.riskBand.join(','));
  if (filters.feeStatus?.length) p.set('fee', filters.feeStatus.join(','));
  if (filters.submittedFrom) p.set('from', filters.submittedFrom);
  if (filters.submittedTo) p.set('to', filters.submittedTo);
  if (filters.claimedByMe) p.set('mine', '1');
  if (filters.includeDrafts) p.set('drafts', '1');
  const s = sort ?? filters.sort;
  if (s && s !== 'risk') p.set('sort', s);
  if (cursor) p.set('cursor', cursor);
  const str = p.toString();
  return str ? `?${str}` : '';
}

export function hasActiveFilters(f: StaffListFilters): boolean {
  return Object.values(f).some((v) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== false && v !== ''));
}

/** Same set of values (order-insensitive) — used to highlight the active tile / saved view. */
export function sameFilters(a: StaffListFilters & { sort?: StaffSort }, b: StaffListFilters & { sort?: StaffSort }): boolean {
  const norm = (f: StaffListFilters & { sort?: StaffSort }) => {
    const { sort, ...rest } = f;
    const sorted = Object.fromEntries(
      Object.entries(rest)
        .filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== false && v !== ''))
        .map(([k, v]) => [k, Array.isArray(v) ? [...v].map(String).sort() : v])
        .sort(([x], [y]) => String(x).localeCompare(String(y))),
    );
    return JSON.stringify({ ...sorted, sort: sort && sort !== 'risk' ? sort : undefined });
  };
  return norm(a) === norm(b);
}

/** Summary tile → filter (FR-DOS-2 "click to filter"). */
export type TileKey = 'needsReview' | 'correctionsPending' | 'criticalOrExpired' | 'readyForImmigration' | 'feesUnpaid';

export const TILE_FILTERS: Record<TileKey, StaffListFilters> = {
  needsReview: { status: ['submitted', 'under_review'] },
  correctionsPending: { status: ['corrections_needed'] },
  criticalOrExpired: { riskBand: ['critical', 'expired'] },
  readyForImmigration: { status: ['approved'] },
  feesUnpaid: { feeStatus: ['unpaid'] },
};

/** ISO-3166 alpha-2 → flag emoji (regional indicators). Text code is always shown too. */
export function flagEmoji(code: string | null | undefined): string {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return '';
  return String.fromCodePoint(...code.toUpperCase().split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
