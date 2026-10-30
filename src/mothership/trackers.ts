import {
  type ComputerIdentities,
  type KnownAssignees,
  type SharedTrackerUser,
  type TrackerIdentity,
  buildKnownAssignees,
  parseIdentities,
  sharedTrackerUsers,
} from '../tickets/assignees';
import type { Db } from './db';
import { listRunners } from './registry';

/**
 * Each computer's tracker identities, as it reports them on every connect,
 * and the assignee map built from them for every computer.
 */

interface RawIdentity {
  runner_id: string;
  tracker: string;
  who: string;
  name: string | null;
}

/** A computer's report: what it says now replaces what it said before. */
export const setRunnerTrackers = (
  db: Db,
  runnerId: string,
  identities: TrackerIdentity[],
  at: number
): void =>
  db.transaction(() => {
    db.prepare('DELETE FROM runner_trackers WHERE runner_id = ?').run(runnerId);
    const insert = db.prepare(
      'INSERT INTO runner_trackers (runner_id, tracker, who, name, checked_at) VALUES (?, ?, ?, ?, ?)'
    );
    identities.forEach((identity) =>
      insert.run(runnerId, identity.tracker, identity.who, identity.name, at)
    );
  })();

/** Every computer with what it reported, by its current name. */
export const computerIdentities = (db: Db): ComputerIdentities[] => {
  const rows = db
    .prepare<[], RawIdentity>(
      'SELECT runner_id, tracker, who, name FROM runner_trackers ORDER BY tracker'
    )
    .all();

  return listRunners(db).map((runner) => ({
    runnerId: runner.id,
    name: runner.name,
    identities: parseIdentities(
      rows.filter((row) => row.runner_id === runner.id)
    ),
  }));
};

/** The map every computer is handed in the `owner` message. */
export const knownAssignees = (
  db: Db,
  owner: { name: string; email: string | null }
): KnownAssignees => buildKnownAssignees(computerIdentities(db), owner);

/** Tracker users two or more computers share: Settings' warning. */
export const sharedUsers = (db: Db): SharedTrackerUser[] =>
  sharedTrackerUsers(computerIdentities(db));
