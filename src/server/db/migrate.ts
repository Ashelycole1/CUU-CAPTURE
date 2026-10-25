import { migrate } from 'drizzle-orm/libsql/migrator';
import path from 'node:path';
import type { Db } from './client';

/** Absolute path to committed SQL migrations. */
export const MIGRATIONS_DIR = path.resolve(process.cwd(), 'drizzle');

/** Apply all pending migrations (forward-only). Used by scripts and tests. */
export async function runMigrations(db: Db, migrationsFolder: string = MIGRATIONS_DIR): Promise<void> {
  await migrate(db, { migrationsFolder });
}
