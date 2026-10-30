import type { Lambda, LambdaPhase, LambdaTicket } from './lambdas';

/**
 * A Lambda's page past planning: the same page in every phase, its phase
 * strip, the ticket it's about, the lines between its parts and the main
 * action of its player bar. Pure: the client bundles it.
 */

export type StripStep = 'planning' | 'ready' | 'building' | 'qa' | 'merged';

export interface StripItem {
  id: StripStep;
  label: string;
  state: 'done' | 'current' | 'todo';
}

const STRIP_ORDER: StripStep[] = [
  'planning',
  'ready',
  'building',
  'qa',
  'merged',
];

const STRIP_NAMES: Record<StripStep, string> = {
  planning: 'Planning',
  ready: 'Ready',
  building: 'Building',
  qa: 'QA',
  merged: 'Merged',
};

/** The phase strip's place for a Lambda's phase (Done reads as Planning). */
export const stripStepOf = (phase: LambdaPhase): StripStep => {
  switch (phase) {
    case 'queued':
      return 'ready';
    case 'building':
      return 'building';
    case 'qa':
      return 'qa';
    case 'shipped':
      return 'merged';
    default:
      return 'planning';
  }
};

/**
 * Planning → Ready → Building → QA → Merged. QA shows only when the
 * project's review step is on (or the Lambda is in it).
 */
export const phaseStrip = (at: StripStep, qaOn: boolean): StripItem[] => {
  const shown = STRIP_ORDER.filter(
    (one) => one !== 'qa' || qaOn || at === 'qa'
  );
  const here = shown.indexOf(at);

  return shown.map((id, index) => ({
    id,
    label: STRIP_NAMES[id],
    state: index < here ? 'done' : index === here ? 'current' : 'todo',
  }));
};

/**
 * The ticket the page is about: the one waiting on the owner (a build
 * blocker first, then a review), then the one building, the next queued,
 * and last the newest shipped.
 */
export const focusTicket = (lambda: Lambda): LambdaTicket | null => {
  const tagged = (tag: 'blocked' | 'review'): LambdaTicket | undefined =>
    lambda.tickets.find((ticket) =>
      lambda.needsYou.some(
        (entry) => entry.tag === tag && entry.ticketId === ticket.id
      )
    );
  const where = (kind: LambdaTicket['where']['kind']) =>
    lambda.tickets.filter((ticket) => ticket.where.kind === kind);
  const queued = where('queued').sort((a, b) =>
    a.where.kind === 'queued' && b.where.kind === 'queued'
      ? a.where.place - b.where.place
      : 0
  );
  const shipped = where('shipped').sort((a, b) =>
    a.where.kind === 'shipped' && b.where.kind === 'shipped'
      ? b.where.at.localeCompare(a.where.at)
      : 0
  );

  return (
    tagged('blocked') ??
    tagged('review') ??
    where('blocked')[0] ??
    where('building')[0] ??
    queued[0] ??
    where('waiting')[0] ??
    shipped[0] ??
    null
  );
};

/** 1 → "1st", 2 → "2nd", 3 → "3rd", 11 → "11th". */
export const ordinal = (n: number): string => {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen
    ? 'th'
    : n % 10 === 1
    ? 'st'
    : n % 10 === 2
    ? 'nd'
    : n % 10 === 3
    ? 'rd'
    : 'th';

  return `${n}${suffix}`;
};

/** "about 40 min", "about 2 h". */
const roughly = (ms: number): string => {
  const total = Math.max(1, Math.round(ms / 60_000));

  return total < 90
    ? `about ${total} min`
    : `about ${Math.round(total / 60)} h`;
};

/** Ready's headline: "3rd in line" and "on Leslie's Mac · starts in about 40 min". */
export const queuePlace = (
  ticket: LambdaTicket,
  typicalMs: number | null
): { headline: string; detail: string } | null => {
  const { where } = ticket;

  if (where.kind === 'waiting') {
    return {
      headline: 'Waiting for a computer',
      detail: 'No computer has it in its queue yet',
    };
  }

  if (where.kind !== 'queued') {
    return null;
  }

  const ahead = where.place - 1;

  return {
    headline:
      where.place === 1 ? 'Next in line' : `${ordinal(where.place)} in line`,
    detail:
      typicalMs === null || ahead === 0
        ? `on ${where.computer}`
        : `on ${where.computer} · starts in ${roughly(typicalMs * ahead)}`,
  };
};

/** "Planning", "Planning and Ready", "Planning, Ready and Building". */
const listed = (names: string[]): string =>
  names.length <= 1
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;

/**
 * The collapsed line at the top of the thread: every phase before this one
 * folded into one line, "Planning, Ready and Building · 44 messages".
 */
