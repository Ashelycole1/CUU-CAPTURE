/**
 * Kampala-calendar date utilities. Pure; no server imports.
 *
 * All "dates" in VisaDesk are ISO calendar dates (`YYYY-MM-DD`) interpreted in
 * Africa/Kampala (UTC+3, no DST). Arithmetic is done on UTC midnights so it is
 * immune to the host timezone.
 */
export type IsoDate = string; // YYYY-MM-DD

export const KAMPALA_TZ = 'Africa/Kampala';
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string') return false;
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function toUtcMs(date: IsoDate): number {
  if (!isIsoDate(date)) throw new RangeError(`Invalid ISO date: ${date}`);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function fromUtcMs(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The calendar date "today" in Africa/Kampala for a given instant (default: now). */
export function todayInKampala(now: Date = new Date()): IsoDate {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: KAMPALA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return fromUtcMs(toUtcMs(date) + Math.trunc(days) * MS_PER_DAY);
}

/** Whole days from `from` to `to` (positive if `to` is later). */
export function diffDays(to: IsoDate, from: IsoDate): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / MS_PER_DAY);
}

export function addMonths(date: IsoDate, months: number): IsoDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return fromUtcMs(target.getTime());
}

/** `23 Oct 2026` (NFR-I18N: unambiguous). */
export function formatDate(date: IsoDate | null | undefined): string {
  if (!date) return '';
  const [y, m, d] = date.slice(0, 10).split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** Format an ISO timestamp as `23 Oct 2026, 14:05` in Kampala time. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const dt = new Date(iso);
  const date = todayInKampala(dt);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: KAMPALA_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(dt);
  return `${formatDate(date)}, ${time}`;
}

/** Current instant as an ISO-8601 UTC timestamp string (the storage format for timestamps). */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}
