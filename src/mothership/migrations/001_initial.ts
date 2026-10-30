import type { Migration } from '.';

/**
 * The mothership's first schema. Times are milliseconds since the epoch.
 * There is no accounts table: the owner is `owner` in the mothership
 * machine's ~/.lambda/config.json.
 */
export const migration001: Migration = {
  version: 1,
  name: 'initial',
  sql: `
    CREATE TABLE aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('email', 'name')),
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX aliases_kind_value ON aliases (kind, value);

    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      last_seen_at INTEGER NOT NULL
    );

    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );

    CREATE TABLE pairing_codes (
      code_hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('device', 'runner')),
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );

    CREATE TABLE login_links (
      token_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );

    CREATE TABLE pair_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      remote_address TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX pair_attempts_address ON pair_attempts (remote_address, at);

    CREATE TABLE runners (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      public_key TEXT NOT NULL,
      current_project_id TEXT,
      state TEXT NOT NULL DEFAULT 'idle',
      last_seen_at INTEGER NOT NULL
    );

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      ticket_prefix TEXT,
      last_used_at INTEGER NOT NULL
    );

    CREATE TABLE runner_projects (
      runner_id TEXT NOT NULL REFERENCES runners (id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
      folder TEXT NOT NULL,
      PRIMARY KEY (runner_id, project_id)
    );

    CREATE TABLE pods (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects (id) ON DELETE CASCADE,
      runner_id TEXT,
      state_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Stored once per (id, generation). The id is the spec's
    -- <runner>:<path hash>:<offset>; a file rewritten under the runner is read
    -- again from offset 0, so its new lines reuse old ids, and the generation
    -- (0 until the first rewrite) is what tells them apart.
    CREATE TABLE events (
      id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0,
      project_id TEXT,
      pod_id TEXT,
      ticket TEXT,
      attempt INTEGER,
      type TEXT NOT NULL,
      name TEXT,
      result TEXT,
      note TEXT,
      value REAL,
      unit TEXT,
      source TEXT,
      at INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      warning TEXT,
      PRIMARY KEY (id, generation)
    );
    CREATE INDEX events_project ON events (project_id, at);

    -- The mothership's own secrets (the prototype-link key).
    CREATE TABLE secrets (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Outbox ids already stored that aren't events, so a resend is ignored.
    CREATE TABLE received (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL
    );
  `,
};
