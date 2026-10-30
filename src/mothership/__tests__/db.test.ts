import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

import { required } from '../../__tests__/required';
import { applyMigration, openDb, runMigrations } from '../db';
import { MIGRATIONS } from '../migrations';
import { tempHome } from './harness';

const schemaOf = (db: Database.Database): string[] =>
  db
    .prepare<[], { type: string; name: string; sql: string | null }>(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((row) => `${row.type} ${row.name} ${row.sql ?? ''}`);

describe('migrations', () => {
  it('give the same schema on an empty file and on a migrated one, each applied once', () => {
    const home = tempHome();
    const file = path.join(home, 'mothership.db');

    const first = openDb(file);
    const schema = schemaOf(first);
    first.close();

    const again = new Database(file);
    const applied = runMigrations(again);

    expect(applied).toEqual([]);
    expect(schemaOf(again)).toEqual(schema);
    expect(
      again
        .prepare<
          [],
          {
            version: number;
          }
        >('SELECT version FROM schema_migrations ORDER BY version')
        .all()
        .map((row) => row.version)
    ).toEqual(MIGRATIONS.map((migration) => migration.version));
    again.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('adds ticket claims, one per project and ticket, and keeps older events', () => {
    const home = tempHome();
    const db = new Database(path.join(home, 'mothership.db'));
    runMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version <= 2)
    );
    db.prepare(
      "INSERT INTO events (id, type, at, received_at) VALUES ('e1', 'metric', 1, 1)"
    ).run();

    expect(
      runMigrations(
        db,
        MIGRATIONS.filter((migration) => migration.version <= 3)
      )
    ).toEqual([3]);
    expect(
      db.prepare('SELECT id, group_id, reason, held FROM events').all()
    ).toEqual([{ id: 'e1', group_id: null, reason: null, held: null }]);

    db.prepare(
      "INSERT INTO projects (id, name, last_used_at) VALUES ('p1', 'Pawnee Parks site', 0)"
    ).run();
    db.prepare(
      "INSERT INTO runners (id, name, public_key, last_seen_at) VALUES ('r1', 'Mac', 'k', 0)"
    ).run();
    const claim = db.prepare(
      "INSERT INTO ticket_claims (project_id, ticket_id, runner_id, claimed_at) VALUES ('p1', '3', 'r1', 1)"
    );
    claim.run();

    expect(() => claim.run()).toThrow(/UNIQUE/);
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('keeps the pods stored before claims, and indexes each runner’s pods', () => {
    const home = tempHome();
    const db = new Database(path.join(home, 'mothership.db'));
    runMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version === 1)
    );
    db.prepare(
      "INSERT INTO pods (id, runner_id, state_json, updated_at) VALUES ('dog-park', 'rnr_mini', '{}', 1)"
    ).run();

    expect(
      runMigrations(
        db,
        MIGRATIONS.filter((migration) => migration.version <= 2)
      )
    ).toEqual([2]);
    expect(
      db.prepare('SELECT id, runner_id, claimed_at FROM pods').all()
    ).toEqual([{ id: 'dog-park', runner_id: 'rnr_mini', claimed_at: null }]);
    expect(
      db
        .prepare<[], { detail: string }>(
          "EXPLAIN QUERY PLAN SELECT * FROM pods WHERE runner_id = 'rnr_mini'"
        )
        .all()
        .map((row) => row.detail)
    ).toEqual([expect.stringContaining('USING INDEX pods_runner')]);
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("indexes a project's events by ticket, keeping the events stored before", () => {
    const home = tempHome();
    const db = new Database(path.join(home, 'mothership.db'));
    runMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version <= 3)
    );
    db.prepare(
      "INSERT INTO events (id, project_id, ticket, type, at, received_at) VALUES ('e1', 'p1', '3', 'stage.start', 1, 1)"
    ).run();

    expect(
      runMigrations(
        db,
        MIGRATIONS.filter((migration) => migration.version <= 4)
      )
    ).toEqual([4]);
    expect(db.prepare('SELECT id FROM events').all()).toEqual([{ id: 'e1' }]);
    expect(
      db
        .prepare<[], { detail: string }>(
          "EXPLAIN QUERY PLAN SELECT * FROM events WHERE project_id = 'p1' AND ticket = '3'"
        )
        .all()
        .map((row) => row.detail)
    ).toEqual([expect.stringContaining('USING INDEX events_ticket')]);
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('creates the file 0600', () => {
    const home = tempHome();
    const file = path.join(home, 'nested', 'mothership.db');
    openDb(file).close();

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('closes a folder that was already there to others (its journal lives in it)', () => {
    const home = tempHome();
    const dir = path.join(home, '.lambda');
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    openDb(path.join(dir, 'mothership.db')).close();

    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('has every table the mothership keeps', () => {
    const home = tempHome();
    const db = openDb(path.join(home, 'mothership.db'));
    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
      )
      .all()
      .map((row) => row.name);

    expect(tables).toEqual(
      expect.arrayContaining([
        'sessions',
        'devices',
        'login_links',
        'pairing_codes',
        'pair_attempts',
        'aliases',
        'runners',
        'projects',
        'runner_projects',
        'pods',
        'events',
      ])
    );
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('skip a migration another process applied after this one looked', () => {
    const home = tempHome();
    const file = path.join(home, 'mothership.db');
    // Two openers of a new file: this one saw version 1 as pending, then
    // the other applied it first.
    const other = openDb(file);
    const late = new Database(file);
    const first = required(MIGRATIONS[0], 'migration 1');

    expect(() => applyMigration(late, first)).not.toThrow();
    expect(applyMigration(late, first)).toBe(false);
    expect(
      late
        .prepare<[], { n: number }>(
          'SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 1'
        )
        .get()?.n
    ).toBe(1);
    late.close();
    other.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
});
