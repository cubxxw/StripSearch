import { getMigrations } from 'better-auth/db/migration';
import type { Auth } from '../auth.js';
import { applyCoreSchema, type DB } from './index.js';

/**
 * Apply the checked-in core SQL and the Better Auth Kysely migrations.
 * Both are idempotent, so this is safe on every boot.
 */
export async function migrateDatabase(db: DB, auth: Auth): Promise<void> {
  applyCoreSchema(db);
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}
