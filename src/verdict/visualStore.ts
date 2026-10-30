/**
 * The build's visual check (`/visual-check`): a ticket whose description has
 * a `## Design` section is graded, picture by picture, against its design
 * until the stop rule ends the loop.
 *
 * Kept apart from the check-ticket verdict on purpose: that one says the
 * acceptance criteria are met, this one says the screens look like their
 * design, and a later run of either must never overwrite the other. Each
 * round is appended to `<verdicts.dir>/<id>.visual/rounds.json`; the final
 * record, written only when the loop stops, is `<verdicts.dir>/<id>.visual.json`.
 * Like the check-ticket verdict it is a latch: `headSha` is provenance only.
 *
 * Ticket ids are kept exactly as given (Linear, Jira and markdown ids have
 * no fixed prefix or case), in the record's name and its folder alike.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  type DesignIssue,
  type DesignStopDecision,
  parseJudgeVerdict,
} from '../design/loop';
import { SCENARIO_ID } from '../shot/scenario';
import { ensureVerdictsDir, verdictsDir } from './store';

export type VisualResult = 'MATCH' | 'SHIPPED_WITH_MISSES' | 'BLOCKED';

export const VISUAL_RESULTS: readonly VisualResult[] = [
  'MATCH',
  'SHIPPED_WITH_MISSES',
  'BLOCKED',
];

/** One graded picture of a round, as `/visual-check` writes it. */
export interface VisualPicture {
  scenarioId: string;
  /** The `### <screen> — <situation>` heading, without the `### `. */
  situation: string;
  /** Checkout-relative PNG: the design picture the ticket carries. */
  expected: string;
  /** Checkout-relative PNG: this round's `lambda shot`. */
  actual: string;
  issues: DesignIssue[];
}

export interface VisualRoundRecord {
  round: number;
  at: string;
  pictures: VisualPicture[];
  decision: DesignStopDecision;
}

/** An issue left when the loop stopped, with the picture it belongs to. */
export interface VisualIssue extends DesignIssue {
  scenarioId: string;
  situation: string;
  expected: string;
  actual: string;
}

export interface VisualVerdict {
  ticketId: string;
  result: VisualResult;
  /** How many rounds the loop took. */
  rounds: number;
  /** Every issue the last round left, worst first within each picture. */
  issues: VisualIssue[];
  /** Provenance only — never compared at gate time. */
  recordedAt: string;
  /** Provenance only, and absent in a folder that isn't a git repository. */
  headSha?: string;
}

/** Worse than low: what the owner is told about — a comment, or a block. */
export const isMiss = (issue: DesignIssue): boolean => issue.severity !== 'low';

export type VisualVerdictLookup =
  | { state: 'missing' }
  | { state: 'unreadable'; reason: string }
  | { state: 'found'; verdict: VisualVerdict };

const VISUAL_TICKET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A ticket id before it's part of a path: letters, digits, `.`, `_` and `-`,
 * starting with a letter or digit, and never `..`.
 */
export const assertVisualTicketId = (id: string): string => {
  if (!VISUAL_TICKET_ID.test(id) || id.includes('..')) {
    throw new Error(
      `${JSON.stringify(
        id
      )} isn't a ticket id: use letters, digits, ., _ and - (starting with a letter or digit), never "..".`
    );
  }

  return id;
};

export const visualVerdictPath = (
  projectRoot: string,
  ticketId: string
): string =>
  path.join(
    verdictsDir(projectRoot),
    `${assertVisualTicketId(ticketId)}.visual.json`
  );

/** `<verdicts.dir>/<id>.visual/`: the rounds, the photos, the composites. */
export const visualDir = (projectRoot: string, ticketId: string): string =>
  path.join(
    verdictsDir(projectRoot),
    `${assertVisualTicketId(ticketId)}.visual`
  );

export const visualRoundsPath = (
  projectRoot: string,
  ticketId: string
): string => path.join(visualDir(projectRoot, ticketId), 'rounds.json');

/** Through the verdicts folder's one writer, so its `*` .gitignore comes first. */
export const writeVisualVerdict = (
  projectRoot: string,
  verdict: VisualVerdict
): string => {
  ensureVerdictsDir(projectRoot);
  const file = visualVerdictPath(projectRoot, verdict.ticketId);
  fs.writeFileSync(file, `${JSON.stringify(verdict, null, 2)}\n`);

  return file;
};

