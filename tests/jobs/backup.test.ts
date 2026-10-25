/** NFR-REL: backup script round-trip on a temp DB (dump → restore → identical data, chain verifies). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import { createStaff, createTestDb, type TestDb } from '../helpers/db';
import { createSubmittedApplication } from '../helpers/factories';
import { openDb } from '@/server/db/client';
import { verifyAuditChain } from '@/server/audit';
import { dumpDatabase, restoreDatabase, sqlLiteral } from '../../scripts/lib/dump';
import { closedApplication } from './helpers';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
  const staff = await createStaff(t.db);
  await createSubmittedApplication(t.db, { nationality: 'KE', studentType: 'continuing' });
  await closedApplication(t.db, staff, { closedDaysAgo: 5 });
});
afterAll(() => t.cleanup());

describe('backup round-trip', () => {
  it('escapes literals', () => {
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'");
    expect(sqlLiteral(null)).toBe('NULL');
    expect(sqlLiteral(12n)).toBe('12');
    expect(sqlLiteral(new Uint8Array([1, 255]))).toBe("X'01ff'");
  });

  it('restores every table, row and trigger into an empty DB; audit chain still verifies', async () => {
    const src = createClient({ url: pathToFileURL(path.join(t.dir, 'test.db')).href, intMode: 'bigint' });
    const { sql, stats } = await dumpDatabase(src, { pageSize: 7 });
    expect(stats.tables.audit_log).toBeGreaterThan(10);
    expect(stats.tables.__drizzle_migrations).toBeGreaterThanOrEqual(3);

    const file = path.join(t.dir, 'restored.db');
    const target = createClient({ url: pathToFileURL(file).href, intMode: 'bigint' });
    const restored = await restoreDatabase(target, sql);
    expect(restored.tables).toEqual(stats.tables);

    // Byte-for-byte equal audit rows.
    const a = await src.execute('SELECT * FROM audit_log ORDER BY id');
    const b = await target.execute('SELECT * FROM audit_log ORDER BY id');
    expect(b.rows.map((r) => a.columns.map((_, i) => r[i]))).toEqual(a.rows.map((r) => a.columns.map((_, i) => r[i])));

    // Triggers came back: audit_log stays append-only.
    await expect(target.execute('DELETE FROM audit_log')).rejects.toThrow();
    // Refuses a non-empty target.
    await expect(restoreDatabase(target, sql)).rejects.toThrow(/not empty/);
    src.close();
    target.close();

    const h = await openDb(pathToFileURL(file).href);
    expect((await verifyAuditChain(h.db)).ok).toBe(true);
    h.client.close();
    expect(fs.existsSync(file)).toBe(true);
  });
});
