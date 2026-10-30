/**
 * One ticket interface over every tracker a project can use: plain files in
 * the project (`TASKS.md` + `tickets/<id>.md`), Linear or Jira. Pods and the
 * build loop only ever talk to a `TicketSource`, so they never know which
 * tracker a project uses. Every source passes the same contract suite
 * (`__tests__/contract.test.ts`).
 */
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

import {
  TICKET_STATES,
  type TicketState,
  type TicketsConfig,
} from '../config/projectConfig';

export { TICKET_STATES, type TicketState };

/**
 * How much a ticket matters, Linear's five levels. Organizing only: queue
 * order alone decides what's built next.
 */
export const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const;

export type Priority = (typeof PRIORITIES)[number];

/**
 * A computer's or person's name, compared the way people write it: case
 * aside, and a curly apostrophe the same as a straight one (macOS names a
 * computer "Leslie’s Mac", lambda.json is typed "Leslie's Mac").
 */
export const sameName = (
  a: string | null | undefined,
  b: string | null | undefined
): boolean => {
  const plain = (name: string): string =>
    name
      .trim()
      .toLowerCase()
      .replace(/[\u2018\u2019\u02bc]/g, "'");

  return (
    a !== null &&
    a !== undefined &&
    b !== null &&
    b !== undefined &&
    plain(a) === plain(b)
  );
};

export const isPriority = (value: string): value is Priority =>
  PRIORITIES.some((priority) => priority === value);

/** `--priority` from the command line: one of the five, or refused. */
export const parsePriority = (value: string): Priority => {
  if (!isPriority(value)) {
    throw new Error(
      `"${value}" isn't a priority. Use one of: ${PRIORITIES.join(', ')}.`
    );
  }

  return value;
};

export interface Reporter {
  name: string;
  email?: string;
}

/** The one ticket shape every method returns or works on. */
export interface Ticket {
  id: string;
  title: string;
  /** One of Lambda's states, whatever the tracker calls it. */
  status: TicketState;
  labels: string[];
  parent: string | null;
  /** In queue order. */
  children: string[];
  blockedBy: string[];
  blockReason: string | null;
  reporter: Reporter | null;
  url: string | null;
  priority: Priority;
  /**
   * The computer it's assigned to, by name; null when any computer may take
   * it. Only that computer builds it.
   */
  assignee: string | null;
  /** When it last changed (ISO), where the tracker says; for the list's date. */
  updatedAt?: string | null;
  /**
   * The tracker's own name for its state, when it isn't the one mapped to
   * `status` ("In QA" read as building, "Ideas" as planning): shown beside
   * it, so a state Lambda has no status for isn't hidden. Null or left out
   * when they agree.
   */
  trackerStatus?: string | null;
  /** The tracker's project it's in ("Lot 48"), by name; null: none. */
  project?: string | null;
}

/**
 * A view saved in the tracker, translated into Lambda's filters: chips on
 * one field are any-of, different fields all apply. What can't be said that
 * way (Linear's cycles) is left out and named in `dropped`.
 */
export interface TrackerView {
  /** The tracker's own id: importing again updates the same view. */
  trackerId: string;
  name: string;
  description: string;
  icon: string | null;
  /** Shared with the whole team in the tracker; else its owner's. */
  shared: boolean;
  chips: Array<{
    field: 'status' | 'priority' | 'assignee' | 'project' | 'label';
    value: string;
  }>;
  dropped: string[];
}

/** One of the tracker's favorites, for the sidebar's Favorites. */
export interface TrackerFavorite {
  kind: 'view' | 'project' | 'ticket';
  /** The view's tracker id, the project's name or the ticket's id. */
  ref: string;
  position: number;
}

/** One of the tracker's projects, for the Projects page and the picker. */
export interface TrackerProject {
  id: string;
  name: string;
  /** An emoji (`:bee:` or the character) or the tracker's icon name. */
  icon: string | null;
  color: string | null;
  /** Its status as the tracker names it ("In Progress"), and its kind. */
  status: { name: string; type: string } | null;
  /** 0 to 1. */
  progress: number | null;
  lead: string | null;
  /** ISO date. */
  targetDate: string | null;
  description: string;
  url: string | null;
}

/**
 * The tracker's state name when it says more than Lambda's status: a name
 * other than the one lambda.json maps that status to.
 */