const requireString = (value: object, field: string, label: string): string => {
  const raw: unknown = field in value ? Reflect.get(value, field) : undefined;

  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`${label} has no ${field}`);
  }

  return raw;
};

/** A checkout-relative path that stays inside the checkout. */
const requireRelativePath = (
  value: object,
  field: string,
  label: string
): string => {
  const file = requireString(value, field, label);

  if (
    path.isAbsolute(file) ||
    path.normalize(file).split(path.sep)[0] === '..'
  ) {
    throw new Error(`${label} has an ${field} outside the checkout: ${file}`);
  }

  return file;
};

const isVisualResult = (value: unknown): value is VisualResult =>
  VISUAL_RESULTS.some((result) => result === value);

/** One recorded issue: the judge's fields (through `parseJudgeVerdict`) plus its picture. */
const parseVisualIssue = (entry: unknown, index: number): VisualIssue => {
  const label = `issue ${index + 1}`;

  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`${label} is not an object`);
  }

  const [issue] = parseJudgeVerdict(JSON.stringify({ issues: [entry] }));

  if (issue === undefined) {
    throw new Error(`${label} is not an issue`);
  }

  const scenarioId = requireString(entry, 'scenarioId', label);

  // The record's fields become paths when it is read back (composites, the
  // pod's copies, attachments), so they're held to the round file's rules.
  if (!SCENARIO_ID.test(scenarioId)) {
    throw new Error(`${label} has a scenarioId that isn't one: ${scenarioId}`);
  }

  return {
    ...issue,
    scenarioId,
    situation: requireString(entry, 'situation', label),
    expected: requireRelativePath(entry, 'expected', label),
    actual: requireRelativePath(entry, 'actual', label),
  };
};

/**
 * Narrow a parsed blob to a visual record, throwing on anything it cannot
 * fully understand — an unreadable record refuses, exactly like a missing one,
 * but names its own cause.
 */
const parseVisualVerdict = (raw: string, ticketId: string): VisualVerdict => {
  const parsed: unknown = JSON.parse(raw);

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('not a JSON object');
  }

  const result = 'result' in parsed ? parsed.result : undefined;

  if (!isVisualResult(result)) {
    throw new Error(
      `result is missing or not one of ${VISUAL_RESULTS.join(', ')}`
    );
  }

  const rounds = 'rounds' in parsed ? parsed.rounds : undefined;

  if (typeof rounds !== 'number' || !Number.isInteger(rounds) || rounds < 1) {
    throw new Error('rounds is missing or not a positive integer');
  }

  const issues = 'issues' in parsed ? parsed.issues : undefined;

  if (!Array.isArray(issues)) {
    throw new Error('issues is missing or not a list');
  }

  const recordedFor = requireString(parsed, 'ticketId', 'the record');

  // A file copied from another ticket's must not open this gate.
  if (recordedFor !== ticketId) {
    throw new Error(`the record is for ${recordedFor}, not ${ticketId}`);
  }

  const headSha =
    'headSha' in parsed && typeof parsed.headSha === 'string'
      ? parsed.headSha
      : undefined;

  return {
    ticketId: recordedFor,
    result,
    rounds,
    issues: issues.map(parseVisualIssue),
    recordedAt: requireString(parsed, 'recordedAt', 'the record'),
    ...(headSha === undefined ? {} : { headSha }),
  };
};

/**
 * Never throws on the file: an unparseable record is `unreadable`, never
 * `missing`. Throws on a ticket id that isn't one (`assertVisualTicketId`).
 */
export const readVisualVerdict = (
  projectRoot: string,
  ticketId: string
): VisualVerdictLookup => {
  const file = visualVerdictPath(projectRoot, ticketId);

  if (!fs.existsSync(file)) {
    return { state: 'missing' };
  }

  try {
    return {
      state: 'found',
      verdict: parseVisualVerdict(fs.readFileSync(file, 'utf8'), ticketId),
    };
  } catch (error) {
    return {
      state: 'unreadable',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};
