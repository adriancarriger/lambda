/**
 * The pure rules of planning's design loop (the `design-screen` instructions)
 * and the build's visual check, which imports them as they are.
 *
 * Severities and the stopping rule are defined in plain words in
 * `instructions/design/visual-severity.md`; this file is the code that applies
 * them.
 */

/** Exact lowercase strings; anything else ("High" included) is unknown. */
export type DesignSeverity = 'high' | 'medium' | 'medium-low' | 'low';

export type DesignIssue = {
  severity: DesignSeverity;
  where: string;
  what: string;
};

export type DesignStopReason = 'only-low' | 'round-4-medium-low' | 'round-7';

export interface DesignStopDecision {
  stop: boolean;
  /** `null` exactly when `stop` is false. */
  reason: DesignStopReason | null;
}

/** A screen's prototype (or a ticket's set of pictures) gets at most this many rounds. */
export const MAX_DESIGN_ROUNDS = 7;

/** Screen, situation and click-target slugs: safe in a path and a selector. */
export const DESIGN_SLUG = /^[a-z0-9-]+$/;

// Worst first is the highest rank.
export const RANK: Record<DesignSeverity, number> = {
  low: 0,
  'medium-low': 1,
  medium: 2,
  high: 3,
};

const isSeverity = (value: unknown): value is DesignSeverity =>
  typeof value === 'string' && Object.keys(RANK).includes(value);

const assertRound = (round: number): void => {
  if (!Number.isInteger(round) || round < 1 || round > MAX_DESIGN_ROUNDS) {
    throw new Error(
      `Design round must be an integer from 1 to ${MAX_DESIGN_ROUNDS}, not ${round}.`
    );
  }
};

/**
 * The stopping rule. Checked in this order, first match wins:
 *   1. no issue worse than low (an empty list included) → `only-low`;
 *   2. round ≥ 4 and the worst issue is medium-low     → `round-4-medium-low`;
 *   3. round 7                                         → `round-7`.
 * Otherwise continue. Throws on a round outside 1–7 or an unknown severity.
 */
export const shouldStopDesignLoop = (
  round: number,
  issues: readonly DesignIssue[]
): DesignStopDecision => {
  assertRound(round);

  const worst = issues.reduce((max, { severity }) => {
    if (!isSeverity(severity)) {
      throw new Error(
        `Unknown design severity ${JSON.stringify(
          severity
        )} (expected high, medium, medium-low or low).`
      );
    }

    return Math.max(max, RANK[severity]);
  }, RANK.low);

  if (worst === RANK.low) {
    return { stop: true, reason: 'only-low' };
  }

  if (round >= 4 && worst === RANK['medium-low']) {
    return { stop: true, reason: 'round-4-medium-low' };
  }

  if (round === MAX_DESIGN_ROUNDS) {
    return { stop: true, reason: 'round-7' };
  }

  return { stop: false, reason: null };
};

/** The first balanced `{…}` in `text`, braces inside JSON strings ignored. */
const firstJsonObject = (text: string): string => {
  const start = text.indexOf('{');

  if (start === -1) {
    throw new Error('The judge returned no JSON object.');
  }

  const scan = { depth: 0, inString: false, escaped: false };
  const end = Array.from(text.slice(start)).findIndex((char) => {
    if (scan.inString) {
      if (scan.escaped) {
        scan.escaped = false;
      } else if (char === '\\') {
        scan.escaped = true;
      } else if (char === '"') {
        scan.inString = false;
      }

      return false;
    }

    if (char === '"') {
      scan.inString = true;
    } else if (char === '{') {
      scan.depth += 1;
    } else if (char === '}') {
      scan.depth -= 1;
    }

    return scan.depth === 0;
  });

  if (end === -1) {
    throw new Error("The judge's JSON object is never closed.");
  }

  // `Array.from` splits by code point; slice the same way.
  return Array.from(text.slice(start))
    .slice(0, end + 1)
    .join('');
};

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

/**
 * A judge's reply → its issues. Takes the first JSON object in the text (a
 * ```json fence or prose around it is fine) and throws unless it is
 * `{issues: [{severity, where, what}]}` with a known severity and non-empty
 * `where` and `what`.
 */