export const trackerStatusOf = (
  name: string | null | undefined,
  status: TicketState,
  statuses: Partial<Record<TicketState, string>> | undefined
): string | null =>
  name === null ||
  name === undefined ||
  sameName(name, statuses?.[status] ?? status)
    ? null
    : name;

export interface TicketWithDescription extends Ticket {
  /** Markdown. */
  description: string;
}

export interface CreateInput {
  title: string;
  parent?: string;
  /** Defaults to `planning`. */
  status?: TicketState;
  /** Markdown. */
  description?: string;
  /** Defaults to `none`. */
  priority?: Priority;
  /** A computer's name; unassigned when left out. */
  assignee?: string | null;
  /** Lambda label keys. */
  labels?: string[];
  /** The tracker's project, by name. */
  project?: string | null;
}

export interface UpdateInput {
  status?: TicketState;
  /** With `status: 'blocked'`: why. */
  reason?: string;
  title?: string;
  /** Markdown: the whole description, replaced. */
  description?: string;
  /** Lambda label keys to add; ones the ticket already has are left as is. */
  labels?: string[];
  /** Lambda label keys to take off; ones it doesn't have are left as is. */
  removeLabels?: string[];
  priority?: Priority;
  /** A computer's name, or null to unassign. */
  assignee?: string | null;
  /**
   * The epic it sits under (moved to the end of its children), or null to
   * make it a top-level ticket (at the end of the queue).
   */
  parent?: string | null;
  /** The tracker's project, by name; null takes it out of one. */
  project?: string | null;
}

export interface ListOptions {
  /** An email (exact, any case) or a name (exact, any case). */
  reporter?: string;
}

export interface AttachOptions {
  /** What the picture shows; kept by the caller for the link it writes. */
  alt?: string;
  /** The attached file's name, when its own isn't unique enough. */
  name?: string;
}

const ATTACHED_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The name a file is attached under: `name`, checked, or its own. */
export const attachedName = (filePath: string, name?: string): string => {
  if (name === undefined) {
    return path.basename(filePath);
  }

  if (!ATTACHED_NAME.test(name)) {
    throw new Error(
      `--name ${name} must be a plain file name (letters, digits, . _ -): nothing attached.`
    );
  }

  return name;
};

/** Where an attached file now lives: a link a description or comment can use. */
export interface Attached {
  ref: string;
}

export interface CommentImage {
  /** A local file. */
  path: string;
  /** The link text; the file's name when not given. */
  alt?: string;
}

export interface CommentOptions {
  /**
   * Attached first, in order; then the comment is posted once. In the text,
   * `{{image:<i>}}` (0-based, so `{{image:0}}` is the first) becomes that
   * image's link; an image with no token is added at the end.
   */
  images?: CommentImage[];
}

export interface TicketSource {
  readonly kind: TicketsConfig['source'];
  /** tickets.readOnly: every write is refused. */
  readonly readOnly?: boolean;
  /** Every ticket in queue order: each top-level ticket, then its children. */
  list(options?: ListOptions): Promise<Ticket[]>;
  get(id: string): Promise<TicketWithDescription>;
  /** Writes `.lambda/pulled/<id>/` (markdown: the ticket file); its path. */
  pull(id: string): Promise<string>;
  /** Sends a pulled ticket's edits back; what happened, in one line. */
  push(id: string): Promise<string>;
  create(input: CreateInput): Promise<Ticket>;
  update(id: string, input: UpdateInput): Promise<Ticket>;
  /**
   * Adds a file to the ticket; its ref is a link to it (markdown: the
   * relative `./<id>/<name>`). A missing file is refused, nothing attached.
   */
  attach(
    id: string,
    filePath: string,
    options?: AttachOptions
  ): Promise<Attached>;
  /** Any attach failure fails the comment, and nothing is posted. */
  comment(id: string, text: string, options?: CommentOptions): Promise<void>;
  /**
   * The ticket's comments' text, oldest first (markdown: each entry under the
   * ticket file's `## Comments`). For finding a comment Lambda already
   * posted; a tracker that keeps more than one page answers its first page.
   */
  comments(id: string): Promise<string[]>;
  delete(id: string, reason: string): Promise<void>;
  /** `id` can't start until `by` is done. */
  block(id: string, by: string): Promise<void>;
  unblock(id: string, by: string): Promise<void>;
  /** Exactly `parent`'s children, in their new order. */
  reorder(parent: string, order: string[]): Promise<void>;
  /** Moves the block to sit right after `after` in queue order. */
  place(ids: string[], after: string): Promise<void>;
  /** The ticket to build next, or null (see `findNext`). */
  next(options?: ListOptions): Promise<Ticket | null>;
  /**
   * What `next` decides from: every ticket in queue order, and the status of
   * blockers the tracker keeps out of that list (Linear's archived issues,
   * another Jira project's). A building pod's queue reads this, so it hands
   * out exactly what `next` would.
   */
  queue(): Promise<{
    tickets: Ticket[];
    outside: ReadonlyMap<string, TicketState>;
  }>;
  /** The tracker's projects (none where it has no such thing). */
  projects(): Promise<TrackerProject[]>;
  /** Its saved views, translated (only trackers that have them). */
  views?(): Promise<TrackerView[]>;
  /** Its key's user's favorites (only trackers that have them). */
  favorites?(): Promise<TrackerFavorite[]>;
  /**
   * Still Lambda's (tickets.lambdaLabel): labelled, or under an epic that
   * is. Always true without a member label; trackers without one leave it out.
   */
  isMember?(id: string): Promise<boolean>;
}

