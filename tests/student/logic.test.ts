/** Pure student view logic: checklist next item, slots, submit blockers, timeline, fixes, upload policy. */
import { describe, expect, it } from 'vitest';
import {
  firstOpenSlot,
  fixItems,
  nextUndone,
  parseSlot,
  ringDash,
  slotsFor,
  submitIssues,
  timelineEntries,
  type ItemLike,
} from '@/components/student/logic';
import { countries, flagEmoji, searchCountries } from '@/components/student/countries';
import { backoffDelay, isRetryable, uploadUrl } from '@/lib/scan/upload-queue';
import { detectKind } from '@/lib/scan/convert';
import { RETRY_MAX_MS } from '@/lib/scan/constants';

const item = (code: string, state: ItemLike['document'] extends infer D ? (D extends { state: infer S } ? S : never) : never, extra: Partial<ItemLike> = {}): ItemLike => ({
  item: { code, name: code.toUpperCase(), minFiles: 1 },
  document: { id: `d-${code}`, state },
  currentVersions: [],
  canUpload: state !== 'approved',
  ...extra,
});

describe('checklist', () => {
  it('next undone prefers rejected items, then missing, skipping done/locked', () => {
    expect(nextUndone([item('a', 'uploaded'), item('b', 'missing'), item('c', 'rejected')])!.item.code).toBe('c');
    expect(nextUndone([item('a', 'uploaded'), item('b', 'missing')])!.item.code).toBe('b');
    expect(nextUndone([item('a', 'uploaded'), item('b', 'approved')])).toBeNull();
    expect(nextUndone([item('a', 'missing', { canUpload: false })])).toBeNull();
  });

  it('page slots for multi-file items (FR-CHK-5)', () => {
    const slots = slotsFor(2, [{ id: 'v1', page: 1 }]);
    expect(slots).toEqual([
      { page: 1, versionId: 'v1' },
      { page: 2, versionId: null },
    ]);
    expect(firstOpenSlot(slots)).toBe(2);
    expect(firstOpenSlot(slotsFor(2, [{ id: 'a', page: 1 }, { id: 'b', page: 2 }]))).toBe(1);
    expect(parseSlot('2', 2)).toBe(2);
    expect(parseSlot('3', 2)).toBeNull();
    expect(parseSlot('x', 2)).toBeNull();
  });

  it('progress ring geometry', () => {
    const { circumference, offset } = ringDash(5, 8, 10);
    expect(offset).toBeCloseTo(circumference * (3 / 8));
    expect(ringDash(0, 0, 10).offset).toBeCloseTo(2 * Math.PI * 10);
  });
});

describe('review: submit blockers (FR-SUB-2)', () => {
  const items = [item('passport_data_page', 'missing'), item('fees_statement', 'uploaded')];
  it('lists every missing thing with jump links, and the confirmation', () => {
    const issues = submitIssues({ missingDocs: ['passport_data_page'], profileErrors: { studentNo: 'x' }, fieldErrors: { currentExpiry: 'y' } }, items, false);
    expect(issues.map((i) => i.href)).toEqual(['/profile?field=studentNo', '/profile?step=3', '/documents/passport_data_page', '#confirm']);
    expect(issues[0]!.label).toMatch(/Student number/);
    expect(issues[2]!.label).toBe('Upload: PASSPORT_DATA_PAGE');
  });
  it('is empty when ready and confirmed', () => {
    expect(submitIssues({ missingDocs: [], profileErrors: {}, fieldErrors: {} }, items, true)).toEqual([]);
    expect(submitIssues({ missingDocs: ['*'], profileErrors: {}, fieldErrors: {} }, items, true)).toEqual([]);
  });
});

