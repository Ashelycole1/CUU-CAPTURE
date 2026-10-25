import { describe, expect, it } from 'vitest';
import { dashboardSearch, flagEmoji, hasActiveFilters, parseDashboardParams, sameFilters, TILE_FILTERS } from '@/components/staff/dashboard-params';

describe('dashboard URL params', () => {
  it('parses valid values and drops junk', () => {
    const q = parseDashboardParams({
      q: '  okello ',
      status: 'submitted,bogus,under_review',
      type: 'new',
      nat: 'ke, ng,XYZ',
      risk: 'critical',
      fee: 'unpaid',
      from: '2026-10-01',
      to: 'nope',
      sort: 'expiry',
      mine: '1',
      cursor: 'abc_-1',
    });
    expect(q.filters).toEqual({
      q: 'okello',
      status: ['submitted', 'under_review'],
      studentType: ['new'],
      nationality: ['KE', 'NG'],
      riskBand: ['critical'],
      feeStatus: ['unpaid'],
      submittedFrom: '2026-10-01',
      claimedByMe: true,
    });
    expect(q.sort).toBe('expiry');
    expect(q.cursor).toBe('abc_-1');
    expect(parseDashboardParams({ sort: 'evil', cursor: '<script>' })).toEqual({ filters: {}, sort: 'risk', cursor: null });
  });

  it('round-trips through the query string', () => {
    const f = { status: ['approved' as const], nationality: ['KE'], includeDrafts: true };
    const s = dashboardSearch(f, 'name', 'cur');
    expect(s).toBe('?status=approved&nat=KE&drafts=1&sort=name&cursor=cur');
    const back = parseDashboardParams(Object.fromEntries(new URLSearchParams(s.slice(1))));
    expect(back.filters).toEqual(f);
    expect(dashboardSearch({}, 'risk')).toBe('');
  });

  it('compares filters order-insensitively and detects tiles', () => {
    expect(sameFilters({ status: ['under_review', 'submitted'] }, TILE_FILTERS.needsReview)).toBe(true);
    expect(sameFilters({ status: ['submitted'] }, TILE_FILTERS.needsReview)).toBe(false);
    expect(hasActiveFilters({})).toBe(false);
    expect(hasActiveFilters({ claimedByMe: true })).toBe(true);
    expect(flagEmoji('ke')).toBe('\u{1F1F0}\u{1F1EA}');
    expect(flagEmoji('???')).toBe('');
  });
});
