import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { type PodStore, type StepEvent, StepEventSchema } from '../pod-store';
import { EventLineSchema, type ForwardedEvent } from './schema';

/**
 * The runner's side of events: it reads every new line of
 * `.lambda/events.jsonl` (the project root's and each active pod
 * worktree's) and of each pod's `steps.jsonl`, once each. Its place in each
 * file (a byte offset per path) is kept in `~/.lambda/events-cursor.json`,
 * so a restart sends nothing twice. Each event's id comes from where its
 * line sits, so a resend after a crash carries the same id.
 *
 * A rewritten file (it shrank, or a new file replaced it) is read again from
 * the top, so a new line can sit at an offset an old one had, and carry its
 * id. The id stays exactly the spec's: the rewrite is told apart by the
 * file's generation (0 until the first rewrite, one more each time), kept in
 * the cursor and sent beside the id. The mothership stores an event once per
 * (id, generation), so a resend is still ignored and a rewrite's lines are not.
 */

export const EVENTS_FILE = path.join('.lambda', 'events.jsonl');

/** The most one read takes in: a backlog is read over several scans. */
export const MAX_READ_BYTES = 4 * 1024 * 1024;

export interface Line {
  /** The byte offset the line starts at. */
  offset: number;
  text: string;
}

/** Complete lines from `offset` on, and where the next read starts. */
export const readNewLines = (
  file: string,
  offset: number
): { lines: Line[]; next: number } => {
  if (!fs.existsSync(file)) {
    return { lines: [], next: 0 };
  }

  const { size } = fs.statSync(file);
  // A file that shrank was rewritten: read it again from the top.
  const from = size < offset ? 0 : offset;

  if (size === from) {
    return { lines: [], next: from };
  }

  const handle = fs.openSync(file, 'r');

  try {
    // A backlog is read MAX_READ_BYTES at a time, over several scans.
    const buffer = Buffer.alloc(Math.min(size - from, MAX_READ_BYTES));
    fs.readSync(handle, buffer, 0, buffer.length, from);
    const lastNewline = buffer.lastIndexOf(0x0a);

    if (lastNewline === -1) {
      // One line longer than a read: skipped, so the cursor can't stall on
      // it (its tail reads as a line that isn't an event, with a warning).
      return buffer.length === MAX_READ_BYTES
        ? { lines: [], next: from + buffer.length }
        : { lines: [], next: from };
    }

    return {
      lines: linesIn(buffer.subarray(0, lastNewline + 1), from),
      next: from + lastNewline + 1,
    };
  } finally {
    fs.closeSync(handle);
  }
};

/** The non-blank lines of `whole` (ending in a newline), found by indexOf. */
const linesIn = (whole: Buffer, from: number): Line[] => {
  const lines: Line[] = [];
  const at = { start: 0 };

  while (at.start < whole.length) {
    const end = whole.indexOf(0x0a, at.start);
    const text = whole.subarray(at.start, end).toString('utf8');

    if (text.trim() !== '') {
      lines.splice(lines.length, 0, { offset: from + at.start, text });
    }

    at.start = end + 1;
  }

  return lines;
};

/** `<runner id>:<sha256 of the file's absolute path, first 12 hex>:<byte offset>`. */
export const eventId = (
  runnerId: string,
  file: string,
  offset: number
): string =>
  `${runnerId}:${crypto
    .createHash('sha256')
    .update(path.resolve(file))
    .digest('hex')
    .slice(0, 12)}:${offset}`;

/**
 * The ids an `event` message carries. Its `id` is what the outbox keeps and
 * the mothership acknowledges, so it must differ between generations; the
 * event's own id (`eventId`) never does. Generation 0 sends just the id.
 */
export const eventMessage = (
  id: string,
  generation: number
): { id: string; eventId?: string; generation?: number } =>
  generation === 0
    ? { id }
    : { id: `${id}#${generation}`, eventId: id, generation };

export interface TagContext {
  /** The pod the file belongs to (its worktree), when it does. */
  pod?: string;
  /** The pod's current ticket run, the fallback for ticket and attempt. */
  run?: { ticket?: string; attempt?: number };
  now: () => string;
}

