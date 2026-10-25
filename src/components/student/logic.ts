/**
 * Pure view logic for the student pages (checklist, capture, review, status).
 * No React, no server imports, so it is unit-testable and safe in client code.
 */
import { formatDateTime } from '@/domain/dates';
import type { ApplicationStatus, DocumentState } from '@/domain/types';
import { studentStatusCopy } from '@/domain/status';
import { interpolate } from '@/i18n';
import { studentText } from '@/i18n/student';

/** Minimal shapes so tests do not need full service rows. */
export interface ItemLike {
  item: { code: string; name: string; minFiles: number };
  document: { id: string; state: DocumentState; reviewerReasonCode?: string | null; reviewerNote?: string | null } | null;
  currentVersions: { id: string; page: number; uploadedAt?: string }[];
  canUpload: boolean;
}

export const docHref = (code: string, slot?: number) => `/documents/${encodeURIComponent(code)}${slot ? `?slot=${slot}` : ''}`;

export function isDone(state: DocumentState | undefined): boolean {
  return state === 'uploaded' || state === 'approved';
}

/** The next thing to do: rejected items first, then missing ones, in checklist order. */
export function nextUndone<T extends ItemLike>(items: T[]): T | null {
  const open = items.filter((i) => i.canUpload && !isDone(i.document?.state));
  return open.find((i) => i.document?.state === 'rejected') ?? open[0] ?? null;
}

export interface Slot {
  page: number;
  versionId: string | null;
}

/** Page slots for multi-file items (FR-CHK-5): "Page 1 ✓ · Page 2 +". */
export function slotsFor(minFiles: number, versions: { id: string; page: number }[]): Slot[] {
  return Array.from({ length: Math.max(1, minFiles) }, (_, i) => ({
    page: i + 1,
    versionId: versions.find((v) => v.page === i + 1)?.id ?? null,
  }));
}

/** First empty slot, else 1 (replace). */
export function firstOpenSlot(slots: Slot[]): number {
  return slots.find((s) => !s.versionId)?.page ?? 1;
}

/** Clamp a ?slot= query value to 1..minFiles. */
export function parseSlot(raw: string | string[] | undefined, minFiles: number): number | null {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isInteger(n) && n >= 1 && n <= Math.max(1, minFiles) ? n : null;
}

export interface Blockers {
  missingDocs: string[];
  profileErrors: Record<string, string>;
  fieldErrors: Record<string, string>;
}

export interface SubmitIssue {
  key: string;
  label: string;
  href: string;
}

/** What blocks submission, as jump links (FR-SUB-2). */
export function submitIssues(blockers: Blockers, items: { item: { code: string; name: string } }[], confirmed: boolean): SubmitIssue[] {
  const r = studentText.review;
  const out: SubmitIssue[] = [];
  for (const field of Object.keys(blockers.profileErrors)) {
    const name = r.fields[field as keyof typeof r.fields] ?? field;
    out.push({ key: `profile:${field}`, label: interpolate(r.profileIssue, { field: name }), href: `/profile?field=${field}` });
  }
  if (Object.keys(blockers.fieldErrors).length) out.push({ key: 'fields', label: r.fieldIssue, href: '/profile?step=3' });
  for (const code of blockers.missingDocs) {
    if (code === '*') continue; // no checklist yet (profile incomplete) — the profile issue covers it
    const name = items.find((i) => i.item.code === code)?.item.name ?? humanize(code);
    out.push({ key: `doc:${code}`, label: interpolate(r.missingDoc, { doc: name }), href: docHref(code) });
  }
  if (!confirmed) out.push({ key: 'confirm', label: r.confirmNeeded, href: '#confirm' });
  return out;
}

export function humanize(code: string): string {
  const s = code.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface EventLike {
  id: string;
  type: string;
  data: Record<string, unknown>;
  at: string;
}

export interface TimelineEntry {
  id: string;
  label: string;
  at: string;
  when: string;
  tone: 'neutral' | 'ok' | 'warn' | 'info';
}

/** Student timeline (design §6.2): newest last; uploads collapsed per document. */
export function timelineEntries(events: EventLike[], docName: (code: string) => string): TimelineEntry[] {
  const e = studentText.status.events;
  const out: TimelineEntry[] = [];
  for (const ev of events) {
    const doc = typeof ev.data.docCode === 'string' ? docName(ev.data.docCode) : '';
    let label: string | null = null;
    let tone: TimelineEntry['tone'] = 'neutral';
    switch (ev.type) {
      case 'created':
        label = e.created;
        break;
      case 'status_changed': {
        const to = ev.data.to as ApplicationStatus | undefined;
        if (!to) break;
        label = to === 'submitted' ? e.submitted : interpolate(e.status, { label: studentStatusCopy(to).label });
        tone = to === 'corrections_needed' ? 'warn' : to === 'approved' || to === 'pass_issued' ? 'ok' : 'info';
        break;
      }
      case 'document_uploaded':
        label = interpolate(ev.data.wasRejected ? e.document_reuploaded : e.document_uploaded, { doc });
        // Collapse repeated uploads of the same document into the latest entry.
        for (let i = out.length - 1; i >= 0; i--) {
          if (out[i]!.id.startsWith(`up:${ev.data.docCode}:`)) {
            out.splice(i, 1);
            break;
          }
        }
        out.push({ id: `up:${ev.data.docCode}:${ev.id}`, label, at: ev.at, when: formatDateTime(ev.at), tone });
        label = null;
        break;
      case 'document_reviewed':
        label = interpolate(ev.data.decision === 'approve' ? e.document_reviewed_approve : e.document_reviewed_reject, { doc });
        tone = ev.data.decision === 'approve' ? 'ok' : 'warn';
        break;
      case 'fee_paid':
        label = e.fee_paid;
        tone = 'ok';
        break;
      default:
        label = null; // unknown / staff-only types are not shown
    }
    if (label) out.push({ id: ev.id, label, at: ev.at, when: formatDateTime(ev.at), tone });
  }
  return out;
}

export interface FixItem {
  code: string;
  name: string;
  reason: string;
  note: string | null;
  href: string;
}

/** Rejected documents first, with the DOS reason (design §6.2, PRD story 3). */
export function fixItems(items: ItemLike[], reasons: Record<string, { label: string; body: string }>): FixItem[] {
  return items
    .filter((i) => i.document?.state === 'rejected')
    .map((i) => {
      const code = i.document!.reviewerReasonCode ?? '';
      const r = reasons[code];
      return {
        code: i.item.code,
        name: i.item.name,
        reason: r ? (r.body ? `${r.label}. ${r.body}` : r.label) : code ? humanize(code) : '',
        note: i.document!.reviewerNote ?? null,
        href: docHref(i.item.code),
      };
    });
}

/** Progress ring geometry. */
export function ringDash(done: number, total: number, radius: number): { circumference: number; offset: number } {
  const circumference = 2 * Math.PI * radius;
  const frac = total > 0 ? Math.min(1, done / total) : 0;
  return { circumference, offset: circumference * (1 - frac) };
}