// ── ids and states ──────────────────────────────────────────────────────────

const TICKET_ID = /^[A-Za-z0-9_-]+$/;

/** A ticket id before it's used in a path or a request. */
export const assertTicketId = (id: string): string => {
  if (!TICKET_ID.test(id)) {
    throw new Error(
      `"${id}" isn't a ticket id: use letters, digits, - and _ only.`
    );
  }

  return id;
};

export const unknownTicketMessage = (id: string): string =>
  `${id} isn't a ticket I can read.`;

export const unknownTicket = (id: string): Error =>
  new Error(unknownTicketMessage(id));

/**
 * Did the tracker say it has no such ticket (deleted, or never there)? That
 * answer is final; anything else (a timeout, a refused key) may pass.
 */
export const isUnknownTicket = (error: unknown, id: string): boolean =>
  error instanceof Error && error.message === unknownTicketMessage(id);

export const isTicketState = (value: string): value is TicketState =>
  TICKET_STATES.some((state) => state === value);

/** `--status` from the command line: one of Lambda's states, or refused. */
export const parseTicketState = (value: string): TicketState => {
  if (!isTicketState(value)) {
    throw new Error(
      `"${value}" isn't a status. Use one of: ${TICKET_STATES.join(', ')}.`
    );
  }

  return value;
};

export const stillHasChildren = (id: string, children: string[]): Error =>
  new Error(`${id} still has children: ${children.join(', ')}.`);

/** `reorder`'s ids must be exactly the parent's children. */
export const checkReorder = (
  parent: string,
  children: string[],
  order: string[]
): void => {
  const missing = children.filter((id) => !order.includes(id));
  const extra = order.filter((id) => !children.includes(id));
  const repeated = order.filter((id, index) => order.indexOf(id) !== index);

  if (missing.length === 0 && extra.length === 0 && repeated.length === 0) {
    return;
  }

  const parts = [
    missing.length > 0 ? `missing ${missing.join(', ')}` : undefined,
    extra.length > 0 ? `not its children: ${extra.join(', ')}` : undefined,
    repeated.length > 0 ? `repeated: ${repeated.join(', ')}` : undefined,
  ].filter((part): part is string => part !== undefined);

  throw new Error(
    `--order must be exactly ${parent}'s children (${children.join(
      ', '
    )}): ${parts.join('; ')}.`
  );
};

/** `place`'s ids: none repeated, and never the ticket they go after. */
export const checkPlace = (ids: string[], after: string): void => {
  if (ids.includes(after)) {
    throw new Error(`Can't place ${after} after itself.`);
  }

  const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);

  if (repeated.length > 0) {
    throw new Error(
      `Can't place a ticket twice: ${Array.from(new Set(repeated)).join(
        ', '
      )} is repeated.`
    );
  }
};

/** Rearranges `items` so `ids` sit, in that order, right after `after`. */
export const placeAfter = (
  items: string[],
  ids: string[],
  after: string
): string[] => {
  checkPlace(ids, after);

  const rest = items.filter((id) => !ids.includes(id));
  const at = rest.indexOf(after);

  if (at === -1) {
    throw unknownTicket(after);
  }

  return [...rest.slice(0, at + 1), ...ids, ...rest.slice(at + 1)];
};

// ── block reasons ───────────────────────────────────────────────────────────

/**
 * Linear and Jira have no field for why a ticket is blocked, so every move
 * into `blocked` posts one comment starting with this, reason or not. Only
 * the latest such comment is the reason, so an old reason never outlives a
 * new block, and a person's own "Blocked: …" comment is never read as one.
 */