export const foldedLine = (
  at: StripStep,
  messages: number,
  checkpoints: number
): string => {
  const counted = `${messages} ${messages === 1 ? 'message' : 'messages'}`;

  if (at === 'ready' && checkpoints > 0) {
    return `Planning · ${checkpoints} ${
      checkpoints === 1 ? 'checkpoint' : 'checkpoints'
    }, ${counted}`;
  }

  // QA folds only once it's behind: Merged folds the build, never QA.
  const before = STRIP_ORDER.slice(
    0,
    Math.max(1, STRIP_ORDER.indexOf(at))
  ).filter((one) => one !== 'qa');

  return `${listed(before.map((one) => STRIP_NAMES[one]))} · ${counted}`;
};

/** "18m ago", "2h ago", "3d ago". */
export const ago = (iso: string, now: number): string => {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  return minutes < 48 * 60
    ? `${Math.floor(minutes / 60)}h ago`
    : `${Math.floor(minutes / (24 * 60))}d ago`;
};

/** The divider where this phase starts. */
export const phaseDivider = (
  lambda: Lambda,
  ticket: LambdaTicket | null,
  now: number,
  facts: { commit?: string | null; builtMs?: number | null }
): string => {
  const where = ticket?.where;

  switch (lambda.phase) {
    case 'queued':
      return where?.kind === 'queued'
        ? `Approved · in ${where.computer}'s queue`
        : 'Approved · moved to Ready';
    case 'building':
      return where?.kind === 'building'
        ? `${where.computer} picked it up · ${ago(where.startedAt, now)}`
        : where?.kind === 'blocked'
        ? `Blocked on ${where.computer} · waiting for you`
        : 'Building';
    case 'qa':
      return facts.builtMs === null || facts.builtMs === undefined
        ? 'Built · waiting for your review'
        : `Built in ${Math.max(
            1,
            Math.round(facts.builtMs / 60_000)
          )}m · waiting for your review`;
    case 'shipped':
      return [
        'Merged',
        ...(facts.commit === null || facts.commit === undefined
          ? []
          : [facts.commit.slice(0, 7)]),
        ...(lambda.shippedAt === null ? [] : [ago(lambda.shippedAt, now)]),
      ].join(' · ');
    default:
      return '';
  }
};

/** The player bar's main action in each phase (null: none). */
export const mainAction = (
  lambda: Lambda
):
  | 'Plan more'
  | 'Answer, and carry on'
  | 'Approve and merge'
  | "Plan what's next"
  | null => {
  if (lambda.needsYou.some((entry) => entry.tag === 'blocked')) {
    return 'Answer, and carry on';
  }

  switch (lambda.phase) {
    case 'queued':
      return 'Plan more';
    case 'qa':
      return 'Approve and merge';
    case 'shipped':
      return "Plan what's next";
    default:
      return null;
  }
};

/** An epic part shipped: "Parks site launch is 2 of 5 shipped". */
export const epicProgress = (
  lambda: Lambda
): { line: string; rest: string } | null => {
  if (lambda.tickets.length < 2) {
    return null;
  }

  const shipped = lambda.tickets.filter(
    (ticket) => ticket.where.kind === 'shipped'
  ).length;

  if (shipped === 0) {
    return null;
  }

  const left = lambda.tickets.length - shipped;

  return {
    line: `${lambda.title} is ${shipped} of ${lambda.tickets.length} shipped`,
    rest:
      left === 0
        ? 'Every part of it is in.'
        : `${left} more ${
            left === 1 ? 'is' : 'are'
          } on the way. When the last one ships you'll get one card for the whole epic, with Plan what's next.`,
  };
};

/** "1 file", "3 files", with the lines: "+12 −3". */
export const filesLine = (
  files: Array<{ added: number; removed: number }>
): string => `${files.length} ${files.length === 1 ? 'file' : 'files'}`;

/**
 * A Blocked item's options as choices: "1) Parks only, for now 2) Both"
 * → two, with the recommended one (the one its recommendation names) picked.
 * Fewer than two: none, and the card asks in words.
 */
export const blockerChoices = (
  options: string,
  recommendation: string
): { choices: string[]; recommended: number } => {
  const choices = options
    .split(/(?:^|\s)\d+[).]\s+/)
    .map((one) => one.trim().replace(/[;,]$/, ''))
    .filter((one) => one !== '');

  if (choices.length < 2) {
    return { choices: [], recommended: -1 };
  }

  const said = recommendation.toLowerCase();
  const recommended = choices.findIndex((choice) =>
    said.includes(choice.toLowerCase().replace(/[.]$/, ''))
  );

  return { choices, recommended };
};
