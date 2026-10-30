/**
 * Tickets as plain files in the project, in open-source Lambda's layout:
 *
 *   TASKS.md                       the queue, in order
 *     - [ ] PAWNEE-1: Park map page
 *       - [x] PAWNEE-1a: Map tiles
 *     - [B] PAWNEE-2: Volunteer sign-up form (blocked: Ann Perkins is out)
 *   tickets/PAWNEE-1.md            the ticket itself
 *
 * An existing TASKS.md reads and writes back byte for byte. What a checkbox
 * can't hold (planning, building, canceled; labels; blockedBy; the reporter;
 * `priority`; `assignee`, the computer or person it's assigned to) lives in a small front
 * matter at the top of the ticket file.
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { readKnownAssignees } from '../runner/localFiles';
import type { SourceContext } from './context';
import {
  type AttachOptions,
  type Attached,
  type CreateInput,
  type ListOptions,
  type Priority,
  type Ticket,
  type TicketSource,
  type TicketState,
  type TicketWithDescription,
  type UpdateInput,
  assertTicketId,
  attachImages,
  attachableFile,
  attachedName,
  checkReorder,
  filterByReporter,
  findNext,
  formatReporter,
  imageLink,
  isPriority,
  parsePriority,
  parseReporter,
  parseTicketState,
  placeAfter,
  placeImages,
  sameName,
  stillHasChildren,
  unknownTicket,
} from './source';

export const DEFAULT_QUEUE = 'TASKS.md';
export const DEFAULT_DIR = 'tickets';

const NOTHING_TO_PUSH =
  'Nothing to push: markdown tickets are already the files.';

/** States a `[ ]` line takes from its file; anything else reads as ready. */
const OPEN_STATES: TicketState[] = [
  'inbox',
  'planning',
  'ready',
  'building',
  'canceled',
];

/** The indent is spaces and tabs only: `\s` would take a byte order mark. */
const LINE = /^([ \t]*)-\s+\[([ xXB])\]\s+([A-Za-z0-9_-]+):\s*(.*)$/;
/** At the end of a `[B]` line only; the reason may hold its own brackets. */
const BLOCK_REASON = /\s*\(blocked:\s*(.*)\)\s*$/;

// ── the queue file ──────────────────────────────────────────────────────────

/** A queue line and the line ending written after it ('' on the last). */
interface QueueLine {
  text: string;
  eol: string;
}

interface Queue {
  lines: QueueLine[];
  /** The ending a new line gets: CRLF when the file has any, else LF. */
  eol: string;
  /** A byte order mark the file starts with, kept at byte 0 only. */
  bom: string;
}

interface Entry {
  id: string;
  /** The leading whitespace, kept as written. */
  indent: string;
  box: string;
  title: string;
  blockReason: string | null;
  line: number;
  parent: string | null;
}

const BOM = '\uFEFF';

/** Each line keeps its own ending, so a file mixing CRLF and LF reads whole. */
const splitQueue = (text: string): Queue => {
  const bom = text.startsWith(BOM) ? BOM : '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const parts = text.slice(bom.length).split(/(\r?\n)/);
  const lines = parts
    .filter((_part, index) => index % 2 === 0)
    .map((part, index) => ({ text: part, eol: parts[index * 2 + 1] ?? '' }));

  return { lines, eol, bom };
};

/**
 * Lines that moved keep their endings, but every line but the last needs
 * one and the last has none: a line moved off the end of a file with no
 * final newline takes the file's ending, and the new last line gives its up.
 */
const joinQueue = (queue: Queue): string =>
  `${queue.bom}${queue.lines
    .map(({ text, eol }, index, lines) => {
      if (index === lines.length - 1) {
        return text;
      }

      return `${text}${eol === '' ? queue.eol : eol}`;
    })
    .join('')}`;

const textsOf = (lines: QueueLine[]): string[] =>
  lines.map((line) => line.text);

/** A duplicate id is refused: place and reorder would lose its lines. */
const parseEntries = (lines: string[], where: string): Entry[] =>
  lines.reduce<Entry[]>((entries, text, line) => {
    const match = LINE.exec(text);

    if (match === null) {
      return entries;
    }

    const earlier = entries.find((entry) => entry.id === match[3]);

    if (earlier !== undefined) {
      throw new Error(
        `${where}:${line + 1}: ${earlier.id} is already on line ${
          earlier.line + 1
        }.`
      );
    }

    const [, indent = '', box = ' ', id = '', rest = ''] = match;
    const reason = box === 'B' ? BLOCK_REASON.exec(rest)?.[1] : undefined;
    const parent = [...entries]
      .reverse()
      .find((entry) => entry.indent.length < indent.length);

    return [
      ...entries,
      {
        id,
        indent,
        box,
        title: (box === 'B' ? rest.replace(BLOCK_REASON, '') : rest).trim(),
        blockReason: reason === undefined ? null : reason,
        line,
        parent: parent?.id ?? null,
      },
    ];
  }, []);

/** The line for an entry, keeping everything but the box and the reason. */
const entryLine = (
  original: string,
  entry: Entry,
  change: { box?: string; reason?: string | null; title?: string }
): string => {
  const match = LINE.exec(original);

  if (match === null) {
    throw new Error(`Line ${entry.line + 1} is no longer ${entry.id}.`);
  }

  const box = change.box ?? entry.box;
  const title = change.title ?? entry.title;
  const reason =
    box === 'B'
      ? change.reason === undefined
        ? entry.blockReason
        : change.reason
      : null;
  const head = original.slice(0, original.indexOf('[') + 1);
  const keepsTitle =
    change.title === undefined &&
    box === entry.box &&
    reason === entry.blockReason;

  if (keepsTitle) {
    return original;
  }

  return `${head}${box}] ${entry.id}: ${title}${
    reason === null ? '' : ` (blocked: ${reason})`
  }`;
};