export const BLOCK_MARKER = 'Lambda marked this blocked';

/** `Lambda marked this blocked: <reason>`, or `Lambda marked this blocked.` */
export const blockMarkerComment = (reason: string | null): string =>
  reason === null || reason.trim() === ''
    ? `${BLOCK_MARKER}.`
    : `${BLOCK_MARKER}: ${reason.trim()}`;

/** A marker comment's reason (null when it gave none); null when not one. */
export const readBlockMarker = (
  text: string
): { reason: string | null } | null => {
  const trimmed = text.trim();

  if (trimmed === `${BLOCK_MARKER}.`) {
    return { reason: null };
  }

  if (!trimmed.startsWith(`${BLOCK_MARKER}: `)) {
    return null;
  }

  const reason = trimmed.slice(BLOCK_MARKER.length + 2).trim();

  return { reason: reason === '' ? null : reason };
};

// ── files and pictures ──────────────────────────────────────────────────────

/** The file to attach, refused (naming it) unless it's a file that's there. */
export const attachableFile = (filePath: string): string => {
  const resolved = path.resolve(filePath);

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`No file at ${filePath}: nothing attached.`);
  }

  return resolved;
};

export interface LinkedImage {
  alt: string;
  ref: string;
}

export const imageLink = ({ alt, ref }: LinkedImage): string =>
  `![${alt}](${ref})`;

/**
 * Attaches every image in order (each file checked first, so a missing one
 * attaches nothing); the first failure stops the rest.
 */
export const attachImages = async (
  images: CommentImage[],
  attachOne: (file: string, alt: string) => Promise<Attached>
): Promise<LinkedImage[]> => {
  const files = images.map((image) => attachableFile(image.path));

  return images.reduce<Promise<LinkedImage[]>>(async (sofar, image, index) => {
    const done = await sofar;
    const alt = image.alt ?? path.basename(image.path);
    const { ref } = await attachOne(files[index] ?? image.path, alt);

    return [...done, { alt, ref }];
  }, Promise.resolve([]));
};

/**
 * `{{image:<i>}}` (0-based) replaced by the i-th image's link; `rest` holds
 * the images no token named, in order, for the caller to add at the end.
 */
export const placeImages = (
  text: string,
  images: LinkedImage[]
): { text: string; rest: LinkedImage[] } => ({
  text: images.reduce(
    (sofar, image, index) =>
      sofar.split(`{{image:${index}}}`).join(imageLink(image)),
    text
  ),
  rest: images.filter((_image, index) => !text.includes(`{{image:${index}}}`)),
});

/** A comment's text with its images: untokened ones after a blank line each. */
export const withImages = (text: string, images: LinkedImage[]): string => {
  const placed = placeImages(text, images);

  return [placed.text, ...placed.rest.map(imageLink)].join('\n\n');
};

/** The picture types `push` uploads from a pulled folder. */
export const PICTURE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

export const IMAGE_LINK = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

