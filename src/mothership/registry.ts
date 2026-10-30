import { randomId } from './crypto';
import type { Db } from './db';

/**
 * The mothership's runners and projects. A runner is one computer; a project
 * is one codebase, held by one or more runners, each with its own folder
 * (`runner_projects`).
 */

export interface RunnerRow {
  id: string;
  name: string;
  publicKey: string;
  currentProjectId: string | null;
  state: string;
  lastSeenAt: number;
}

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  ticketPrefix: string | null;
  lastUsedAt: number;
}

export interface Holding {
  runnerId: string;
  projectId: string;
  folder: string;
}

interface RawRunner {
  id: string;
  name: string;
  public_key: string;
  current_project_id: string | null;
  state: string;
  last_seen_at: number;
}

interface RawProject {
  id: string;
  name: string;
  description: string | null;
  ticket_prefix: string | null;
  last_used_at: number;
}

const toRunner = (row: RawRunner): RunnerRow => ({
  id: row.id,
  name: row.name,
  publicKey: row.public_key,
  currentProjectId: row.current_project_id,
  state: row.state,
  lastSeenAt: row.last_seen_at,
});

const toProject = (row: RawProject): ProjectRow => ({
  id: row.id,
  name: row.name,
  description: row.description,
  ticketPrefix: row.ticket_prefix,
  lastUsedAt: row.last_used_at,
});

export const newRunnerId = (): string => randomId('rnr');

export const addRunner = (
  db: Db,
  runner: { id: string; name: string; publicKey: string },
  now: number
): void => {
  db.prepare(
    "INSERT INTO runners (id, name, public_key, current_project_id, state, last_seen_at) VALUES (?, ?, ?, NULL, 'idle', ?)"
  ).run(runner.id, runner.name, runner.publicKey, now);
};

export const getRunner = (db: Db, id: string): RunnerRow | null => {
  const row = db
    .prepare<[string], RawRunner>('SELECT * FROM runners WHERE id = ?')
    .get(id);

  return row === undefined ? null : toRunner(row);
};

export const listRunners = (db: Db): RunnerRow[] =>
  db
    .prepare<[], RawRunner>('SELECT * FROM runners ORDER BY name')
    .all()
    .map(toRunner);

/**
 * A runner leaves: its pods go with it (nothing could reach them again), a
 * waiting pod it had claimed but not started waits for another computer, and
 * so does a ticket it claimed but never shipped. A shipped claim is kept, so
 * no other computer builds that ticket again.
 */
export const removeRunner = (db: Db, id: string): boolean =>
  db.transaction(() => {
    db.prepare(
      'UPDATE pods SET runner_id = NULL, claimed_at = NULL WHERE runner_id = ? AND claimed_at IS NOT NULL'
    ).run(id);
    db.prepare('DELETE FROM pods WHERE runner_id = ?').run(id);
    db.prepare(
      'DELETE FROM ticket_claims WHERE runner_id = ? AND shipped_at IS NULL'
    ).run(id);

    return db.prepare('DELETE FROM runners WHERE id = ?').run(id).changes > 0;
  })();

export const touchRunner = (db: Db, id: string, now: number): void => {
  db.prepare('UPDATE runners SET last_seen_at = ? WHERE id = ?').run(now, id);
};

export const setRunnerProject = (
  db: Db,
  id: string,
  projectId: string | null,
  state: string
): void => {
  db.prepare(
    'UPDATE runners SET current_project_id = ?, state = ? WHERE id = ?'
  ).run(projectId, state, id);
};

/** A runner's name, for messages ("Leslie's Mac mini is offline."). */
export const runnerName = (db: Db, id: string): string =>
  getRunner(db, id)?.name ?? 'That computer';

export const listProjects = (db: Db): ProjectRow[] =>
  db
    .prepare<[], RawProject>('SELECT * FROM projects ORDER BY name')
    .all()
    .map(toProject);

