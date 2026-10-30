import type { Migration } from '.';

/**
 * `events` is append-only and kept forever: the Tickets screen reads one
 * ticket's events, and its list every project's `group.*` ones, so each is
 * an index lookup rather than a scan of the project's whole history.
 */
export const migration004: Migration = {
  version: 4,
  name: 'event indexes',
  sql: `
    CREATE INDEX events_ticket ON events (project_id, ticket, at);
    CREATE INDEX events_type ON events (project_id, type, at);
  `,
};
