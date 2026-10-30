import type { Db } from '../mothership/db';
import { UNFINISHED_TYPE, overdueStages, unfinishedLabel } from './analytics';
import {
  EventLineSchema,
  type ForwardedEvent,
  type StoredEvent,
  isKnownType,
} from './schema';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const asEvent = (value: unknown): ForwardedEvent | { warning: string } => {
  const parsed = EventLineSchema.safeParse(value);

  if (!parsed.success) {
    return { warning: "An event that couldn't be read." };
  }

  // A line that parsed is an object.
  const extra = isRecord(value) ? value : {};

  return {
    ...parsed.data,
    at: parsed.data.at ?? new Date().toISOString(),
    pod: typeof extra.pod === 'string' ? extra.pod : undefined,
    source: typeof extra.source === 'string' ? extra.source : undefined,
    warning: typeof extra.warning === 'string' ? extra.warning : undefined,
    raw: typeof extra.raw === 'string' ? extra.raw.slice(0, 500) : undefined,
  };
};

/**
 * Store one forwarded event under its id. An id already stored is ignored
 * (a runner resending after a crash). Nothing is dropped: an unknown type or
 * a bad line is stored with a warning.
 */
export const storeEvent = (
  db: Db,
  input: {
    id: string;
    /** 0 unless the file was rewritten; see `eventMessage`. */
    generation?: number;
    projectId: string | null;
    event: unknown;
    receivedAt: number;
  }
): 'stored' | 'duplicate' => {
  const event = asEvent(input.event);
  const full: ForwardedEvent =
    'type' in event
      ? event
      : {
          type: 'invalid',
          at: new Date(input.receivedAt).toISOString(),
          ...event,
        };
  const warning =
    full.warning ??
    (isKnownType(full.type)
      ? undefined
      : `Unknown event type "${full.type}".`) ??
    (full.type.startsWith('group.') && (full.groupId ?? '') === ''
      ? `${full.type} has no groupId, so no group can show it.`
      : undefined);
  const at = Date.parse(full.at);

  const { changes } = db
    .prepare(
      `INSERT OR IGNORE INTO events (id, generation, project_id, pod_id, ticket, attempt, group_id, reason, held, skipped, type, name, result, note, value, unit, source, at, received_at, warning)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.generation ?? 0,
      input.projectId,
      full.pod ?? null,
      full.ticket ?? null,
      full.attempt ?? null,
      full.groupId ?? null,
      full.reason ?? null,
      full.held === undefined ? null : full.held ? 1 : 0,
      full.skipped === undefined ? null : full.skipped ? 1 : 0,
      full.type,
      full.name ?? null,
      full.result ?? null,
      full.note ?? (full.raw === undefined ? null : full.raw),
      full.value ?? null,
      full.unit ?? null,
      full.source ?? null,
      Number.isFinite(at) ? at : input.receivedAt,
      input.receivedAt,
      warning ?? null
    );

  return changes === 1 ? 'stored' : 'duplicate';
};

interface RawEvent {
  id: string;
  generation: number;
  project_id: string | null;
  pod_id: string | null;
  ticket: string | null;
  attempt: number | null;
  group_id: string | null;
  reason: string | null;
  held: number | null;
  skipped: number | null;
  type: string;
  name: string | null;
  result: string | null;
  note: string | null;
  value: number | null;
  unit: string | null;
  source: string | null;
  at: number;
  received_at: number;
  warning: string | null;
}

const toStored = (row: RawEvent): StoredEvent => ({
  id: row.id,
  generation: row.generation,
  projectId: row.project_id,
  pod: row.pod_id,
  ticket: row.ticket,
  attempt: row.attempt,
  groupId: row.group_id,
  reason: row.reason,
  held: row.held === null ? null : row.held === 1,
  skipped: row.skipped === null ? null : row.skipped === 1,
  type: row.type,
  name: row.name,
  result: row.result,
  note: row.note,
  value: row.value,
  unit: row.unit,
  source: row.source,
  at: row.at,
  receivedAt: row.received_at,
  warning: row.warning,
});

/**
 * How far back the tick pairs stages. A start is flagged on the first tick
 * a day after it; one older than this was flagged then (or the mothership
 * was down for the whole month), so it's left alone.
 */
export const FLAG_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Store a warning row for every stage with no end 24 hours after it
 * started, once each (its id and generation come from the stage.start's). Run by the
 * mothership's periodic tick; answers how many it stored.
 */
export const flagUnfinishedStages = (db: Db, now: number): number => {
  // Only recent stage rows can pair up or be newly overdue: the rest of the
  // table (every metric, ship and warning, and every stage settled long ago)
  // stays on disk, so the tick doesn't grow with the history.
  const recent = db
    .prepare<[number], RawEvent>(
      "SELECT * FROM events WHERE type IN ('stage.start', 'stage.end') AND at >= ? ORDER BY at, received_at"
    )
    .all(now - FLAG_WINDOW_MS)
    .map(toStored);
  // One pass, appended in place (the history can be long).
  const byProject = new Map<string | null, StoredEvent[]>();
  recent.forEach((event) => {
    const group = byProject.get(event.projectId);

    if (group === undefined) {
      byProject.set(event.projectId, [event]);

      return;
    }

    group.splice(group.length, 0, event);
  });
  const overdue = [...byProject.values()].flatMap((events) =>
    overdueStages(events, now)
  );
  const insert = db.prepare(
    `INSERT OR IGNORE INTO events (id, generation, project_id, pod_id, ticket, attempt, type, name, result, note, value, unit, source, at, received_at, warning)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`
  );

  return overdue.reduce(
    (stored, start) =>
      stored +
      insert.run(
        `${UNFINISHED_TYPE}:${start.id}`,
        // The start's generation: two starts sharing an id get a marker each.
        start.generation,
        start.projectId,
        start.pod,
        start.ticket,
        start.attempt,
        UNFINISHED_TYPE,
        start.name,
        start.source,
        start.at,
        now,
        `${unfinishedLabel(
          start.name ?? '(unnamed)',
          start.at
        )} never finished.`
      ).changes,
    0
  );
};

/**
 * Narrows a read in SQL, not after loading the whole history: events are
 * append-only and kept forever, so a page that needs one ticket or one kind
 * mustn't pay for every metric ever reported.
 */
export interface EventFilter {
  /** Only these types. */
  types?: readonly string[];
  /** Only types starting with this, e.g. `group.`. */
  typePrefix?: string;
  ticket?: string;
  /** Only events at or after this time (ms). */
  since?: number;
  /** Leave out the events of groups that shipped before this time (ms). */
  groupsShippedSince?: number;
}

/** The first string after every one starting with `prefix`: `group.` → `group/`. */
const prefixEnd = (prefix: string): string => {
  if (prefix === '') {
    throw new Error('A type prefix needs at least one character.');
  }

  return `${prefix.slice(0, -1)}${String.fromCharCode(
    prefix.charCodeAt(prefix.length - 1) + 1
  )}`;
};

export const listEvents = (
  db: Db,
  projectId: string,
  filter: EventFilter = {}
): StoredEvent[] => {
  const types = filter.types ?? [];
  const clauses = [
    'project_id = ?',
    ...(filter.types === undefined
      ? []
      : [`type IN (${types.map(() => '?').join(', ') || 'NULL'})`]),
    // A range, not LIKE: SQLite's LIKE ignores case, so it can't use the
    // (binary) events_type index.
    ...(filter.typePrefix === undefined ? [] : ['type >= ? AND type < ?']),
    ...(filter.ticket === undefined ? [] : ['ticket = ?']),
    ...(filter.since === undefined ? [] : ['at >= ?']),
    ...(filter.groupsShippedSince === undefined
      ? []
      : [
          "(group_id IS NULL OR group_id NOT IN (SELECT group_id FROM events WHERE project_id = ? AND type = 'group.shipped' AND at < ? AND group_id IS NOT NULL))",
        ]),
  ];
  const params = [
    projectId,
    ...types,
    ...(filter.typePrefix === undefined
      ? []
      : [filter.typePrefix, prefixEnd(filter.typePrefix)]),
    ...(filter.ticket === undefined ? [] : [filter.ticket]),
    ...(filter.since === undefined ? [] : [filter.since]),
    ...(filter.groupsShippedSince === undefined
      ? []
      : [projectId, filter.groupsShippedSince]),
  ];

  return db
    .prepare<(string | number)[], RawEvent>(
      `SELECT * FROM events WHERE ${clauses.join(
        ' AND '
      )} ORDER BY at, received_at`
    )
    .all(...params)
    .map(toStored);
};
