/**
 * Rule-set diff and plain-language impact summary (FR-ADM-1, design §7.5).
 * Pure functions (no DB, no server-only) so the admin UI and tests can use them.
 */
import type { RuleDocument, RuleSet, StudentType } from '@/domain/types';
import { interpolate } from '@/i18n';
import { admin as A } from '@/i18n/admin';

export interface RuleSetLike extends Omit<RuleSet, 'id'> {
  id?: string;
  feeNote?: string | null;
  submissionEmail?: string | null;
}

export interface FieldChange {
  key: string;
  label: string;
  from: string;
  to: string;
}

export interface DocChange {
  code: string;
  name: string;
  changes: FieldChange[];
}

export interface RuleSetDiff {
  fields: FieldChange[];
  exemptAdded: string[];
  exemptRemoved: string[];
  docsAdded: RuleDocument[];
  docsRemoved: RuleDocument[];
  docsChanged: DocChange[];
  /** true when nothing differs. */
  empty: boolean;
}

const list = (xs: readonly (string | number)[]) => (xs.length ? xs.join(', ') : '—');
const types = (t: StudentType[] | null) => (t && t.length ? t.join(', ') : 'all');

export function audienceLabel(t: StudentType[] | null): string {
  if (!t || t.length === 0) return A.rules.audience.all;
  const names = t.map((x) => A.rules.audience[x]);
  return interpolate(A.rules.audience.students, {
    who: names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`,
  });
}

export function diffRuleSets(base: RuleSetLike | null, next: RuleSetLike): RuleSetDiff {
  const fields: FieldChange[] = [];
  const F = A.rules.fields;
  const cmp = (key: keyof typeof F, from: unknown, to: unknown, fmt: (v: never) => string = (v) => String(v ?? '—')) => {
    const a = fmt(from as never);
    const b = fmt(to as never);
    if (a !== b) fields.push({ key, label: F[key], from: a, to: b });
  };
  if (base) {
    cmp('feeUsd', base.feeUsd, next.feeUsd);
    cmp('feeNote', base.feeNote ?? '', next.feeNote ?? '');
    cmp('penaltyUsdPerDay', base.penaltyUsdPerDay, next.penaltyUsdPerDay);
    cmp('applyBeforeDays', base.applyBeforeDays, next.applyBeforeDays);
    cmp('maxPassMonths', base.maxPassMonths, next.maxPassMonths);
    cmp('reminderDays', base.reminderDays, next.reminderDays, (v: number[]) => list([...v].sort((x, y) => y - x)));
    cmp('submissionEmail', base.submissionEmail ?? '', next.submissionEmail ?? '');
    cmp('noticeDate', base.noticeDate ?? '', next.noticeDate ?? '');
  }
  const baseEx = new Set((base?.exemptCountries ?? []).map((c) => c.toUpperCase()));
  const nextEx = new Set(next.exemptCountries.map((c) => c.toUpperCase()));
  const exemptAdded = base ? [...nextEx].filter((c) => !baseEx.has(c)).sort() : [];
  const exemptRemoved = base ? [...baseEx].filter((c) => !nextEx.has(c)).sort() : [];

  const baseDocs = new Map((base?.documents ?? []).map((d) => [d.code, d]));
  const nextDocs = new Map(next.documents.map((d) => [d.code, d]));
  const docsAdded = base ? next.documents.filter((d) => !baseDocs.has(d.code)) : [];
  const docsRemoved = base ? (base.documents ?? []).filter((d) => !nextDocs.has(d.code)) : [];
  const docsChanged: DocChange[] = [];
  const D = A.rules.docFields;
  for (const d of next.documents) {
    const b = baseDocs.get(d.code);
    if (!b) continue;
    const changes: FieldChange[] = [];
    const c = (key: keyof typeof D, from: string, to: string) => {
      if (from !== to) changes.push({ key, label: D[key], from: from || '—', to: to || '—' });
    };
    c('name', b.name, d.name);
    c('appliesToTypes', types(b.appliesToTypes), types(d.appliesToTypes));
    c('minFiles', String(b.minFiles), String(d.minFiles));
    c('helpText', b.helpText, d.helpText);
    c('whereToGet', b.whereToGet, d.whereToGet);
    c('examplePath', b.examplePath ?? '', d.examplePath ?? '');
    c('source', b.source, d.source);
    if (changes.length) docsChanged.push({ code: d.code, name: d.name, changes });
  }
  const empty = !fields.length && !exemptAdded.length && !exemptRemoved.length && !docsAdded.length && !docsRemoved.length && !docsChanged.length;
  return { fields, exemptAdded, exemptRemoved, docsAdded, docsRemoved, docsChanged, empty };
}

export interface ImpactContext {
  baseVersion: number | null;
  nextVersion: number;
  /** Submitted-or-later in-flight applications per rule-set version (they keep their version). */
  inFlight: { version: number; count: number }[];
  /** Draft applications on older versions (can be migrated after publishing). */
  drafts: number;
}

/** Plain-language sentences, e.g. "Adds 1 document for Masters students: Transcripts." */
export function impactSummary(diff: RuleSetDiff, ctx: ImpactContext): string[] {
  const S = A.rules.impact;
  const out: string[] = [];
  if (ctx.baseVersion === null) out.push(interpolate(S.first, { version: ctx.nextVersion }));
  else if (diff.empty) out.push(interpolate(S.noChanges, { version: ctx.baseVersion }));

  const byAudience = new Map<string, RuleDocument[]>();
  for (const d of diff.docsAdded) {
    const k = audienceLabel(d.appliesToTypes);
    byAudience.set(k, [...(byAudience.get(k) ?? []), d]);
  }
  for (const [who, docs] of byAudience) {
    out.push(interpolate(docs.length === 1 ? S.addsOne : S.addsMany, { count: docs.length, who, names: docs.map((d) => d.name).join(', ') }));
  }
  for (const d of diff.docsRemoved) out.push(interpolate(S.removes, { name: d.name, who: audienceLabel(d.appliesToTypes) }));
  for (const d of diff.docsChanged) {
    out.push(interpolate(S.changesDoc, { name: d.name, what: d.changes.map((c) => `${c.label.toLowerCase()} ${c.from} → ${c.to}`).join('; ') }));
  }
  for (const f of diff.fields) out.push(interpolate(S.changesField, { label: f.label, from: f.from, to: f.to }));
  if (diff.exemptAdded.length) out.push(interpolate(S.exemptAdded, { list: diff.exemptAdded.join(', ') }));
  if (diff.exemptRemoved.length) out.push(interpolate(S.exemptRemoved, { list: diff.exemptRemoved.join(', ') }));

  for (const g of ctx.inFlight.filter((g) => g.count > 0).sort((a, b) => b.version - a.version)) {
    out.push(interpolate(g.count === 1 ? S.keepsOne : S.keepsMany, { count: g.count, version: g.version }));
  }
  if (ctx.drafts > 0) out.push(interpolate(ctx.drafts === 1 ? S.draftsOne : S.draftsMany, { count: ctx.drafts, version: ctx.nextVersion }));
  return out;
}