export const parseJudgeVerdict = (text: string): DesignIssue[] => {
  const parsed: unknown = JSON.parse(firstJsonObject(text));

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('issues' in parsed) ||
    !Array.isArray(parsed.issues)
  ) {
    throw new Error('The judge\'s JSON must be {"issues": [ … ]}.');
  }

  return parsed.issues.map((item: unknown, index: number): DesignIssue => {
    const label = `Issue ${index + 1}`;

    if (typeof item !== 'object' || item === null) {
      throw new Error(`${label} is not an object.`);
    }

    const severity = 'severity' in item ? item.severity : undefined;
    const where = 'where' in item ? item.where : undefined;
    const what = 'what' in item ? item.what : undefined;

    if (!isSeverity(severity)) {
      throw new Error(
        `${label} has unknown severity ${JSON.stringify(
          severity
        )} (expected high, medium, medium-low or low).`
      );
    }

    if (!nonEmptyString(where)) {
      throw new Error(`${label} needs a non-empty "where".`);
    }

    if (!nonEmptyString(what)) {
      throw new Error(`${label} needs a non-empty "what".`);
    }

    return { severity, where, what };
  });
};

export type WalkAction =
  | { kind: 'click'; target: string }
  | { kind: 'state'; slug: string };

export interface WalkStep {
  n: number;
  step: string;
  action: WalkAction;
}

export interface WalkPath {
  steps: WalkStep[];
  /** Every situation slug, in brief order; the first is the opening state. */
  states: string[];
}

const ACTION = /^(click|state) (\S+)$/;

/** A brief's situation slugs, in order. Throws on none or a bad slug. */
export const briefSituations = (
  brief: unknown
): { slug: string; title: string }[] => {
  if (
    typeof brief !== 'object' ||
    brief === null ||
    !('situations' in brief) ||
    !Array.isArray(brief.situations) ||
    brief.situations.length === 0
  ) {
    throw new Error('brief.json needs a non-empty "situations" list.');
  }

  return brief.situations.map((situation: unknown, index: number) => {
    const slug =
      typeof situation === 'object' && situation !== null && 'slug' in situation
        ? situation.slug
        : undefined;
    const title =
      typeof situation === 'object' &&
      situation !== null &&
      'title' in situation
        ? situation.title
        : undefined;

    if (typeof slug !== 'string' || !DESIGN_SLUG.test(slug)) {
      throw new Error(
        `Situation ${index + 1} has slug ${JSON.stringify(
          slug
        )}: it must match ${DESIGN_SLUG}.`
      );
    }

    return { slug, title: nonEmptyString(title) ? title : slug };
  });
};

/**
 * A brief's walk path. `brief.path` is `[{step, action}]`, `action` exactly
 * `click <target>` or `state <slug>`; targets and slugs match DESIGN_SLUG and
 * a state must be one of the brief's situations. Throws naming the step.
 */
export const parseWalkPath = (brief: unknown): WalkPath => {
  const states = briefSituations(brief).map(({ slug }) => slug);

  if (
    typeof brief !== 'object' ||
    brief === null ||
    !('path' in brief) ||
    !Array.isArray(brief.path)
  ) {
    throw new Error('brief.json needs a "path" list (it may be empty).');
  }

  const steps = brief.path.map((entry: unknown, index: number): WalkStep => {
    const n = index + 1;
    const step =
      typeof entry === 'object' && entry !== null && 'step' in entry
        ? entry.step
        : undefined;
    const action =
      typeof entry === 'object' && entry !== null && 'action' in entry
        ? entry.action
        : undefined;

    if (!nonEmptyString(step)) {
      throw new Error(`Step ${n} needs a non-empty "step" name.`);
    }

    const match = typeof action === 'string' ? ACTION.exec(action) : null;
    const [, kind, value] = match ?? [];

    if (value === undefined || !DESIGN_SLUG.test(value)) {
      throw new Error(
        `Step ${n} (${step}) has action ${JSON.stringify(
          action
        )}: it must be exactly "click <target>" or "state <slug>", the name matching ${DESIGN_SLUG}.`
      );
    }

    if (kind === 'click') {
      return { n, step, action: { kind: 'click', target: value } };
    }

    if (!states.includes(value)) {
      throw new Error(
        `Step ${n} (${step}) switches to state ${value}, which is not one of the brief's situations (${states.join(
          ', '
        )}).`
      );
    }

    return { n, step, action: { kind: 'state', slug: value } };
  });

  return { steps, states };
};
