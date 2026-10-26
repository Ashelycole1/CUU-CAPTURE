import 'server-only';
/**
 * Per-instance, in-process cache for small, hot, rarely-changing GLOBAL reads
 * (docs/PERFORMANCE.md §4 "Caching"). On Turso every query is a network round trip,
 * so caching these saves 1–3 round trips on most pages.
 *
 * What is cached and why it is safe:
 *   - A NON-draft rule set by id (`ruleset:<id>`): published/retired rule sets are
 *     immutable (only drafts can be edited or deleted; publishing changes `status`, which
 *     is not part of the cached `RuleSet`). Cached until invalidated.
 *   - The id of the published rule set (`ruleset:active`), reason templates
 *     (`reason_templates`) and settings (`setting:<key>`): cached for READ_CACHE_TTL_MS.
 *     A change made through the services invalidates THIS instance immediately; OTHER
 *     warm serverless instances keep the old value until their entry expires (≤ 60 s).
 *     Every consumer tolerates that: a student who starts a draft within 60 s of a
 *     publish gets the previous version (as if they had started a minute earlier, and the
 *     admin can migrate drafts); a new reason template appears in the reject picker
 *     within a minute; a settings change (allowed domains, retention) applies within a minute.
 *
 * Rules:
 *   - NEVER cache per-user or per-application data here (no actor, profile, application
 *     or document data; keys must not contain user ids). Authorization always runs
 *     BEFORE a cached read, and per-actor filtering/redaction AFTER it.
 *   - Values are deep-frozen, so a caller that tries to mutate a shared cached object
 *     fails loudly instead of corrupting it for other requests.
 *   - Failed loads are not cached; concurrent misses for one key share one load.
 *
 * The cache lives on the serverless instance (module scope; Vercel reuses warm
 * instances) and is namespaced by the database handle, so tests that swap databases
 * never see each other's entries.
 */
import { getDb, type Db } from '../db/client';

export const READ_CACHE_TTL_MS = 60_000;

/** Cache keys (prefix-invalidated). */
export const CacheKeys = {
  ruleSet: (id: string) => `ruleset:${id}`,
  activeRuleSetId: 'ruleset:active',
  reasonTemplates: 'reason_templates',
  setting: (key: string) => `setting:${key}`,
} as const;

interface Entry {
  value: unknown;
  /** Epoch ms; Infinity = until invalidated. */
  expires: number;
}

interface Space {
  entries: Map<string, Entry>;
  inflight: Map<string, Promise<unknown>>;
  /** Bumped on every invalidation, so a load that started before it is not stored. */
  generation: number;
}

const g = globalThis as unknown as { __visadeskReadCache?: WeakMap<Db, Space> };
const spaces = (g.__visadeskReadCache ??= new WeakMap());

function space(): Space {
  const db = getDb();
  let s = spaces.get(db);
  if (!s) {
    s = { entries: new Map(), inflight: new Map(), generation: 0 };
    spaces.set(db, s);
  }
  return s;
}

/** Recursively freeze plain objects/arrays (cached values are shared between requests). */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/** Cached value for `key`, loading it on a miss. `ttlMs = Infinity` keeps it until invalidated. */
export async function cachedRead<T>(key: string, ttlMs: number, load: () => Promise<T>, now: number = Date.now()): Promise<T> {
  const s = space();
  const hit = s.entries.get(key);
  if (hit && hit.expires > now) return hit.value as T;
  const pending = s.inflight.get(key);
  if (pending) return pending as Promise<T>;
  const gen = s.generation;
  const p: Promise<T> = Promise.resolve().then(load).then(
    (loaded) => {
      const value = deepFreeze(loaded);
      if (s.inflight.get(key) === p) s.inflight.delete(key);
      if (s.generation === gen) s.entries.set(key, { value, expires: now + ttlMs });
      return value;
    },
    (err: unknown) => {
      if (s.inflight.get(key) === p) s.inflight.delete(key);
      throw err;
    },
  );
  s.inflight.set(key, p);
  return p;
}

/** Store a value directly (e.g. one loaded inside a transaction). */
export function putCachedRead(key: string, value: unknown, ttlMs: number, now: number = Date.now()): void {
  space().entries.set(key, { value: deepFreeze(value), expires: now + ttlMs });
}

export function peekCachedRead<T>(key: string, now: number = Date.now()): T | undefined {
  const hit = space().entries.get(key);
  return hit && hit.expires > now ? (hit.value as T) : undefined;
}

/** Drop entries whose key starts with `prefix` (all entries when omitted) on THIS instance. */
export function invalidateReadCache(prefix?: string): void {
  const s = space();
  s.generation++;
  if (!prefix) {
    s.entries.clear();
    s.inflight.clear();
    return;
  }
  for (const k of [...s.entries.keys()]) if (k.startsWith(prefix)) s.entries.delete(k);
  for (const k of [...s.inflight.keys()]) if (k.startsWith(prefix)) s.inflight.delete(k);
}

/** Keys currently cached on this instance (tests / diagnostics). */
export function readCacheKeys(): string[] {
  return [...space().entries.keys()];
}