const isRemote = (src: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(src);

const within = (dir: string, target: string): boolean => {
  const away = path.relative(dir, target);

  return (
    away !== '' &&
    away !== '..' &&
    !away.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(away)
  );
};

const decoded = (src: string): string => {
  try {
    return decodeURI(src);
  } catch {
    return src;
  }
};

export interface PulledImages {
  /** In-folder pictures to attach: the link as written → the file. */
  upload: Array<{ src: string; file: string }>;
  /** Local links never uploaded, as written. */
  left: string[];
}

/**
 * Sorts the local picture links of a pulled description. A link to a picture
 * (`PICTURE_EXTENSIONS`) inside `dir`, whose realpath is still inside it, is
 * to be attached; any other local link (outside `dir`, a symlink out of it,
 * another kind of file) is left as written, since a pulled description is
 * text anyone with access to the ticket can write. A linked picture inside
 * `dir` that isn't there refuses the push, naming it. Remote links and the
 * names in `known` (pictures `pull` downloaded) aren't local.
 */
export const pulledImages = (
  id: string,
  dir: string,
  markdown: string,
  known: Record<string, string> = {}
): PulledImages => {
  const realDir = fs.realpathSync(dir);
  const sources = Array.from(
    markdown.matchAll(IMAGE_LINK),
    (match) => match[2] ?? ''
  )
    .filter((src) => !isRemote(src) && !Object.hasOwn(known, src))
    .filter((src, index, all) => all.indexOf(src) === index);
  const sorted = sources.map((src) => {
    const file = path.resolve(dir, decoded(src));
    const picture = PICTURE_EXTENSIONS.includes(
      path.extname(file).toLowerCase()
    );

    if (!picture || !within(dir, file)) {
      return { src, kind: 'left' as const, file };
    }

    if (!fs.existsSync(file)) {
      return { src, kind: 'missing' as const, file };
    }

    const real = fs.realpathSync(file);

    return within(realDir, real) && fs.statSync(real).isFile()
      ? { src, kind: 'upload' as const, file: real }
      : { src, kind: 'left' as const, file };
  });
  const missing = sorted.filter((one) => one.kind === 'missing');

  if (missing.length > 0) {
    throw new Error(
      `Can't push ${id}: ${missing
        .map((one) => one.src)
        .join(', ')} isn't in ${dir}. Put the file there, or remove the link.`
    );
  }

  return {
    upload: sorted
      .filter((one) => one.kind === 'upload')
      .map(({ src, file }) => ({ src, file })),
    left: sorted.filter((one) => one.kind === 'left').map((one) => one.src),
  };
};

/** Every picture link whose target is in `refs` pointed at its ref instead. */
export const rewriteImageLinks = (
  markdown: string,
  refs: Record<string, string>
): string =>
  markdown.replace(IMAGE_LINK, (whole, alt: string, src: string) =>
    Object.hasOwn(refs, src) ? `![${alt}](${refs[src]})` : whole
  );

/** What `push` says about its pictures, after its one line. */
export const pushedImagesNote = (
  attached: string[],
  left: string[]
): string[] => [
  ...(attached.length === 0 ? [] : [`Attached ${attached.join(', ')}.`]),
  ...(left.length === 0
    ? []
    : [
        `Not uploaded, left as written (outside the pulled folder, or not a picture): ${left.join(
          ', '
        )}.`,
      ]),
];

// ── reporters ───────────────────────────────────────────────────────────────

/** `Leslie Knope <leslie@pawnee.gov>` or `Leslie Knope`. */
export const parseReporter = (text: string): Reporter | null => {
  const trimmed = text.trim();

  if (trimmed === '') {
    return null;
  }

  const match = /^(.*?)\s*<([^<>\s]+)>$/.exec(trimmed);

  if (match === null) {
    return { name: trimmed };
  }

  const name = (match[1] ?? '').trim();
  const email = match[2] ?? '';

  return { name: name === '' ? email : name, email };
};

export const formatReporter = (reporter: Reporter): string =>
  reporter.email === undefined
    ? reporter.name
    : `${reporter.name} <${reporter.email}>`;

/**
 * `--reporter`: an email matches the reporter's email exactly, ignoring case;
 * anything else matches the reporter's name exactly, ignoring case.
 */
export const reportedBy = (ticket: Ticket, who: string): boolean => {
  const wanted = who.trim().toLowerCase();

  if (ticket.reporter === null) {
    return false;
  }

  return wanted.includes('@')
    ? ticket.reporter.email?.toLowerCase() === wanted
    : ticket.reporter.name.toLowerCase() === wanted;
};

export const filterByReporter = (
  tickets: Ticket[],
  options: ListOptions = {}
): Ticket[] =>
  options.reporter === undefined
    ? tickets
    : tickets.filter((ticket) => reportedBy(ticket, options.reporter ?? ''));

// ── next ────────────────────────────────────────────────────────────────────

/**
 * The ticket to build next, from every ticket in queue order.
 *
 * The first `ready` top-level ticket that isn't blocked (status `blocked`, or
 * any `blockedBy` ticket not yet `done`; a `blockedBy` id that no longer
 * exists counts as not done). A parent with children returns its first child
 * that isn't done; when that child is blocked or not ready, the whole parent
 * is skipped, so children never run out of order. A parent whose children are
 * all done returns the parent itself. A `building` parent (its children are
 * under way) still hands out its next child, but never itself.
 *
 * `reporter` limits it to that person's tickets (the parent decides).
 * `outside` gives the status of blockers a tracker keeps out of its list
 * (Linear's archived issues), so a finished one doesn't block forever.
 */
export const findNext = (
  tickets: Ticket[],
  options: ListOptions = {},
  outside: ReadonlyMap<string, TicketState> = new Map()
): Ticket | null => {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const blocked = (ticket: Ticket): boolean =>
    ticket.status === 'blocked' ||
    ticket.blockedBy.some(
      (id) => (byId.get(id)?.status ?? outside.get(id)) !== 'done'
    );
  const runnable = (ticket: Ticket): boolean =>
    ticket.status === 'ready' && !blocked(ticket);
  const candidate = (top: Ticket): Ticket | null => {
    const underWay = top.status === 'building' && top.children.length > 0;

    if ((top.status !== 'ready' && !underWay) || blocked(top)) {
      return null;
    }

    const children = top.children
      .map((id) => byId.get(id))
      .filter((child): child is Ticket => child !== undefined);
    const firstOpen = children.find((child) => child.status !== 'done');

    if (firstOpen === undefined) {
      return underWay ? null : top;
    }

    return runnable(firstOpen) ? firstOpen : null;
  };

  const found = filterByReporter(
    tickets.filter((ticket) => ticket.parent === null),
    options
  )
    .map(candidate)
    .find((ticket): ticket is Ticket => ticket !== null);

  return found ?? null;
};

export const NOTHING_READY = 'No ticket is ready.';

// ── credentials ─────────────────────────────────────────────────────────────

type Env = Record<string, string | undefined>;

interface MachineTokens {
  linear?: string;
  jira?: { email: string; apiToken: string };
}

const set = (value: string | undefined): value is string =>
  value !== undefined && value !== '';

/** `LAMBDA_LINEAR_KEY`, else `tokens.linear`; refused when neither. */
export const resolveLinearKey = (
  tokens: MachineTokens | undefined,
  env: Env = process.env
): string => {
  const key = set(env.LAMBDA_LINEAR_KEY)
    ? env.LAMBDA_LINEAR_KEY
    : tokens?.linear;

  if (!set(key)) {
    throw new Error(
      'No Linear key: set tokens.linear in ~/.lambda/config.json or LAMBDA_LINEAR_KEY.'
    );
  }

  return key;
};

/**
 * `LAMBDA_JIRA_EMAIL` + `LAMBDA_JIRA_TOKEN` (both), else `tokens.jira`;
 * refused when neither is complete.
 */
export const resolveJiraCredentials = (
  tokens: MachineTokens | undefined,
  env: Env = process.env
): { email: string; apiToken: string } => {
  if (set(env.LAMBDA_JIRA_EMAIL) && set(env.LAMBDA_JIRA_TOKEN)) {
    return { email: env.LAMBDA_JIRA_EMAIL, apiToken: env.LAMBDA_JIRA_TOKEN };
  }

  const fromFile = tokens?.jira;

  if (fromFile !== undefined && set(fromFile.email) && set(fromFile.apiToken)) {
    return fromFile;
  }

  throw new Error(
    'No Jira key: set tokens.jira (email and apiToken) in ~/.lambda/config.json, or LAMBDA_JIRA_EMAIL + LAMBDA_JIRA_TOKEN.'
  );
};

/** A refused response, without ever echoing the key. */
export const httpError = async (
  service: 'Linear' | 'Jira',
  response: Response,
  id?: string
): Promise<Error> => {
  if (response.status === 401 || response.status === 403) {
    return new Error(`${service} refused the key (${response.status}).`);
  }

  if (response.status === 404 && id !== undefined) {
    return unknownTicket(id);
  }

  const body = await response.text().catch(() => '');

  return new Error(
    `${service} answered ${response.status}: ${serviceMessage(body)}`
  );
};

/** Linear's (GraphQL) error body. */
const GraphqlErrorsSchema = z.object({
  errors: z.array(z.object({ message: z.string() })).min(1),
});

/** Jira's error body. */
const JiraErrorsSchema = z.object({
  errorMessages: z.array(z.string()).default([]),
  errors: z.record(z.string()).default({}),
});

const parseJson = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

/** The service's own error message out of a JSON body, else the text. */
const serviceMessage = (body: string): string => {
  const json = parseJson(body);
  const graphql = GraphqlErrorsSchema.safeParse(json);

  if (graphql.success) {
    return graphql.data.errors.map((error) => error.message).join('; ');
  }

  const jira = JiraErrorsSchema.safeParse(json);
  const messages = jira.success
    ? [
        ...jira.data.errorMessages,
        ...Object.entries(jira.data.errors).map(
          ([field, message]) => `${field}: ${message}`
        ),
      ]
    : [];

  if (messages.length > 0) {
    return messages.join('; ');
  }

  return body.trim().slice(0, 300) || '(no message)';
};
