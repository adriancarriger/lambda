import type { Migration } from '.';

/**
 * The periodic tick reads every project's recent `stage.*` events at once,
 * so it needs an index that leads with the type rather than the project.
 */
export const migration005: Migration = {
  version: 5,
  name: 'event type index',
  sql: `
    CREATE INDEX events_type_at ON events (type, at);
  `,
};
