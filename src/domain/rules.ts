/**
 * Rule engine (architecture §5). Pure functions over rule-set data.
 * "today" is always a Kampala calendar date (see `todayInKampala`).
 */
import { addDays, diffDays, type IsoDate } from './dates';
import type { RiskBand, RuleDocument, RuleSet, StudentType } from './types';

export interface ChecklistItem extends RuleDocument {
  /** Tagged "Required by the university" in the UI (FR-CHK-4). */
  universityAddition: boolean;
}

export interface Checklist {
  ruleSetId: string;
  ruleSetVersion: number;
  items: ChecklistItem[];
  feeRequired: boolean;
  feeUsd: number;
  penaltyUsdPerDay: number;
  applyBeforeDays: number;
  applyBy(expiry: IsoDate): IsoDate;
  riskBand(expiry: IsoDate | null, today: IsoDate): RiskBand;
  penaltyEstimate(expiry: IsoDate | null, today: IsoDate): number;
}

export interface ChecklistInput {
  studentType: StudentType;
  nationality: string; // ISO 3166-1 alpha-2
}

export function documentAppliesTo(doc: Pick<RuleDocument, 'appliesToTypes'>, studentType: StudentType): boolean {
  return !doc.appliesToTypes || doc.appliesToTypes.length === 0 || doc.appliesToTypes.includes(studentType);
}

export function isFeeExempt(ruleSet: Pick<RuleSet, 'exemptCountries'>, nationality: string): boolean {
  const n = nationality.trim().toUpperCase();
  return ruleSet.exemptCountries.map((c) => c.toUpperCase()).includes(n);
}

export function computeChecklist(ruleSet: RuleSet, input: ChecklistInput): Checklist {
  const items = ruleSet.documents
    .filter((d) => documentAppliesTo(d, input.studentType))
    .sort((a, b) => a.sort - b.sort)
    .map((d) => ({ ...d, universityAddition: d.source === 'student_addition' }));
  return {
    ruleSetId: ruleSet.id,
    ruleSetVersion: ruleSet.version,
    items,
    feeRequired: !isFeeExempt(ruleSet, input.nationality),
    feeUsd: ruleSet.feeUsd,
    penaltyUsdPerDay: ruleSet.penaltyUsdPerDay,
    applyBeforeDays: ruleSet.applyBeforeDays,
    applyBy: (expiry) => applyBy(expiry, ruleSet.applyBeforeDays),
    riskBand: (expiry, today) => riskBand(expiry, today),
    penaltyEstimate: (expiry, today) => penaltyEstimate(expiry, today, ruleSet.penaltyUsdPerDay),
  };
}

/** expiry minus apply_before_days (FR-RUN-1). */
export function applyBy(expiry: IsoDate, applyBeforeDays: number): IsoDate {
  return addDays(expiry, -applyBeforeDays);
}

export function daysToExpiry(expiry: IsoDate, today: IsoDate): number {
  return diffDays(expiry, today);
}

/**
 * FR-RUN-2: safe (> 60), plan (31–60), urgent (8–30), critical (0–7),
 * expired (< 0), no_pass (no expiry known).
 */
export function riskBand(expiry: IsoDate | null | undefined, today: IsoDate): RiskBand {
  if (!expiry) return 'no_pass';
  const d = diffDays(expiry, today);
  if (d < 0) return 'expired';
  if (d <= 7) return 'critical';
  if (d <= 30) return 'urgent';
  if (d <= 60) return 'plan';
  return 'safe';
}

/** FR-RUN-4: USD rate × days overstayed (0 if not expired). An estimate only. */
export function penaltyEstimate(expiry: IsoDate | null | undefined, today: IsoDate, ratePerDay: number): number {
  if (!expiry) return 0;
  const d = diffDays(expiry, today);
  return d < 0 ? -d * ratePerDay : 0;
}

/**
 * Sort rank used for "risk then expiry" ordering (lower = more urgent).
 * DECISION: no_pass sorts after urgent and before plan (see docs/DECISIONS.md).
 */
export const RISK_RANK: Record<RiskBand, number> = {
  expired: 0,
  critical: 1,
  urgent: 2,
  no_pass: 3,
  plan: 4,
  safe: 5,
};

export interface RunwaySummary {
  band: RiskBand;
  today: IsoDate;
  expiry: IsoDate | null;
  applyBy: IsoDate | null;
  daysToExpiry: number | null;
  daysToApplyBy: number | null;
  penaltyUsd: number;
  penaltyUsdPerDay: number;
}

/** Everything the Runway component needs, computed in one place. */
export function runwaySummary(
  expiry: IsoDate | null | undefined,
  today: IsoDate,
  rules: { applyBeforeDays: number; penaltyUsdPerDay: number },
): RunwaySummary {
  if (!expiry) {
    return {
      band: 'no_pass',
      today,
      expiry: null,
      applyBy: null,
      daysToExpiry: null,
      daysToApplyBy: null,
      penaltyUsd: 0,
      penaltyUsdPerDay: rules.penaltyUsdPerDay,
    };
  }
  const ab = applyBy(expiry, rules.applyBeforeDays);
  return {
    band: riskBand(expiry, today),
    today,
    expiry,
    applyBy: ab,
    daysToExpiry: diffDays(expiry, today),
    daysToApplyBy: diffDays(ab, today),
    penaltyUsd: penaltyEstimate(expiry, today, rules.penaltyUsdPerDay),
    penaltyUsdPerDay: rules.penaltyUsdPerDay,
  };
}
