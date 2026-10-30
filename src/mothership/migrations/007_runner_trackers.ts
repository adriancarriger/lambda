import type { Migration } from '.';

/**
 * Who each computer is in each tracker (its key's own user), as it reports
 * on every connect: the assignee map is built from these, by computer id,
 * so a renamed computer keeps its tickets.
 */
export const migration007: Migration = {
  version: 7,
  name: 'runner trackers',
  sql: `
    CREATE TABLE runner_trackers (
      runner_id TEXT NOT NULL REFERENCES runners (id) ON DELETE CASCADE,
      tracker TEXT NOT NULL,
      who TEXT NOT NULL,
      name TEXT,
      checked_at INTEGER NOT NULL,
      PRIMARY KEY (runner_id, tracker)
    );
  `,
};