const HEADING = /^[ \t]*#{1,6}(\s|$)/;

/** A note under a ticket: a line of text indented deeper than its entry. */
const isNote = (text: string, entry: Entry): boolean =>
  text.trim() !== '' &&
  !HEADING.test(text) &&
  (/^[ \t]*/.exec(text)?.[0].length ?? 0) > entry.indent.length;

/**
 * A ticket's line, every line indented under it, and the notes after its
 * last ticket line, up to a blank line, a heading or a line no deeper than
 * the ticket's own.
 */
const span = (
  lines: string[],
  entries: Entry[],
  entry: Entry
): { start: number; end: number } => {
  const after = entries.filter((other) => other.line > entry.line);
  const next = after.find(
    (other) => other.indent.length <= entry.indent.length
  );
  const last = after
    .filter((other) => next === undefined || other.line < next.line)
    .at(-1);
  const lastTicket = (last ?? entry).line + 1;
  const stop = lines.findIndex(
    (text, index) => index >= lastTicket && !isNote(text, entry)
  );

  return { start: entry.line, end: stop === -1 ? lines.length : stop };
};

/**
 * Rearranges sibling blocks: the blocks change places, while the lines
 * between them (blank lines, headings) stay where they were.
 */
const rearrange = (
  lines: QueueLine[],
  entries: Entry[],
  siblings: Entry[],
  order: string[]
): QueueLine[] => {
  const spans = siblings.map((entry) => ({
    id: entry.id,
    ...span(textsOf(lines), entries, entry),
  }));
  const [first] = spans;

  if (first === undefined) {
    return lines;
  }

  const gaps = spans.map((current, index) =>
    lines.slice(current.end, spans[index + 1]?.start ?? current.end)
  );
  const lastSpan = spans.at(-1) ?? first;
  const blockOf = (id: string): QueueLine[] => {
    const found = spans.find((candidate) => candidate.id === id);

    if (found === undefined) {
      throw unknownTicket(id);
    }

    return lines.slice(found.start, found.end);
  };

  return [
    ...lines.slice(0, first.start),
    ...order.flatMap((id, index) => [...blockOf(id), ...(gaps[index] ?? [])]),
    ...lines.slice(lastSpan.end),
  ];
};

// ── ticket files ────────────────────────────────────────────────────────────

interface TicketFile {
  /** Front matter fields in file order; null when the file has none. */
  fields: Array<[string, string]> | null;
  body: string;
  eol: string;
}

