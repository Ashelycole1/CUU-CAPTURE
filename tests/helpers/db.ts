/**
 * Test helpers. Usage in an integration test file:
 *
 *   let t: TestDb;
 *   beforeAll(async () => { t = await createTestDb(); });
 *   afterAll(() => t.cleanup());
 *
 * Each call creates a fresh temp SQLite file (same libSQL client as production),
 * applies migrations, seeds base data, and routes getDb()/getBlobStore()/getChannel()
 * to it. Vitest runs each file in its own process, so files never share a DB.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import { openDb, setDbOverride, type Db, type DbHandle } from '@/server/db/client';
import { runMigrations } from '@/server/db/migrate';
import { seedBase } from '@/server/db/seed';
import { profiles, students, outbox, notifications } from '@/server/db/schema';
import { EncryptedBlobStore, setBlobStore } from '@/server/storage';
import { LocalDiskStore } from '@/server/storage/local';
import { DevOutboxChannel, setChannel } from '@/server/notify';
import type { Actor } from '@/server/authz';
import type { Role, StudentType } from '@/domain/types';

export interface TestDb {
  db: Db;
  handle: DbHandle;
  dir: string;
  cleanup: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visadesk-test-'));
  const url = pathToFileURL(path.join(dir, 'test.db')).href;
  const handle = await openDb(url);
  await runMigrations(handle.db);
  await seedBase(handle.db);
  setDbOverride(handle);
  setBlobStore(
    new EncryptedBlobStore(new LocalDiskStore(path.join(dir, 'blobs')), {
      currentKeyId: 'test',
      keys: { test: Buffer.alloc(32, 7) },
    }),
  );
  setChannel(new DevOutboxChannel(() => handle.db, false));
  return {
    db: handle.db,
    handle,
    dir,
    cleanup: async () => {
      setDbOverride(null);
      setBlobStore(null);
      setChannel(null);
      handle.client.close();
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows may hold the file briefly; temp dir is fine to leave. */
      }
    },
  };
}

let counter = 0;
const uniq = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export function actorOf(p: typeof profiles.$inferSelect): Actor {
  return { id: p.id, role: p.role, email: p.email, fullName: p.fullName };
}

/** Insert a profile with a role and return its Actor. */
export async function createUser(db: Db, opts: { role?: Role; email?: string; fullName?: string } = {}): Promise<Actor> {
  const id = crypto.randomUUID();
  await db.insert(profiles).values({
    id,
    email: opts.email ?? `${opts.role ?? 'student'}-${uniq()}@cavendish.ac.ug`,
    fullName: opts.fullName ?? `Test ${opts.role ?? 'student'}`,
    role: opts.role ?? 'student',
  });
  const p = (await db.select().from(profiles).where(eq(profiles.id, id)))[0]!;
  return actorOf(p);
}

export const createStaff = (db: Db, opts: { email?: string } = {}) => createUser(db, { ...opts, role: 'dos_staff' });
export const createAdmin = (db: Db, opts: { email?: string } = {}) => createUser(db, { ...opts, role: 'dos_admin' });

/** A student with a complete profile (students row filled). */
export async function createStudent(
  db: Db,
  opts: { nationality?: string; studentType?: StudentType; email?: string; fullName?: string; studentNo?: string } = {},
): Promise<Actor> {
  const actor = await createUser(db, { role: 'student', email: opts.email, fullName: opts.fullName ?? 'Test Student' });
  await db.insert(students).values({
    profileId: actor.id,
    studentNo: opts.studentNo ?? `CUU-${uniq()}`.toUpperCase(),
    nationality: opts.nationality ?? 'NG',
    studentType: opts.studentType ?? 'new',
    programme: 'BSc Testing',
  });
  return actor;
}

export function fakeSha(seed: string | number): string {
  return Buffer.from(String(seed)).toString('hex').padEnd(64, '0').slice(0, 64);
}

export async function outboxFor(db: Db, to: string) {
  return (await db.select().from(outbox)).filter((o) => o.to === to);
}

export async function allNotifications(db: Db) {
  return db.select().from(notifications);
}
