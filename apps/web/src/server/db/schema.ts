/**
 * Checked-in core SQL for the StripSearch web alpha.
 *
 * Better Auth owns its own user/session/account tables and applies them through
 * `getMigrations`; this schema only covers research runs, sources, observations
 * and the ordered event log.
 */
export const CORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  parent_run_id TEXT,
  retry_of TEXT,
  followup INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  question TEXT NOT NULL,
  seed_url TEXT,
  provider TEXT NOT NULL,
  idempotency_key TEXT,
  body_fingerprint TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  identity_json TEXT NOT NULL,
  answer_json TEXT NOT NULL,
  limitations_json TEXT NOT NULL,
  usage_json TEXT NOT NULL,
  stop_reason TEXT,
  error_code TEXT,
  error_message TEXT,
  interrupted INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS runs_owner_created ON runs(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS runs_state ON runs(state);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  owner_id TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, key)
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  published_at TEXT,
  retrieved_at TEXT NOT NULL,
  fetch_status TEXT NOT NULL,
  excerpt TEXT,
  excerpt_locator TEXT,
  identity_label TEXT NOT NULL,
  identity_confirmed INTEGER NOT NULL DEFAULT 0,
  limits_json TEXT NOT NULL DEFAULT '[]',
  excluded INTEGER NOT NULL DEFAULT 0,
  excluded_at TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, source_key)
);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  statement TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_keys_json TEXT NOT NULL,
  limitations_json TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, seq)
);
CREATE INDEX IF NOT EXISTS run_events_run_seq ON run_events(run_id, seq);
`;
