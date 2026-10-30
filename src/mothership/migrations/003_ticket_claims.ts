import type { Migration } from '.';

/**
 * `ticket_claims`: which runner is building a ticket. One row per (project,
 * ticket), so two runners on a project never take the same one: the losing
 * insert is the refusal. A row is kept once `shipped_at` is set, so a ticket
 * shipped on one computer is never built again on another whose markdown
 * copy still says Ready. For the same reason `runner_id` has no foreign
 * key: removing a runner frees its unshipped claims and keeps its shipped
 * ones.
 *
 * `events` gains a project's `group.*` fields: the group, why it's held,
 * and whether it is.
 */
export const migration003: Migration = {
  version: 3,
  name: 'ticket claims',
  sql: `
    CREATE TABLE ticket_claims (
      project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
      ticket_id TEXT NOT NULL,
      runner_id TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      shipped_at INTEGER,
      PRIMARY KEY (project_id, ticket_id)
    );

    ALTER TABLE events ADD COLUMN group_id TEXT;
    ALTER TABLE events ADD COLUMN reason TEXT;
    ALTER TABLE events ADD COLUMN held INTEGER;
  `,
};