/**
 * One events.jsonl line as a forwarded event, tagged with pod, ticket and
 * attempt. A line that isn't an event becomes a warning event, never
 * dropped.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const toForwarded = (
  text: string,
  context: TagContext
): ForwardedEvent => {
  const parsedJson: unknown = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  })();
  const parsed = EventLineSchema.safeParse(parsedJson);

  if (!parsed.success) {
    return {
      type: 'invalid',
      at: context.now(),
      raw: text.slice(0, 500),
      warning: "A line in events.jsonl that isn't an event.",
      ...(context.pod === undefined ? {} : { pod: context.pod }),
    };
  }

  const line = parsed.data;
  // A line that parsed is an object.
  const extra = isRecord(parsedJson) ? parsedJson : {};
  const pod = typeof extra.pod === 'string' ? extra.pod : context.pod;

  return {
    ...line,
    at: line.at ?? context.now(),
    ...(pod === undefined ? {} : { pod }),
    ticket: line.ticket ?? context.run?.ticket,
    // The run's attempt belongs to the run's ticket: a line naming another
    // ticket doesn't borrow it.
    attempt:
      line.attempt ??
      (line.ticket === undefined || line.ticket === context.run?.ticket
        ? context.run?.attempt
        : undefined),
  };
};

/**
 * A pod's steps.jsonl start/done lines as Lambda's own stage events. A
 * building step's skip, which always says why, is a `stage.end` with
 * `skipped` and its reason (no start ever opened it); a planning skip carries
 * no reason and isn't forwarded.
 */
export const stepToEvent = (
  step: StepEvent,
  podId: string
): ForwardedEvent | null =>
  step.event === 'start' ||
  step.event === 'done' ||
  (step.event === 'skip' && step.reason !== undefined)
    ? {
        type: step.event === 'start' ? 'stage.start' : 'stage.end',
        name: step.step,
        at: step.at,
        pod: podId,
        source: 'lambda',
        ...(step.ticket === undefined ? {} : { ticket: step.ticket }),
        ...(step.pass === undefined ? {} : { attempt: step.pass }),
        ...(step.event === 'skip'
          ? { skipped: true, reason: step.reason }
          : {}),
      }
    : null;

/** The latest ticket a pod's steps were about, else its epic. */
export const currentTicketRun = (
  store: PodStore,
  podId: string
): { ticket?: string; attempt?: number } => {
  const latest = [...store.readSteps(podId)]
    .reverse()
    .find((step) => step.ticket !== undefined);

  if (latest !== undefined) {
    return { ticket: latest.ticket, attempt: latest.pass };
  }

  return { ticket: store.readPod(podId)?.epicId };
};

export interface CursorEntry {
  offset: number;
  /** 0 until the file is rewritten; each rewrite adds one. */
  generation: number;
  /** The file's inode when last read: a different one means a new file. */
  inode?: number;
  /** A settled source read to its end: later scans skip it. */
  settled?: boolean;
}

/** Per file path. A bare number is the older format: an offset, generation 0. */
export type Cursor = Record<string, CursorEntry | number>;

const entryOf = (value: CursorEntry | number | undefined): CursorEntry =>
  typeof value === 'number'
    ? { offset: value, generation: 0 }
    : value ?? { offset: 0, generation: 0 };

const isMissing = (error: unknown): boolean =>
  isRecord(error) && error.code === 'ENOENT';

