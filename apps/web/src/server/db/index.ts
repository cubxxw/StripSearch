import Database from 'better-sqlite3';
import { CORE_SCHEMA_SQL } from './schema.js';

export type DB = Database.Database;

export function openDatabase(dbPath: string): DB {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function applyCoreSchema(db: DB): void {
  db.exec(CORE_SCHEMA_SQL);
  // Older alpha databases had an owner+body unique index that turned repeated
  // submissions into implicit dedupe. Idempotency is now key-based only.
  db.exec('DROP INDEX IF EXISTS runs_owner_fingerprint');
}