describe('status', () => {
  it('timeline maps events, collapses repeat uploads, hides unknown types', () => {
    const ev = (id: string, type: string, data: Record<string, unknown>) => ({ id, type, data, at: `2026-10-2${id}T08:00:00.000Z` });
    const out = timelineEntries(
      [
        ev('1', 'created', {}),
        ev('2', 'document_uploaded', { docCode: 'fees_statement' }),
        ev('3', 'document_uploaded', { docCode: 'fees_statement' }),
        ev('4', 'status_changed', { to: 'submitted' }),
        ev('5', 'claimed', {}),
        ev('6', 'document_reviewed', { docCode: 'fees_statement', decision: 'reject' }),
        ev('7', 'status_changed', { to: 'corrections_needed' }),
      ],
      (c) => (c === 'fees_statement' ? 'Fees statement' : c),
    );
    expect(out.map((e) => e.label)).toEqual([
      'Application started',
      'Uploaded Fees statement',
      'Submitted',
      'Fees statement needs fixing',
      'Status: Needs your attention',
    ]);
    expect(out[4]!.tone).toBe('warn');
  });

  it('fix items show the DOS reason and note, rejected only', () => {
    const fixes = fixItems(
      [
        item('passport_data_page', 'rejected', { document: { id: 'd', state: 'rejected', reviewerReasonCode: 'glare', reviewerNote: 'Left corner' } }),
        item('fees_statement', 'approved'),
      ],
      { glare: { label: 'Glare hides details', body: 'Move away from direct light and retake.' } },
    );
    expect(fixes).toEqual([
      { code: 'passport_data_page', name: 'PASSPORT_DATA_PAGE', reason: 'Glare hides details. Move away from direct light and retake.', note: 'Left corner', href: '/documents/passport_data_page' },
    ]);
  });
});

describe('nationality select data', () => {
  it('builds flags from regional indicators', () => {
    expect(flagEmoji('KE')).toBe('\u{1F1F0}\u{1F1EA}');
    expect(flagEmoji('ug')).toBe('\u{1F1FA}\u{1F1EC}');
    expect(flagEmoji('X')).toBe('');
  });
  it('searches by name, word prefix and code; East Africa first when empty', () => {
    const list = countries();
    expect(list.length).toBeGreaterThan(240);
    expect(searchCountries(list, 'ken')[0]!.code).toBe('KE');
    expect(searchCountries(list, 'tz')[0]!.code).toBe('TZ');
    expect(searchCountries(list, 'sudan').map((c) => c.code)).toEqual(expect.arrayContaining(['SD', 'SS']));
    expect(searchCountries(list, '').slice(0, 3).map((c) => c.code)).toEqual(['KE', 'TZ', 'RW']);
  });
});

describe('upload resilience policy (FR-UP-4)', () => {
  it('exponential backoff with jitter, capped', () => {
    expect(backoffDelay(0, () => 0)).toBe(500);
    expect(backoffDelay(0, () => 1)).toBe(1000);
    expect(backoffDelay(3, () => 1)).toBe(8000);
    expect(backoffDelay(20, () => 1)).toBe(RETRY_MAX_MS);
  });
  it('retries network/5xx/429/seq conflicts, not validation or authz', () => {
    expect(isRetryable(0)).toBe(true);
    expect(isRetryable(503)).toBe(true);
    expect(isRetryable(429)).toBe(true);
    expect(isRetryable(409, 'CONFLICT')).toBe(true);
    expect(isRetryable(409, 'INVALID_STATE')).toBe(false);
    expect(isRetryable(422)).toBe(false);
    expect(isRetryable(404)).toBe(false);
  });
  it('puts the meta in the query string so the server fails fast', () => {
    expect(uploadUrl({ applicationId: 'a b', docCode: 'admission_letter', slot: 2 })).toBe('/api/uploads?applicationId=a+b&docCode=admission_letter&slot=2');
  });
});

describe('input detection (FR-UP-1)', () => {
  const blob = (bytes: number[], type = '', name?: string) => Object.assign(new Blob([new Uint8Array(bytes)], { type }), name ? { name } : {});
  it('uses MIME type, extension, then magic bytes', async () => {
    expect(await detectKind(blob([], 'image/heic'))).toBe('heic');
    expect(await detectKind(blob([], '', 'IMG_0001.HEIC'))).toBe('heic');
    expect(await detectKind(blob([], 'application/pdf'))).toBe('pdf');
    expect(await detectKind(blob([], 'image/png'))).toBe('image');
    // iPhone HEIC with no type/name: ....ftypheic
    expect(await detectKind(blob([0, 0, 0, 24, ...[...'ftypheic'].map((c) => c.charCodeAt(0)), 0, 0, 0, 0]))).toBe('heic');
    expect(await detectKind(blob([...'%PDF-1.7'].map((c) => c.charCodeAt(0))))).toBe('pdf');
    expect(await detectKind(blob([0xff, 0xd8, 0xff, 0xe0]))).toBe('image');
    expect(await detectKind(blob([1, 2, 3, 4], 'application/zip', 'x.zip'))).toBe('unsupported');
  });
});