/** No file yet is an empty cursor; a file that can't be read throws. */
export const readCursor = (file: string): Cursor => {
  const text = (() => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }

      throw error;
    }
  })();

  if (text === null) {
    return {};
  }

  try {
    const cursor: Cursor = JSON.parse(text);

    return cursor;
  } catch (error) {
    throw new Error(
      `Can't read ${file}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
};

/**
 * Where to read `file` from next: the stored place, or the top of a new
 * generation when the file shrank, was replaced or went away.
 */
const placeOf = (file: string, stored: CursorEntry): CursorEntry => {
  if (!fs.existsSync(file)) {
    return stored.offset === 0
      ? stored
      : { offset: 0, generation: stored.generation + 1 };
  }

  const { size, ino } = fs.statSync(file);
  const replaced = stored.inode !== undefined && stored.inode !== ino;

  return replaced || size < stored.offset
    ? { offset: 0, generation: stored.generation + 1, inode: ino }
    : { ...stored, inode: ino };
};

/**
 * Each file once: listed twice (a project root that's also a pod's
 * worktree), the entry that names a pod wins.
 */
const uniqueSources = (sources: WatchSource[]): WatchSource[] => {
  const byFile = new Map<string, WatchSource>();
  sources.forEach((source) => {
    const key = `${source.kind}\u0000${path.resolve(source.file)}`;
    const seen = byFile.get(key);

    if (
      seen === undefined ||
      (seen.pod === undefined && source.pod !== undefined)
    ) {
      byFile.set(key, source);
    }
  });

  return [...byFile.values()];
};

/** The pod a line names (`lambda event` writes POD_ID into it). */
const podOfLine = (text: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);

    return isRecord(parsed) && typeof parsed.pod === 'string'
      ? parsed.pod
      : undefined;
  } catch {
    // Not JSON: toForwarded turns it into a warning event.
    return undefined;
  }
};

/** A steps.jsonl line as Lambda's stage event, or a warning when it isn't a step. */
const stepLineToEvent = (
  text: string,
  podId: string,
  now: () => string
): ForwardedEvent | null => {
  const step = StepEventSchema.safeParse(
    (() => {
      try {
        return JSON.parse(text);
      } catch {
        // Not JSON: refused by the schema just below, as a warning event.
        return undefined;
      }
    })()
  );

  if (!step.success) {
    return {
      type: 'invalid',
      at: now(),
      raw: text.slice(0, 500),
      warning: "A line in steps.jsonl that isn't a step.",
      pod: podId,
      source: 'lambda',
    };
  }

  return stepToEvent(step.data, podId);
};

export const writeCursor = (file: string, cursor: Cursor): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(cursor)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
};

export interface WatchSource {
  file: string;
  kind: 'events' | 'steps';
  pod?: string;
  /**
   * Nothing more is written to it (a pod that isn't active): once read to
   * its end, scans skip it until it's listed unsettled again.
   */
  settled?: boolean;
}

/**
 * Entries for files whose folder is gone too (a deleted pod's), and that
 * aren't being read: kept, they'd grow the cursor for ever. A missing file
 * in a folder that's still there keeps its entry, so a rewrite of it is
 * still told apart by its generation.
 */
const pruned = (cursor: Cursor, reading: Set<string>): Cursor =>
  Object.fromEntries(
    Object.entries(cursor).filter(
      ([file]) => reading.has(file) || fs.existsSync(path.dirname(file))
    )
  );

/**
 * One pass over the sources: every new line becomes `send(id, event,
 * generation)` (which must keep it — the outbox), then the cursor moves past
 * it. The cursor file is written only when a place in it changed.
 */
export const scanOnce = (options: {
  runnerId: string;
  sources: WatchSource[];
  cursorFile: string;
  store: PodStore | null;
  send: (id: string, event: ForwardedEvent, generation: number) => void;
  now?: () => string;
}): number => {
  const cursor = readCursor(options.cursorFile);
  const before = JSON.stringify(cursor);
  const now = options.now ?? (() => new Date().toISOString());
  // One read of a pod's steps a scan: a backlog of lines needn't re-read it.
  const runs = new Map<string, { ticket?: string; attempt?: number }>();
  const runOf = (store: PodStore, pod: string) => {
    const known = runs.get(pod);

    if (known !== undefined) {
      return known;
    }

    const run = currentTicketRun(store, pod);
    runs.set(pod, run);

    return run;
  };
  const sources = uniqueSources(options.sources);
  const sent = sources.reduce((count, source) => {
    const file = path.resolve(source.file);
    const stored = entryOf(cursor[file]);

    if (source.settled === true && stored.settled === true) {
      return count;
    }

    const place = placeOf(file, stored);
    const { lines, next } = readNewLines(file, place.offset);

    lines.forEach((line) => {
      const id = eventId(options.runnerId, file, line.offset);

      if (source.kind === 'steps') {
        const event =
          source.pod === undefined
            ? null
            : stepLineToEvent(line.text, source.pod, now);

        if (event !== null) {
          options.send(id, event, place.generation);
        }

        return;
      }

      const pod = podOfLine(line.text) ?? source.pod;
      const run =
        pod === undefined || options.store === null
          ? undefined
          : runOf(options.store, pod);
      options.send(
        id,
        toForwarded(line.text, { pod: source.pod, run, now }),
        place.generation
      );
    });

    const readToEnd =
      source.settled === true &&
      next === (fs.existsSync(file) ? fs.statSync(file).size : 0);
    cursor[file] = {
      offset: next,
      generation: place.generation,
      ...(place.inode === undefined ? {} : { inode: place.inode }),
      ...(readToEnd ? { settled: true } : {}),
    };

    return count + lines.length;
  }, 0);
  const kept = pruned(
    cursor,
    new Set(sources.map((source) => path.resolve(source.file)))
  );

  if (JSON.stringify(kept) !== before) {
    writeCursor(options.cursorFile, kept);
  }

  return sent;
};