export const getProject = (db: Db, id: string): ProjectRow | null => {
  const row = db
    .prepare<[string], RawProject>('SELECT * FROM projects WHERE id = ?')
    .get(id);

  return row === undefined ? null : toProject(row);
};

export const projectByName = (db: Db, name: string): ProjectRow | null => {
  const row = db
    .prepare<[string], RawProject>('SELECT * FROM projects WHERE name = ?')
    .get(name);

  return row === undefined ? null : toProject(row);
};

/** The project used last: the highest `last_used_at`. */
export const lastUsedProject = (db: Db): ProjectRow | null => {
  const row = db
    .prepare<[], RawProject>(
      'SELECT * FROM projects ORDER BY last_used_at DESC, name LIMIT 1'
    )
    .get();

  return row === undefined ? null : toProject(row);
};

/** A pod was created in it: it's now the last project used. */
export const useProject = (db: Db, id: string, now: number): void => {
  db.prepare('UPDATE projects SET last_used_at = ? WHERE id = ?').run(now, id);
};

export const holdings = (db: Db): Holding[] =>
  db
    .prepare<[], { runner_id: string; project_id: string; folder: string }>(
      'SELECT runner_id, project_id, folder FROM runner_projects'
    )
    .all()
    .map((row) => ({
      runnerId: row.runner_id,
      projectId: row.project_id,
      folder: row.folder,
    }));

export const holdingsOf = (db: Db, projectId: string): Holding[] =>
  holdings(db).filter((holding) => holding.projectId === projectId);

/** The project a runner's folder is, or `null` when it isn't linked. */
export const projectOfFolder = (
  db: Db,
  runnerId: string,
  folder: string
): string | null => {
  const row = db
    .prepare<[string, string], { project_id: string }>(
      'SELECT project_id FROM runner_projects WHERE runner_id = ? AND folder = ?'
    )
    .get(runnerId, folder);

  return row?.project_id ?? null;
};

export const folderOf = (
  db: Db,
  runnerId: string,
  projectId: string
): string | null => {
  const row = db
    .prepare<[string, string], { folder: string }>(
      'SELECT folder FROM runner_projects WHERE runner_id = ? AND project_id = ?'
    )
    .get(runnerId, projectId);

  return row?.folder ?? null;
};

/** Is this folder already some project of this runner's? */
export const folderLinked = (db: Db, runnerId: string, folder: string) =>
  projectOfFolder(db, runnerId, folder) !== null;

/**
 * Link a runner's folder to the project of that name: the project is made
 * only when no project has that name; a runner already holding the project
 * keeps its one row, pointed at the folder it's in now. Answers the
 * project's id.
 */
export const linkProject = (
  db: Db,
  link: {
    runnerId: string;
    name: string;
    folder: string;
    description?: string | null;
    ticketPrefix?: string | null;
  },
  now: number
): string =>
  db.transaction(() => {
    const existing = projectByName(db, link.name);
    const projectId = existing?.id ?? randomId('prj');

    if (existing === null) {
      // Never used yet: only a pod created in it counts as using it.
      db.prepare(
        'INSERT INTO projects (id, name, description, ticket_prefix, last_used_at) VALUES (?, ?, ?, ?, 0)'
      ).run(
        projectId,
        link.name,
        link.description ?? null,
        link.ticketPrefix ?? null
      );
    } else if (
      link.ticketPrefix !== undefined ||
      link.description !== undefined
    ) {
      // A newer lambda.json wins for what the app shows.
      db.prepare(
        'UPDATE projects SET description = COALESCE(?, description), ticket_prefix = ? WHERE id = ?'
      ).run(link.description ?? null, link.ticketPrefix ?? null, projectId);
    }

    // A moved or re-cloned folder replaces the old one: still one row.
    db.prepare(
      'INSERT INTO runner_projects (runner_id, project_id, folder) VALUES (?, ?, ?) ON CONFLICT (runner_id, project_id) DO UPDATE SET folder = excluded.folder'
    ).run(link.runnerId, projectId, link.folder);

    return projectId;
  })();
