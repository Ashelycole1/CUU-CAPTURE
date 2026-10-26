/**
 * Per-instance read cache (src/server/services/read-cache.ts, docs/PERFORMANCE.md §4):
 * mechanics, invalidation on every write path, and no per-user data in the cache.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdmin, createStaff, createStudent, createTestDb, type TestDb } from '../helpers/db';
import { createDraft, uploadDoc } from '../helpers/factories';
import { instrumentClient, measure, type Instrumented } from '../perf/instrument';
import { RULE_DOCUMENTS_V1, RULE_SET_V1 } from '@/server/db/seed-data';
import { setDbOverride } from '@/server/db/client';
import {
  CacheKeys,
  cachedRead,
  deepFreeze,
  invalidateReadCache,
  peekCachedRead,
  putCachedRead,
  readCacheKeys,
  READ_CACHE_TTL_MS,
} from '@/server/services/read-cache';
import {
  createRuleSetDraft,
  getActiveRuleSet,
  getApplicationDetail,
  getChecklistForApplication,
  getOrCreateDraft,
  getRuleSet,
  listReasonTemplates,
  publishRuleSet,
  updateSetting,
} from '@/server/services';
import { saveReasonTemplate, saveRuleSetDraft } from '@/server/services/admin';
import { getAllowedEmailDomains, getRetentionDays } from '@/server/services/settings';
import { getReasonLabelsForApplication } from '@/server/services/student-view';
import { ForbiddenError, NotFoundError } from '@/server/errors';
import type { Actor } from '@/server/authz';

let t: TestDb;
let inst: Instrumented;
let admin: Actor;

beforeAll(async () => {
  t = await createTestDb();
  inst = instrumentClient(t.handle.client);
  admin = await createAdmin(t.db);
});
afterAll(async () => {
  inst.restore();
  await t.cleanup();
});
beforeEach(() => invalidateReadCache());

describe('cachedRead mechanics', () => {
  it('serves hits until the TTL expires', async () => {
    let loads = 0;
    const load = async () => ({ n: ++loads });
    const t0 = 1_000_000;
    expect(await cachedRead('k', 1000, load, t0)).toEqual({ n: 1 });
    expect(await cachedRead('k', 1000, load, t0 + 999)).toEqual({ n: 1 });
    expect(await cachedRead('k', 1000, load, t0 + 1000)).toEqual({ n: 2 });
    expect(loads).toBe(2);
  });

  it('shares one load between concurrent misses', async () => {
    let loads = 0;
    const load = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 10));
      return loads;
    };
    const r = await Promise.all([cachedRead('c', 1000, load), cachedRead('c', 1000, load), cachedRead('c', 1000, load)]);
    expect(r).toEqual([1, 1, 1]);
    expect(loads).toBe(1);
  });

  it('does not cache failed loads', async () => {
    await expect(cachedRead('f', 1000, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await cachedRead('f', 1000, async () => 'ok')).toBe('ok');
  });

  it('does not store a load that an invalidation overtook', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = cachedRead('slow', 1000, async () => {
      await gate;
      return 'old';
    });
    invalidateReadCache('slow'); // a write landed while the read was in flight
    release();
    expect(await p).toBe('old');
    expect(peekCachedRead('slow')).toBeUndefined();
    expect(await cachedRead('slow', 1000, async () => 'new')).toBe('new');
  });

  it('invalidates by prefix only', async () => {
    putCachedRead('setting:a', 1, Infinity);
    putCachedRead('setting:b', 2, Infinity);
    putCachedRead('ruleset:x', 3, Infinity);
    invalidateReadCache('setting:');
    expect(readCacheKeys().sort()).toEqual(['ruleset:x']);
  });

  it('deep-freezes cached values', async () => {
    const v = await cachedRead('obj', 1000, async () => ({ list: [{ a: 1 }] }));
    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v.list[0])).toBe(true);
    expect(() => {
      (v.list as { a: number }[]).push({ a: 2 });
    }).toThrow(TypeError);
    expect(deepFreeze(null)).toBeNull();
  });

  it('is namespaced per database handle', async () => {
    putCachedRead('ns', 'first-db', Infinity);
    const other = await createTestDb();
    try {
      expect(peekCachedRead('ns')).toBeUndefined();
      putCachedRead('ns', 'second-db', Infinity);
    } finally {
      await other.cleanup();
      setDbOverride(t.handle);
    }
    expect(peekCachedRead('ns')).toBe('first-db');
  });
});

describe('rule sets', () => {
  it('a published rule set costs 0 round trips once warm', async () => {
    const cold = await measure(inst, () => getActiveRuleSet());
    expect(cold.counter.roundTrips).toBe(3); // active id + rule set + documents
    const warm = await measure(inst, () => getActiveRuleSet());
    expect(warm.counter.roundTrips).toBe(0);
    expect(warm.result).toEqual(cold.result);
  });

  it('never caches a draft, so draft edits are visible immediately', async () => {
    const draft = await createRuleSetDraft(admin, { ...RULE_SET_V1, documents: RULE_DOCUMENTS_V1 });
    expect(peekCachedRead(CacheKeys.ruleSet(draft.id))).toBeUndefined();
    await saveRuleSetDraft(admin, draft.id, { ...RULE_SET_V1, feeUsd: 777, documents: RULE_DOCUMENTS_V1 });
    expect((await getRuleSet(draft.id)).feeUsd).toBe(777);
    expect(peekCachedRead(CacheKeys.ruleSet(draft.id))).toBeUndefined();

    // Publishing switches the active rule set on this instance at once …
    const before = await getActiveRuleSet();
    await publishRuleSet(admin, draft.id);
    const after = await getActiveRuleSet();
    expect(after.id).toBe(draft.id);
    expect(after.version).toBe(before.version + 1);
    // … new drafts use it, and the now-immutable version is cached.
    const s = await createStudent(t.db, { nationality: 'KE', studentType: 'new' });
    expect((await getOrCreateDraft(s)).ruleSetId).toBe(draft.id);
    expect(peekCachedRead(CacheKeys.ruleSet(draft.id))).toBeDefined();
  });

  it('other instances see a publish within the TTL (modelled with the clock)', async () => {
    const id = (await getActiveRuleSet()).id;
    // A stale entry on "another instance" is replaced once it expires.
    putCachedRead(CacheKeys.activeRuleSetId, 'stale-id', READ_CACHE_TTL_MS, Date.now() - READ_CACHE_TTL_MS - 1);
    expect((await getActiveRuleSet()).id).toBe(id);
  });
});

describe('reason templates', () => {
  it('a saved template is visible immediately; inactive ones are filtered per call', async () => {
    const staff = await createStaff(t.db);
    const first = await listReasonTemplates(staff);
    const warm = await measure(inst, () => listReasonTemplates(staff));
    expect(warm.counter.roundTrips).toBe(0);
    await saveReasonTemplate(admin, { code: 'perf_tpl', label: 'Perf template', body: 'Body', active: true, sort: 999 });
    expect((await listReasonTemplates(staff)).map((r) => r.code)).toContain('perf_tpl');
    await saveReasonTemplate(admin, { code: 'perf_tpl', label: 'Perf template', body: 'Body', active: false, sort: 999 });
    expect((await listReasonTemplates(staff)).map((r) => r.code)).not.toContain('perf_tpl');
    expect((await listReasonTemplates(staff, { includeInactive: true })).map((r) => r.code)).toContain('perf_tpl');
    expect(first.length).toBeGreaterThan(0);
  });

  it('authorization still runs on a warm cache', async () => {
    const staff = await createStaff(t.db);
    await listReasonTemplates(staff); // warm
    const student = await createStudent(t.db);
    await expect(listReasonTemplates(student)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a student cannot read reason labels through another student's application", async () => {
    const a = await createDraft(t.db);
    const b = await createDraft(t.db);
    expect(await getReasonLabelsForApplication(a.student, a.app.id, ['blurry'])).toHaveProperty('blurry');
    await expect(getReasonLabelsForApplication(b.student, a.app.id, ['blurry'])).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('settings', () => {
  it('updateSetting is visible immediately on this instance', async () => {
    expect(await getRetentionDays(t.db)).toBe(90);
    await updateSetting(admin, 'retention_days', 120);
    expect(await getRetentionDays(t.db)).toBe(120);
    await updateSetting(admin, 'allowed_email_domains', ['Example.AC.UG']);
    expect(await getAllowedEmailDomains(t.db)).toEqual(['example.ac.ug']);
    const warm = await measure(inst, () => getAllowedEmailDomains(t.db));
    expect(warm.counter.roundTrips).toBe(0);
  });
});

describe('no per-user data in the cache', () => {
  it('only global keys are cached after student and staff reads, and each actor sees only their own data', async () => {
    const a = await createDraft(t.db, { nationality: 'KE', studentType: 'new' });
    const b = await createDraft(t.db, { nationality: 'NG', studentType: 'continuing' });
    await uploadDoc(a.student, a.app.id, 'passport_data_page');
    const staff = await createStaff(t.db);
    const ca = await getChecklistForApplication(a.student, a.app.id);
    const cb = await getChecklistForApplication(b.student, b.app.id);
    const da = await getApplicationDetail(staff, a.app.id);
    await getApplicationDetail(b.student, b.app.id);
    await listReasonTemplates(staff);

    const keys = readCacheKeys();
    for (const k of keys) {
      expect(k).toMatch(/^(ruleset:[0-9a-f-]+|ruleset:active|reason_templates|setting:[a-z_]+)$/);
      for (const id of [a.student.id, b.student.id, staff.id, a.app.id, b.app.id]) expect(k).not.toContain(id);
    }
    // Per-application data is never shared between students.
    expect(ca.applicationId).toBe(a.app.id);
    expect(cb.applicationId).toBe(b.app.id);
    expect(ca.items.find((i) => i.item.code === 'passport_data_page')!.document!.state).toBe('uploaded');
    expect(cb.items.find((i) => i.item.code === 'passport_data_page')!.document!.state).toBe('missing');
    expect(da.application.id).toBe(a.app.id);
    // Students cannot read each other's applications on a warm cache.
    await expect(getChecklistForApplication(b.student, a.app.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getApplicationDetail(b.student, a.app.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('the detail view builds the same checklist as the checklist service', async () => {
    const a = await createDraft(t.db, { nationality: 'KE', studentType: 'new' });
    await uploadDoc(a.student, a.app.id, 'passport_data_page');
    await uploadDoc(a.student, a.app.id, 'passport_data_page'); // supersedes the first version
    const c = await getChecklistForApplication(a.student, a.app.id);
    const d = await getApplicationDetail(a.student, a.app.id);
    expect(d.checklist).toEqual(c);
    const entry = c.items.find((i) => i.item.code === 'passport_data_page')!;
    expect(entry.currentVersions).toHaveLength(1);
    expect(d.documents.find((x) => x.docCode === 'passport_data_page')!.versions).toHaveLength(2);
  });
});