/** `"planning"` or `'planning'` → `planning`. */
const unquote = (value: string): string => {
  const quoted = /^(["'])(.*)\1$/.exec(value);

  return quoted === null ? value : quoted[2] ?? '';
};

const FIELD_LINE = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/;
const LIST_ITEM_LINE = /^\s+-\s+(.*)$/;

/**
 * Front matter is one `key: value` per line; a key with no value may be
 * followed by a YAML list (`  - PAWNEE-3`), read as `[PAWNEE-3]`. Any other
 * line is refused, naming the file and line, rather than dropped on the next
 * write.
 */
const parseFields = (lines: string[], where: string): Array<[string, string]> =>
  lines.reduce<Array<[string, string]>>((fields, line, index) => {
    if (line.trim() === '') {
      return fields;
    }

    const item = LIST_ITEM_LINE.exec(line);
    const last = fields.at(-1);

    // A bare `key:` (or one already holding a list) takes the items under it.
    if (
      item !== null &&
      last !== undefined &&
      (last[1] === '' || /^\[.*\]$/.test(last[1]))
    ) {
      const items = last[1].slice(1, -1);
      const value = unquote((item[1] ?? '').trim());

      return [
        ...fields.slice(0, -1),
        [last[0], `[${items === '' ? value : `${items}, ${value}`}]`],
      ];
    }

    const match = FIELD_LINE.exec(line);

    if (match === null) {
      throw new Error(
        `${where}:${
          index + 2
        }: Lambda reads front matter as one "key: value" per line (or a "  - item" list under a key) and can't read "${line.trim()}".`
      );
    }

    return [...fields, [match[1] ?? '', unquote((match[2] ?? '').trim())]];
  }, []);

const parseTicketFile = (text: string, where: string): TicketFile => {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(eol);

  if (lines[0] !== '---') {
    return { fields: null, body: text, eol };
  }

  const close = lines.indexOf('---', 1);

  if (close === -1) {
    return { fields: null, body: text, eol };
  }

  return {
    fields: parseFields(lines.slice(1, close), where),
    body: lines.slice(close + 1).join(eol),
    eol,
  };
};

const serializeTicketFile = (file: TicketFile): string =>
  file.fields === null || file.fields.length === 0
    ? file.body
    : [
        '---',
        ...file.fields.map(([key, value]) => `${key}: ${value}`),
        '---',
        file.body,
      ].join(file.eol);

const field = (file: TicketFile, key: string): string | undefined =>
  file.fields?.find(([name]) => name === key)?.[1];

const listField = (file: TicketFile, key: string): string[] => {
  const value = field(file, key);

  if (value === undefined || value === '') {
    return [];
  }

  const inner = /^\[(.*)\]$/.exec(value)?.[1] ?? value;

  return inner
    .split(',')
    .map((item) => unquote(item.trim()))
    .filter((item) => item !== '');
};

const setField = (
  file: TicketFile,
  key: string,
  value: string | undefined
): TicketFile => {
  const fields = file.fields ?? [];
  const exists = fields.some(([name]) => name === key);
  const next: Array<[string, string]> =
    value === undefined
      ? fields.filter(([name]) => name !== key)
      : exists
      ? fields.map(([name, old]): [string, string] => [
          name,
          name === key ? value : old,
        ])
      : [...fields, [key, value]];

  return { ...file, fields: next };
};

const setList = (file: TicketFile, key: string, values: string[]): TicketFile =>
  setField(
    file,
    key,
    values.length === 0 ? undefined : `[${values.join(', ')}]`
  );

const titleBody = (title: string, description?: string): string =>
  description === undefined || description.trim() === ''
    ? `# ${title}\n`
    : `# ${title}\n\n${description.trim()}\n`;

/** The body under the `# title` heading. */
const descriptionOf = (file: TicketFile): string =>
  file.body
    .split(file.eol)
    .filter((line, index, lines) => {
      const firstHeading = lines.findIndex((candidate) =>
        /^#\s/.test(candidate)
      );

      return index !== firstHeading;
    })
    .join(file.eol)
    .trim();

/** A ticket file's `priority:`; none when it has none, or one Lambda can't read. */
const priorityOf = (file: TicketFile | null): Priority => {
  const written = file === null ? undefined : field(file, 'priority');

  return written !== undefined && isPriority(written) ? written : 'none';
};

/**
 * A ticket file's `assignee:`: a computer's name, or a person's (the owner
 * doing it by hand). `computer:`, its first name, still reads. A computer's
 * `assignee-id:` wins: it's read as that computer's name now, so a renamed
 * computer keeps its tickets (`computers`: Lambda's ids → names).
 */
const assigneeOf = (
  file: TicketFile | null,
  computers: Record<string, string>
): string | null => {
  const id = file === null ? undefined : field(file, 'assignee-id');
  const current = id === undefined ? undefined : computers[id];

  if (current !== undefined) {
    return current;
  }

  const written =
    file === null
      ? undefined
      : field(file, 'assignee') ?? field(file, 'computer');

  return written === undefined || written.trim() === '' ? null : written;
};

/** The file with its description (under `# title`) replaced. */
const withDescription = (file: TicketFile, description: string): TicketFile => {
  const heading = file.body.split(file.eol).find((line) => /^#\s/.test(line));
  const body = titleBody(
    heading === undefined ? '' : heading.replace(/^#\s+/, ''),
    description
  );

  return { ...file, body: body.split('\n').join(file.eol) };
};

/** `priority:` set, or taken out for `none`. */
const setPriority = (file: TicketFile, priority: Priority): TicketFile =>
  setField(file, 'priority', priority === 'none' ? undefined : priority);

/**
 * `assignee:` set, or taken out when unassigned; an old `computer:` goes. A
 * computer Lambda knows gets its `assignee-id:` beside its name; a person
 * (or a computer it doesn't know) has only the name.
 */
const setAssignee = (
  file: TicketFile,
  assignee: string | null,
  computers: Record<string, string>
): TicketFile => {
  const name =
    assignee === null || assignee.trim() === '' ? undefined : assignee.trim();
  const id =
    name === undefined
      ? undefined
      : Object.entries(computers).find(([, known]) =>
          sameName(known, name)
        )?.[0];

  return setField(
    setField(setField(file, 'computer', undefined), 'assignee', name),
    'assignee-id',
    id
  );
};

/** A ticket file's `project:`, the group it's in; null: none. */
const projectOf = (file: TicketFile | null): string | null => {
  const written = file === null ? undefined : field(file, 'project');

  return written === undefined || written.trim() === '' ? null : written;
};

/** `project:` set, or taken out. */
const setProject = (file: TicketFile, project: string | null): TicketFile =>
  setField(
    file,
    'project',
    project === null || project.trim() === '' ? undefined : project.trim()
  );

/** A file's last change (ISO), or null when it isn't there. */
const modifiedAt = (file: string): string | null => {
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
};

// ── paths ───────────────────────────────────────────────────────────────────

const realpathOf = (target: string): string => {
  if (fs.existsSync(target)) {
    return fs.realpathSync(target);
  }

  const parent = path.dirname(target);

  return parent === target
    ? target
    : path.join(realpathOf(parent), path.basename(target));
};

const atomicWrite = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`
  );
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
};

// ── one writer at a time ────────────────────────────────────────────────────

/** How long a writer waits for the queue lock, and when a lock is stale. */
export interface LockTiming {
  /** Give up after waiting this long. */
  waitMs: number;
  /** A lock file older than this was left by a writer that died. */
  staleMs: number;
  /** The first pause between tries; it doubles up to `MAX_RETRY_MS`. */
  retryMs: number;
}

export const DEFAULT_LOCK: LockTiming = {
  waitMs: 10_000,
  staleMs: 60_000,
  retryMs: 10,
};

const MAX_RETRY_MS = 200;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Not `instanceof Error`: fs errors can come from another realm (jest's). */
const hasCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === code;

/**
 * Takes `lock` for this writer, or null while another writer holds it. The
 * lock file carries a token naming its holder, so a writer only ever removes
 * its own.
 */
const tryLock = (lock: string): string | null => {
  try {
    const descriptor = fs.openSync(lock, 'wx');
    const token = randomUUID();

    try {
      fs.writeSync(descriptor, token);
    } finally {
      fs.closeSync(descriptor);
    }

    return token;
  } catch (error) {
    if (hasCode(error, 'EEXIST')) {
      return null;
    }

    throw error;
  }
};

/** How old the lock file is, or null when it has just gone. */
const ageOf = (file: string): number | null => {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return null;
    }

    throw error;
  }
};

/** Who holds the lock (its token), or null when it has gone. */
const holderOf = (lock: string): string | null => {
  try {
    return fs.readFileSync(lock, 'utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return null;
    }

    throw error;
  }
};

/**
 * Clears a stale lock; true when it did. Two writers can see the same stale
 * lock, and the first to clear it takes a fresh one at once, so clearing
 * happens under a second lock and only after a fresh look: the second writer
 * then finds the new lock fresh and waits.
 */
const clearStale = (lock: string, timing: LockTiming): boolean => {
  const breaker = `${lock}.clearing`;
  const token = tryLock(breaker);

  if (token === null) {
    const age = ageOf(breaker);

    if (age !== null && age > timing.staleMs) {
      throw new Error(
        `${breaker} was left by a lambda that stopped while clearing a stale lock; delete it if nothing else is running.`
      );
    }

    return false;
  }

  try {
    const age = ageOf(lock);

    if (age === null || age <= timing.staleMs) {
      return false;
    }

    fs.rmSync(lock, { force: true });

    return true;
  } finally {
    release(breaker, token);
  }
};

/** Removes `lock` if this writer still holds it. */
const release = (lock: string, token: string): void => {
  if (holderOf(lock) === token) {
    fs.rmSync(lock, { force: true });
  }
};

const acquire = async (
  lock: string,
  timing: LockTiming,
  waited: number,
  pause: number
): Promise<string> => {
  const token = tryLock(lock);

  if (token !== null) {
    return token;
  }

  const age = ageOf(lock);

  if (age !== null && age > timing.staleMs && clearStale(lock, timing)) {
    return acquire(lock, timing, waited, pause);
  }

  if (waited >= timing.waitMs) {
    throw new Error(
      `Another lambda is writing the queue (${lock} is held); try again, or delete that file if nothing else is running.`
    );
  }

  await sleep(pause);

  return acquire(
    lock,
    timing,
    waited + pause,
    Math.min(pause * 2, MAX_RETRY_MS)
  );
};

/** Runs `change` holding `lock`, released however it ends. */
const withLock = async <T>(
  lock: string,
  timing: LockTiming,
  change: () => T
): Promise<T> => {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const token = await acquire(lock, timing, 0, timing.retryMs);

  try {
    return change();
  } finally {
    release(lock, token);
  }
};

/**
 * A ticket file's comments: each `- ` entry under `## Comments` (up to the
 * next `#` or `##` section), with the lines that continue it.
 */
export const commentEntries = (body: string, eol: string): string[] => {
  const lines = body.split(eol);
  const heading = lines.indexOf('## Comments');

  if (heading === -1) {
    return [];
  }

  const next = lines.findIndex(
    (line, index) => index > heading && /^#{1,2}\s/.test(line)
  );

  return lines
    .slice(heading + 1, next === -1 ? lines.length : next)
    .reduce<string[]>((entries, line) => {
      if (line.startsWith('- ')) {
        return [...entries, line];
      }

      const last = entries.at(-1);

      return last === undefined
        ? entries
        : [...entries.slice(0, -1), `${last}\n${line}`];
    }, [])
    .map((entry) => entry.trim());
};

// ── the source ──────────────────────────────────────────────────────────────

export const createMarkdownSource = (
  context: SourceContext,
  lockTiming: LockTiming = DEFAULT_LOCK
): TicketSource => {
  const { root, config } = context;
  /** Lambda's computers by id, as this computer was last told them. */
  const knownComputers = (): Record<string, string> =>
    readKnownAssignees(context.env).computers;
  const queueSetting = config.queue ?? DEFAULT_QUEUE;
  const dirSetting = config.dir ?? DEFAULT_DIR;

  /** A path from the project, refused when it ends up outside it. */
  const inside = (setting: string, relative: string): string => {
    const target = path.resolve(root, relative);
    const realRoot = realpathOf(root);
    const away = path.relative(realRoot, realpathOf(target));

    // `..tickets` is a folder inside the project; only `..` itself climbs out.
    if (
      away === '..' ||
      away.startsWith(`..${path.sep}`) ||
      path.isAbsolute(away)
    ) {
      throw new Error(
        `${setting} "${relative}" is outside the project; it must stay inside ${root}.`
      );
    }

    return target;
  };

  const queuePath = (): string => inside('tickets.queue', queueSetting);
  const ticketPath = (id: string): string => {
    inside('tickets.dir', dirSetting);

    return inside(
      'tickets.dir',
      path.join(dirSetting, `${assertTicketId(id)}.md`)
    );
  };

  /**
   * The queue, for reading or changing a ticket in it: a missing one is
   * refused, since only create starts it.
   */
  const readQueue = (): Queue => {
    const file = queuePath();

    if (!fs.existsSync(file)) {
      throw new Error(
        `tickets.queue "${queueSetting}" names no file: ${file} doesn't exist. Fix tickets.queue in lambda.json, or create a ticket to start the queue.`
      );
    }

    return splitQueue(fs.readFileSync(file, 'utf8'));
  };

  const readQueueOrNew = (): Queue =>
    fs.existsSync(queuePath()) ? readQueue() : splitQueue('');

  /** Every write to the queue or a ticket file holds this lock. */
  const locked = <T>(change: () => T): Promise<T> => {
    const queue = queuePath();

    return withLock(
      path.join(path.dirname(queue), `.${path.basename(queue)}.lock`),
      lockTiming,
      change
    );
  };

  const writeQueue = (before: Queue, lines: QueueLine[]): void => {
    const after = joinQueue({ ...before, lines });

    if (after !== joinQueue(before)) {
      atomicWrite(queuePath(), after);
    }
  };

  const readFile = (id: string): TicketFile | null => {
    const file = ticketPath(id);

    return fs.existsSync(file)
      ? parseTicketFile(
          fs.readFileSync(file, 'utf8'),
          path.relative(root, file)
        )
      : null;
  };

  /** The ticket's file, creating it with `# <title>` when it has none. */
  const fileFor = (entry: Entry): TicketFile =>
    readFile(entry.id) ?? {
      fields: null,
      body: titleBody(entry.title),
      eol: '\n',
    };

  const writeFile = (id: string, file: TicketFile): void =>
    atomicWrite(ticketPath(id), serializeTicketFile(file));

  /** A new ticket's file, refused when one is already there. */
  const writeNewFile = (id: string, file: TicketFile): void => {
    const target = ticketPath(id);
    fs.mkdirSync(path.dirname(target), { recursive: true });

    try {
      fs.closeSync(fs.openSync(target, 'wx'));
    } catch (error) {
      if (hasCode(error, 'EEXIST')) {
        throw new Error(
          `${path.relative(
            root,
            target
          )} already exists, but ${id} isn't in the queue; move that file away, then create again.`
        );
      }

      throw error;
    }

    try {
      atomicWrite(target, serializeTicketFile(file));
    } catch (error) {
      fs.rmSync(target, { force: true });

      throw error;
    }
  };

  const entriesOf = (queue: Queue): Entry[] =>
    parseEntries(textsOf(queue.lines), queueSetting);

  /**
   * The ticket's block (its line, its children and notes) moved to the end of
   * `parentId`'s children, or of the queue when null, and indented to match.
   */
  const moveUnder = (
    lines: QueueLine[],
    entry: Entry,
    parentId: string | null
  ): QueueLine[] => {
    const entries = parseEntries(textsOf(lines), queueSetting);
    const moving = findEntry(entries, entry.id);
    const { start, end } = span(textsOf(lines), entries, moving);
    const block = lines.slice(start, end);
    const rest = [...lines.slice(0, start), ...lines.slice(end)];
    const within = entries
      .filter((other) => other.line >= start && other.line < end)
      .map((other) => other.id);

    if (parentId !== null && within.includes(parentId)) {
      throw new Error(
        `Can't move ${entry.id} under itself or one of its own children.`
      );
    }

    const left = parseEntries(textsOf(rest), queueSetting);
    const parent = parentId === null ? undefined : findEntry(left, parentId);

    const siblings = left.filter(
      (other) => other.parent === (parent?.id ?? null)
    );
    const indent =
      siblings[0]?.indent ?? (parent === undefined ? '' : `${parent.indent}  `);
    const moved = block.map((current) => ({
      ...current,
      text: `${indent}${current.text.slice(moving.indent.length)}`,
    }));

    if (parent === undefined) {
      return moved.reduce(appendLine, rest);
    }

    const at = span(textsOf(rest), left, parent).end;

    return [...rest.slice(0, at), ...moved, ...rest.slice(at)];
  };

  const findEntry = (entries: Entry[], id: string): Entry => {
    const entry = entries.find(
      (candidate) => candidate.id === assertTicketId(id)
    );

    if (entry === undefined) {
      throw unknownTicket(id);
    }

    return entry;
  };

  const statusOf = (entry: Entry, file: TicketFile | null): TicketState => {
    if (entry.box === 'x' || entry.box === 'X') {
      return 'done';
    }

    if (entry.box === 'B') {
      return 'blocked';
    }

    const written = file === null ? undefined : field(file, 'status');

    return OPEN_STATES.find((state) => state === written) ?? 'ready';
  };

  const toTicket = (entries: Entry[], entry: Entry): TicketWithDescription => {
    const file = readFile(entry.id);
    const reporter = file === null ? undefined : field(file, 'reporter');

    return {
      id: entry.id,
      title: entry.title,
      status: statusOf(entry, file),
      labels: file === null ? [] : listField(file, 'labels'),
      parent: entry.parent,
      children: entries
        .filter((other) => other.parent === entry.id)
        .map((other) => other.id),
      blockedBy: file === null ? [] : listField(file, 'blockedBy'),
      blockReason: entry.blockReason,
      reporter: reporter === undefined ? null : parseReporter(reporter),
      url: null,
      priority: priorityOf(file),
      assignee: assigneeOf(file, knownComputers()),
      project: projectOf(file),
      updatedAt: modifiedAt(ticketPath(entry.id)),
      description: file === null ? '' : descriptionOf(file),
    };
  };

  const withoutDescription = ({
    description: _description,
    ...ticket
  }: TicketWithDescription): Ticket => ticket;

  /**
   * Every ticket. No queue file yet at the default path means no tickets
   * yet; a tickets.queue the project named must exist, so a typo in it is
   * refused rather than read as an empty queue.
   */
  const all = (): Ticket[] => {
    const entries = entriesOf(
      config.queue === undefined ? readQueueOrNew() : readQueue()
    );

    return entries.map((entry) => withoutDescription(toTicket(entries, entry)));
  };

  const getTicket = (id: string): TicketWithDescription => {
    const entries = entriesOf(readQueue());

    return toTicket(entries, findEntry(entries, id));
  };

  const BOX: Record<TicketState, string> = {
    inbox: ' ',
    planning: ' ',
    ready: ' ',
    building: ' ',
    canceled: ' ',
    blocked: 'B',
    done: 'x',
  };

  /**
   * Every id a new ticket must not take: each one in TASKS.md, and each one a
   * ticket file is still blocked by. A deleted ticket's id stays taken while
   * anything names it, so the new ticket never inherits its blocks.
   */
  const takenIds = (entries: Entry[]): string[] => {
    const dir = inside('tickets.dir', dirSetting);
    const files = fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((name) => /^[A-Za-z0-9_-]+\.md$/.test(name))
          .map((name) => readFile(name.slice(0, -'.md'.length)))
      : [];
    const blockers = files.flatMap((file) =>
      file === null ? [] : listField(file, 'blockedBy')
    );

    return [...entries.map((entry) => entry.id), ...blockers];
  };

  const nextId = (entries: Entry[], parent: Entry | undefined): string => {
    const { prefix } = config;

    if (prefix === undefined) {
      throw new Error(
        'Set tickets.prefix in lambda.json (for example "PAWNEE") to create tickets.'
      );
    }

    const taken = takenIds(entries);
    const id =
      parent === undefined
        ? nextNumber(prefix, taken)
        : nextChild(parent, taken);

    if (taken.includes(id)) {
      throw new Error(
        `${id} is already in ${queueSetting} or named in a blockedBy; Lambda won't give a new ticket an id in use.`
      );
    }

    return id;
  };

  /**
   * Copies a file to `<tickets dir>/<id>/<name>`, replacing one already
   * there; the ref is the link from the ticket file, `./<id>/<name>`.
   */
  const attachFile = (
    id: string,
    filePath: string,
    options: AttachOptions = {}
  ): Attached => {
    const from = attachableFile(filePath);
    const name = attachedName(from, options.name);
    const entry = findEntry(entriesOf(readQueue()), id);
    const target = inside('tickets.dir', path.join(dirSetting, entry.id, name));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(from, target);

    // `#` and `?` would cut the link short, and parentheses end it early.
    return {
      ref: `./${entry.id}/${encodeURIComponent(name)
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29')}`,
    };
  };

  const source: TicketSource = {
    kind: 'markdown',

    // Its projects are the names its ticket files use.
    projects: async () =>
      [
        ...new Set(
          all().flatMap((ticket) =>
            ticket.project === null || ticket.project === undefined
              ? []
              : [ticket.project]
          )
        ),
      ]
        .sort((a, b) => a.localeCompare(b))
        .map((name) => ({
          id: name,
          name,
          icon: null,
          color: null,
          status: null,
          progress: null,
          lead: null,
          targetDate: null,
          description: '',
          url: null,
        })),

    list: async (options: ListOptions = {}) => filterByReporter(all(), options),

    get: async (id) => getTicket(id),

    pull: async (id) =>
      locked(() => {
        const entries = entriesOf(readQueue());
        const entry = findEntry(entries, id);

        if (readFile(entry.id) === null) {
          writeFile(entry.id, fileFor(entry));
        }

        return path.relative(root, ticketPath(entry.id));
      }),

    push: async (id) => {
      findEntry(entriesOf(readQueue()), id);

      return NOTHING_TO_PUSH;
    },

    create: async (input: CreateInput) =>
      locked(() => {
        const status = parseTicketState(input.status ?? 'inbox');
        oneLine('title', input.title);
        checkLabels(input.labels);
        oneLine('assignee', input.assignee ?? undefined);
        oneLine('project', input.project ?? undefined);
        // Only create may start the queue file.
        const queue = readQueueOrNew();
        const entries = entriesOf(queue);
        const parent =
          input.parent === undefined
            ? undefined
            : findEntry(entries, input.parent);
        const id = nextId(entries, parent);
        const siblings = entries.filter(
          (entry) => entry.parent === (parent?.id ?? null)
        );
        const indent =
          parent === undefined
            ? siblings[0]?.indent ?? ''
            : siblings[0]?.indent ?? `${parent.indent}  `;
        const line = {
          text: `${indent}- [${BOX[status]}] ${id}: ${input.title}`,
          eol: queue.eol,
        };
        const end =
          parent === undefined
            ? undefined
            : span(textsOf(queue.lines), entries, parent).end;
        const lines =
          end === undefined
            ? appendLine(queue.lines, line)
            : [...queue.lines.slice(0, end), line, ...queue.lines.slice(end)];

        const withStatus = setField(
          {
            fields: null,
            body: titleBody(input.title, input.description),
            eol: '\n',
          },
          'status',
          status
        );
        const withReporter =
          context.runner === null
            ? withStatus
            : setField(withStatus, 'reporter', formatReporter(context.runner));
        const file = setList(
          setProject(
            setAssignee(
              setPriority(
                withReporter,
                parsePriority(input.priority ?? 'none')
              ),
              input.assignee ?? null,
              knownComputers()
            ),
            input.project ?? null
          ),
          'labels',
          (input.labels ?? []).filter(
            (label, index, all) => all.indexOf(label) === index
          )
        );

        // The file first: a queue line whose file never got written would read
        // as ready, while a file with no queue line is simply not in the queue.
        writeNewFile(id, file);
        writeQueue(queue, lines);

        return withoutDescription(getTicket(id));
      }),

    update: async (id, input: UpdateInput) =>
      locked(() => {
        const status =
          input.status === undefined
            ? undefined
            : parseTicketState(input.status);
        checkUpdateInput(input);
        const queue = readQueue();
        const entries = entriesOf(queue);
        const entry = findEntry(entries, id);
        const original = queue.lines[entry.line]?.text ?? '';
        const line = entryLine(original, entry, {
          box: status === undefined ? undefined : BOX[status],
          reason: status === 'blocked' ? input.reason ?? null : undefined,
          title: input.title,
        });
        const file = fileFor(entry);
        const withStatus =
          status === undefined ? file : setField(file, 'status', status);
        const labels = listField(withStatus, 'labels');
        const added =
          input.labels === undefined
            ? withStatus
            : setList(withStatus, 'labels', [
                ...labels,
                ...input.labels.filter(
                  (label, index, adding) =>
                    !labels.includes(label) && adding.indexOf(label) === index
                ),
              ]);
        const removed =
          input.removeLabels === undefined
            ? added
            : setList(
                added,
                'labels',
                listField(added, 'labels').filter(
                  (label) => !(input.removeLabels ?? []).includes(label)
                )
              );
        const prioritized =
          input.priority === undefined
            ? removed
            : setPriority(removed, parsePriority(input.priority));
        const assignedOnly =
          input.assignee === undefined
            ? prioritized
            : setAssignee(prioritized, input.assignee, knownComputers());
        const assigned =
          input.project === undefined
            ? assignedOnly
            : setProject(assignedOnly, input.project);
        const withLabels =
          input.description === undefined
            ? assigned
            : withDescription(assigned, input.description);
        const { title } = input;
        const renamed =
          title === undefined
            ? withLabels
            : {
                ...withLabels,
                // A function, so `$&` or `$$` in the title is written as is.
                body: withLabels.body.replace(/^# .*$/m, () => `# ${title}`),
              };
        // A ticket with no file gets one only when something in it changes.
        const unchanged =
          serializeTicketFile(renamed) === serializeTicketFile(file);

        // The file first, as create does: a `[ ]` line whose file never got
        // `status: blocked` would read as ready.
        if (!unchanged) {
          writeFile(entry.id, renamed);
        }

        const relined = queue.lines.map((current, index) =>
          index === entry.line ? { ...current, text: line } : current
        );

        writeQueue(
          queue,
          input.parent === undefined || input.parent === entry.parent
            ? relined
            : moveUnder(relined, entry, input.parent)
        );

        return withoutDescription(getTicket(entry.id));
      }),

    attach: async (id, filePath, options) =>
      locked(() => attachFile(id, filePath, options)),

    comment: async (id, text, options = {}) => {
      findEntry(entriesOf(readQueue()), id);
      // Every picture is saved first; a failure leaves the comment unwritten.
      const images = await attachImages(options.images ?? [], async (file) =>
        attachFile(id, file)
      );

      return locked(() => {
        const entry = findEntry(entriesOf(readQueue()), id);
        const file = fileFor(entry);
        const name = context.runner?.name ?? 'Owner';
        const placed = placeImages(text, images);
        // Each picture with no token on its own indented line below.
        const line = [
          `- ${name}: ${placed.text}`,
          ...placed.rest.map((image) => `  ${imageLink(image)}`),
        ].join(file.eol);
        const lines = file.body.split(file.eol);
        const heading = lines.indexOf('## Comments');

        if (heading === -1) {
          const body =
            file.body.endsWith(file.eol) || file.body === ''
              ? file.body
              : `${file.body}${file.eol}`;

          writeFile(entry.id, {
            ...file,
            body: `${body}${file.eol}## Comments${file.eol}${file.eol}${line}${file.eol}`,
          });

          return;
        }

        // Under the Comments section, even when another section follows it.
        const nextSection = lines.findIndex(
          (candidate, index) => index > heading && /^#{1,2}\s/.test(candidate)
        );
        const sectionEnd = nextSection === -1 ? lines.length : nextSection;
        const lastText = lines
          .slice(0, sectionEnd)
          .reduce(
            (last, candidate, index) =>
              index > heading && candidate.trim() !== '' ? index : last,
            -1
          );
        const updated =
          lastText === -1
            ? [
                ...lines.slice(0, heading + 1),
                '',
                line,
                ...lines.slice(heading + 1),
              ]
            : [
                ...lines.slice(0, lastText + 1),
                line,
                ...lines.slice(lastText + 1),
              ];

        writeFile(entry.id, { ...file, body: updated.join(file.eol) });
      });
    },

    comments: async (id) => {
      const file = fileFor(findEntry(entriesOf(readQueue()), id));

      return commentEntries(file.body, file.eol);
    },

    delete: async (id) =>
      locked(() => {
        const queue = readQueue();
        const entries = entriesOf(queue);
        const entry = findEntry(entries, id);
        const children = entries.filter((other) => other.parent === entry.id);

        if (children.length > 0) {
          throw stillHasChildren(
            entry.id,
            children.map((child) => child.id)
          );
        }

        const file = ticketPath(entry.id);
        const { start, end } = span(textsOf(queue.lines), entries, entry);
        writeQueue(
          queue,
          queue.lines.filter((_text, index) => index < start || index >= end)
        );

        if (fs.existsSync(file)) {
          fs.rmSync(file);
        }
      }),

    block: async (id, by) =>
      locked(() => {
        const entries = entriesOf(readQueue());
        const entry = findEntry(entries, id);
        const blocker = findEntry(entries, by);
        const file = fileFor(entry);
        const blockedBy = listField(file, 'blockedBy');

        if (blockedBy.includes(blocker.id)) {
          return;
        }

        writeFile(
          entry.id,
          setList(file, 'blockedBy', [...blockedBy, blocker.id])
        );
      }),

    unblock: async (id, by) =>
      locked(() => {
        const entries = entriesOf(readQueue());
        const entry = findEntry(entries, id);
        // Only the id: the blocker may be deleted, and unblocking is the way out.
        const blocker = assertTicketId(by);
        const file = readFile(entry.id);

        if (file === null) {
          return;
        }

        const blockedBy = listField(file, 'blockedBy');

        if (!blockedBy.includes(blocker)) {
          return;
        }

        writeFile(
          entry.id,
          setList(
            file,
            'blockedBy',
            blockedBy.filter((other) => other !== blocker)
          )
        );
      }),

    reorder: async (parentId, order) =>
      locked(() => {
        const queue = readQueue();
        const entries = entriesOf(queue);
        const parent = findEntry(entries, parentId);
        const children = entries.filter((entry) => entry.parent === parent.id);

        checkReorder(
          parent.id,
          children.map((child) => child.id),
          order
        );
        writeQueue(queue, rearrange(queue.lines, entries, children, order));
      }),

    place: async (ids, after) =>
      locked(() => {
        const queue = readQueue();
        const entries = entriesOf(queue);
        const target = findEntry(entries, after);
        const moving = ids.map((id) => findEntry(entries, id));
        const nested = [target, ...moving].filter(
          (entry) => entry.parent !== null
        );

        if (nested.length > 0) {
          throw new Error(
            `place moves top-level tickets; ${nested
              .map((entry) => entry.id)
              .join(', ')} ${
              nested.length === 1 ? 'is a child' : 'are children'
            } (use reorder).`
          );
        }

        const topLevel = entries.filter((entry) => entry.parent === null);
        const order = placeAfter(
          topLevel.map((entry) => entry.id),
          moving.map((entry) => entry.id),
          target.id
        );

        writeQueue(queue, rearrange(queue.lines, entries, topLevel, order));
      }),

    next: async (options: ListOptions = {}) => findNext(all(), options),
    // Every blocker is a file here: nothing is outside the list.
    queue: async () => ({ tickets: all(), outside: new Map() }),
  };

  return source;
};

/** One past the highest number taken under `prefix`, child ids included. */
const nextNumber = (prefix: string, taken: string[]): string => {
  const numbers = taken
    .map((id) => new RegExp(`^${prefix}-(\\d+)[a-z]?$`).exec(id)?.[1])
    .filter((digits): digits is string => digits !== undefined)
    .map(Number);

  return `${prefix}-${Math.max(0, ...numbers) + 1}`;
};

/**
 * The letter after the highest one taken under `parent`, wherever that id
 * now sits: a child moved to the top by hand keeps its letter.
 */
const nextChild = (parent: Entry, taken: string[]): string => {
  const letters = taken
    .map((id) => new RegExp(`^${parent.id}([a-z])$`).exec(id)?.[1])
    .filter((letter): letter is string => letter !== undefined)
    .map((letter) => letter.charCodeAt(0));
  const highest = Math.max('a'.charCodeAt(0) - 1, ...letters);

  if (highest >= 'z'.charCodeAt(0)) {
    throw new Error(`${parent.id} already has children up to z.`);
  }

  return `${parent.id}${String.fromCharCode(highest + 1)}`;
};

/** Appends a line, keeping whether the file ended with a newline. */
const appendLine = (lines: QueueLine[], line: QueueLine): QueueLine[] => {
  const last = lines.at(-1);

  // An empty file, or the empty piece after a final newline, stays last.
  return last?.text === ''
    ? [...lines.slice(0, -1), line, last]
    : [...lines, line];
};

/** A title, reason or label is one line of TASKS.md or the front matter. */
const oneLine = (name: string, value: string | undefined): void => {
  if (value !== undefined && /[\r\n]/.test(value)) {
    throw new Error(`${name} can't span lines.`);
  }
};

const checkUpdateInput = (input: UpdateInput): void => {
  oneLine('title', input.title);
  oneLine('reason', input.reason);
  oneLine('assignee', input.assignee ?? undefined);
  oneLine('project', input.project ?? undefined);
  checkLabels(input.labels);
  checkLabels(input.removeLabels);
};

const checkLabels = (labels: string[] | undefined): void => {
  (labels ?? []).forEach((label) => {
    oneLine(`label ${JSON.stringify(label)}`, label);

    // The front matter holds labels as one `[a, b]` list.
    if (/[,\]]/.test(label)) {
      throw new Error(`label ${JSON.stringify(label)} can't hold "," or "]".`);
    }
  });
};
