import { migration001 } from './001_initial';
import { migration002 } from './002_pod_claims';
import { migration003 } from './003_ticket_claims';
import { migration004 } from './004_event_indexes';
import { migration005 } from './005_event_type_index';
import { migration006 } from './006_event_skipped';
import { migration007 } from './007_runner_trackers';
import { migration008 } from './008_views_favorites';

export interface Migration {
  /** Applied in order, each exactly once. */
  version: number;
  name: string;
  sql: string;
}

/** Every migration, oldest first. A new one is appended, never edited. */
export const MIGRATIONS: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
];
