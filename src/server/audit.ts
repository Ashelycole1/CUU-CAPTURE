import 'server-only';
import { createHash } from 'node:crypto';
import { asc, desc } from 'drizzle-orm';
import { auditLog } from './db/schema';
import type { DbOrTx } from './db/client';

/**
 * Append-only, hash-chained audit log (FR-AUD-1).
 *
 * hash = SHA-256(prev_hash || canonicalJSON({at, actorId, action, targetType, targetId, meta}))
 * - The first row's prev_hash is GENESIS_HASH.
 * - `meta` must contain IDs and codes only, never PII (retention can then delete
 *   personal data without breaking the chain).
 * - ALWAYS call `writeAudit` with the transaction that performs the change. Service
 *   transactions are libSQL "write" transactions (BEGIN IMMEDIATE), so reading the
 *   previous hash and inserting are serialized. A UNIQUE index on prev_hash makes any
 *   fork fail loudly (the caller's transaction rolls back and can be retried).
 * - UPDATE/DELETE are blocked by triggers (see drizzle/0001_audit_triggers.sql).
 */
export const GENESIS_HASH = '0'.repeat(64);

export type AuditMeta = Record<string, string | number | boolean | null | string[] | number[]>;

export interface AuditEntry {
  actorId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  meta?: AuditMeta;
}

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function computeAuditHash(
  prevHash: string,
  row: { at: string; actorId: string | null; action: string; targetType: string | null; targetId: string | null; meta: string },
): string {
  const canonical = canonicalJson({
    at: row.at,
    actorId: row.actorId,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    meta: JSON.parse(row.meta) as unknown,
  });
  return createHash('sha256').update(prevHash).update(canonical).digest('hex');
}

export async function writeAudit(tx: DbOrTx, entry: AuditEntry, at: string = new Date().toISOString()): Promise<void> {
  const last = await tx.select({ hash: auditLog.hash }).from(auditLog).orderBy(desc(auditLog.id)).limit(1);
  const prevHash = last[0]?.hash ?? GENESIS_HASH;
  const row = {
    at,
    actorId: entry.actorId,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    meta: canonicalJson(entry.meta ?? {}),
  };
  const hash = computeAuditHash(prevHash, row);
  await tx.insert(auditLog).values({ ...row, prevHash, hash });
}

export interface AuditVerification {
  ok: boolean;
  checked: number;
  /** id of the first row whose hash or link does not verify. */
  brokenAtId?: number;
  reason?: string;
}

/** Walk the chain in id order and recompute every hash. */
export async function verifyAuditChain(db: DbOrTx): Promise<AuditVerification> {
  const rows = await db.select().from(auditLog).orderBy(asc(auditLog.id));
  let prev = GENESIS_HASH;
  for (const r of rows) {
    if (r.prevHash !== prev) return { ok: false, checked: rows.length, brokenAtId: r.id, reason: 'prev_hash mismatch' };
    const expected = computeAuditHash(prev, r);
    if (expected !== r.hash) return { ok: false, checked: rows.length, brokenAtId: r.id, reason: 'hash mismatch' };
    prev = r.hash;
  }
  return { ok: true, checked: rows.length };
}
