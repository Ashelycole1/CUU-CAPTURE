import { describe, expect, it } from 'vitest';
import { addDays, addMonths, diffDays, formatDate, isIsoDate, todayInKampala } from '@/domain/dates';
import { applyBy, computeChecklist, penaltyEstimate, riskBand, runwaySummary, RISK_RANK } from '@/domain/rules';
import type { RuleSet } from '@/domain/types';
import { RULE_DOCUMENTS_V1, RULE_SET_V1 } from '@/server/db/seed-data';

const ruleSet: RuleSet = {
  id: 'rs1',
  ...RULE_SET_V1,
  documents: RULE_DOCUMENTS_V1.map((d) => ({ ...d, examplePath: null })),
};

describe('Kampala dates (NFR-I18N)', () => {
  it('computes today in Africa/Kampala (UTC+3)', () => {
    expect(todayInKampala(new Date('2026-10-23T20:59:59Z'))).toBe('2026-10-23');
    expect(todayInKampala(new Date('2026-10-23T21:00:00Z'))).toBe('2026-10-24');
    expect(todayInKampala(new Date('2026-12-31T21:30:00Z'))).toBe('2027-01-01');
  });
  it('adds and diffs days across months, years and leap days', () => {
    expect(addDays('2026-10-23', 15)).toBe('2026-11-07');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(diffDays('2028-03-01', '2028-02-28')).toBe(2);
    expect(diffDays('2027-03-01', '2027-02-28')).toBe(1);
    expect(diffDays('2026-01-01', '2026-01-31')).toBe(-30);
  });
  it('adds months clamping to month end', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-10-23', 12)).toBe('2027-10-23');
  });
  it('formats dates unambiguously', () => {
    expect(formatDate('2026-10-23')).toBe('23 Oct 2026');
    expect(formatDate('2026-01-05')).toBe('5 Jan 2026');
    expect(formatDate(null)).toBe('');
  });
  it('validates ISO dates', () => {
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2027-02-29')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('23/10/2026')).toBe(false);
  });
});

describe('riskBand (FR-RUN-2) boundaries', () => {
  const today = '2026-10-23';
  const at = (d: number) => riskBand(addDays(today, d), today);
  it.each([
    [61, 'safe'],
    [60, 'plan'],
    [31, 'plan'],
    [30, 'urgent'],
    [8, 'urgent'],
    [7, 'critical'],
    [0, 'critical'],
    [-1, 'expired'],
    [-400, 'expired'],
  ])('%i days → %s', (days, band) => {
    expect(at(days as number)).toBe(band);
  });
  it('no expiry → no_pass', () => {
    expect(riskBand(null, today)).toBe('no_pass');
    expect(riskBand(undefined, today)).toBe('no_pass');
  });
  it('works across a leap day', () => {
    // 2028 is a leap year: 22 Feb + 8 days = 1 Mar (29 Feb exists).
    expect(diffDays('2028-03-01', '2028-02-22')).toBe(8);
    expect(riskBand('2028-03-01', '2028-02-22')).toBe('urgent');
    expect(riskBand('2028-02-29', '2028-02-22')).toBe('critical');
    // 2027 is not: 22 Feb + 7 days = 1 Mar.
    expect(riskBand('2027-03-01', '2027-02-22')).toBe('critical');
  });
  it('risk rank orders expired first and safe last', () => {
    expect(RISK_RANK.expired).toBeLessThan(RISK_RANK.critical);
    expect(RISK_RANK.critical).toBeLessThan(RISK_RANK.urgent);
    expect(RISK_RANK.urgent).toBeLessThan(RISK_RANK.plan);
    expect(RISK_RANK.plan).toBeLessThan(RISK_RANK.safe);
  });
});

describe('applyBy and penaltyEstimate (FR-RUN-1/4)', () => {
  it('apply-by is expiry minus apply_before_days', () => {
    expect(applyBy('2026-12-12', 30)).toBe('2026-11-12');
    expect(applyBy('2028-03-30', 30)).toBe('2028-02-29');
  });
  it('penalty is rate × days overstayed, 0 otherwise', () => {
    expect(penaltyEstimate('2026-10-20', '2026-10-23', 20)).toBe(60);
    expect(penaltyEstimate('2026-10-23', '2026-10-23', 20)).toBe(0);
    expect(penaltyEstimate('2026-10-24', '2026-10-23', 20)).toBe(0);
    expect(penaltyEstimate(null, '2026-10-23', 20)).toBe(0);
  });
});

describe('computeChecklist (FR-CHK-1)', () => {
  it('PRD story 1: continuing KE student, expiry in 45 days → 8 items, fee waived, 15 days to apply-by', () => {
    const today = todayInKampala();
    const c = computeChecklist(ruleSet, { studentType: 'continuing', nationality: 'KE' });
    expect(c.items).toHaveLength(8);
    expect(c.items.map((i) => i.code)).toContain('exam_results');
    expect(c.items.map((i) => i.code)).not.toContain('transcripts');
    expect(c.feeRequired).toBe(false);
    const expiry = addDays(today, 45);
    const r = runwaySummary(expiry, today, ruleSet);
    expect(r.daysToApplyBy).toBe(15);
    expect(r.band).toBe('plan');
    expect(diffDays(c.applyBy(expiry), today)).toBe(15);
  });
  it('masters student gets transcripts, not exam results; fee required for NG', () => {
    const c = computeChecklist(ruleSet, { studentType: 'masters', nationality: 'ng' });
    expect(c.items).toHaveLength(8);
    expect(c.items.map((i) => i.code)).toContain('transcripts');
    expect(c.items.map((i) => i.code)).not.toContain('exam_results');
    expect(c.feeRequired).toBe(true);
    expect(c.items.find((i) => i.code === 'transcripts')!.universityAddition).toBe(true);
  });
  it('new student gets the 7 common items', () => {
    const c = computeChecklist(ruleSet, { studentType: 'new', nationality: 'TZ' });
    expect(c.items).toHaveLength(7);
    expect(c.feeRequired).toBe(false);
  });
  it.each(['KE', 'TZ', 'RW', 'BI', 'SS'])('%s is fee exempt', (n) => {
    expect(computeChecklist(ruleSet, { studentType: 'new', nationality: n }).feeRequired).toBe(false);
  });
  it('admission letter requires 2 files (FR-CHK-5)', () => {
    const c = computeChecklist(ruleSet, { studentType: 'new', nationality: 'UG' });
    expect(c.items.find((i) => i.code === 'admission_letter')!.minFiles).toBe(2);
  });
  it('runway summary for expired and no_pass', () => {
    const today = '2026-10-23';
    const r = runwaySummary('2026-10-20', today, ruleSet);
    expect(r.band).toBe('expired');
    expect(r.penaltyUsd).toBe(60);
    expect(r.daysToExpiry).toBe(-3);
    const n = runwaySummary(null, today, ruleSet);
    expect(n.band).toBe('no_pass');
    expect(n.applyBy).toBeNull();
  });
});
