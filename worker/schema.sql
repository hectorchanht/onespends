-- OneSpends D1 schema — database "onespends-db".
-- Auth tables are the @dawn-studio/auth schema (~/workspace/dawn-auth/schema.sql)
-- verbatim, except users gains two nullable columns (created_at, trial_ends_at)
-- which the lib's INSERT/SELECT (id, email) simply never touches.
-- The worker sets trial_ends_at = first-verify time + 90 days (standing rule:
-- new apps get a 90-day full trial).

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER,
  trial_ends_at INTEGER
);

CREATE TABLE IF NOT EXISTS magic_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  scheme TEXT,
  code_hash TEXT,
  code_attempts INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_magic_tokens_email ON magic_tokens(email);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

-- Sync: APPEND-ONLY version log. Every accepted write inserts a new row with a
-- fresh AUTOINCREMENT seq; the current state of a record is its highest-seq row.
-- Deletes are versions with deleted = 1 (tombstones travel through the same log,
-- so GET /api/sync?since=<seq> returns changes + tombstones in order).
-- A write is accepted only when its updated_at beats the latest version's
-- (last-write-wins); stale writes are acknowledged but not appended.
CREATE TABLE IF NOT EXISTS spends (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_spends_user_seq ON spends(user_id, seq);
CREATE INDEX IF NOT EXISTS idx_spends_user_record ON spends(user_id, record_id, seq DESC);
