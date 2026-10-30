import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

import { lambdaHome } from '../config/machineConfig';
import { MIGRATIONS, type Migration } from './migrations';

export type Db = Database.Database;

export const MOTHERSHIP_DB_FILE = 'mothership.db';

type Env = Record<string, string | undefined>;

/** `~/.lambda/mothership.db` (under `LAMBDA_HOME` when set). */
export const mothershipDbPath = (env: Env = process.env): string =>
  path.join(lambdaHome(env), MOTHERSHIP_DB_FILE);

/** Apply every migration not yet applied, in order, each in its own transaction. */
export const runMigrations = (
  db: Db,
  migrations: Migration[] = MIGRATIONS
): number[] => {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)'
  );
  const applied = new Set(
    db
      .prepare<[], { version: number }>('SELECT version FROM schema_migrations')
      .all()
      .map((row) => Number(row.version))
  );
  const pending = [...migrations]
    .sort((a, b) => a.version - b.version)
    .filter((migration) => !applied.has(migration.version));

  return pending
    .filter((migration) => applyMigration(db, migration))
    .map((migration) => migration.version);
};

/**
 * One migration in its own IMMEDIATE transaction, so two processes opening a
 * new file at once (the mothership, `lambda open`) take turns; the version is
 * checked again inside it, and one the other already applied is skipped.
 * Whether it was applied here.
 */
export const applyMigration = (db: Db, migration: Migration): boolean =>
  db
    .transaction(() => {
      const done =
        db
          .prepare('SELECT 1 FROM schema_migrations WHERE version = ?')
          .get(migration.version) !== undefined;

      if (done) {
        return false;
      }

      db.exec(migration.sql);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
      ).run(migration.version, migration.name, Date.now());

      return true;
    })
    .immediate();

/**
 * Open (creating if needed) the mothership's database: mode 0600 in a 0700
 * folder, foreign keys on, migrations run. Reading this file is what proves
 * you're on the host (`lambda open`, `lambda account alias`).
 */
export const openDb = (file: string): Db => {
  const dir = path.dirname(file);

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Also when the folder was already there (`lambda init` may have made it):
  // the rollback journal, made under the default umask, lives in it.
  fs.chmodSync(dir, 0o700);

  const db = new Database(file);
  fs.chmodSync(file, 0o600);
  // The default rollback journal, not WAL: no long-lived side files that
  // would need their own 0600, and the CLI's writes (lambda open, alias)
  // wait on the busy timeout.
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  runMigrations(db);

  return db;
};
