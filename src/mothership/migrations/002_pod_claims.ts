import type { Migration } from '.';

/**
 * `claimed_at`: when a runner claimed a waiting pod it's about to start
 * (NULL once started, or for a pod's own row). A claim outlives the switch
 * that made it only when the mothership stopped mid-switch, and the column
 * is how that claim is found and released. `pods_runner`: the reads of one
 * runner's pods.
 */
export const migration002: Migration = {
  version: 2,
  name: 'pod claims',
  sql: `
    ALTER TABLE pods ADD COLUMN claimed_at INTEGER;
    CREATE INDEX pods_runner ON pods (runner_id);
  `,
};
