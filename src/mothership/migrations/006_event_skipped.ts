import type { Migration } from '.';

/**
 * A building step skipped rather than run (`lambda pod step <id> skip
 * --reason …`) arrives as a `stage.end` with `skipped`; its reason goes in
 * the existing `reason` column.
 */
export const migration006: Migration = {
  version: 6,
  name: 'skipped stages',
  sql: `
    ALTER TABLE events ADD COLUMN skipped INTEGER;
  `,
};
