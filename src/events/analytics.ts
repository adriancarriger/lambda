import type { StoredEvent } from './schema';

/**
 * The Analytics page's numbers, from every stored event of one project.
 * Pure: stored events in, totals out. Warnings are stored rows (a bad line,
 * an unknown type, a stage that never finished), never worked out here.
 */

/** A stage with no end after this long is stored as a warning. */
export const UNFINISHED_AFTER_MS = 24 * 60 * 60 * 1000;

/** The stored warning row for a stage that never finished. */
export const UNFINISHED_TYPE = 'stage.unfinished';

/** What the page says with no events yet. */
export const NOTHING_RECORDED =
  'Nothing recorded yet. Events from lambda event and .lambda/events.jsonl show up here.';

export interface Average {
  name: string;
  averageMs: number;
  count: number;
}

export interface ShipTotal {
  /** The ticket, else the pod. */
  name: string;
  totalMs: number;
  /** Attempts up to and including the first that passed. */
  runsUntilGreen: number;
  /** From each failed attempt's end to the next attempt's start; null with no failures. */
  fixingMs: number | null;
}

export interface Analytics {
  warnings: string[];
  /** Lambda's own workflow steps (`source: "lambda"`). */
  steps: Average[];
  /** A ship's or CI's stages. */
  stages: Average[];
  ships: ShipTotal[];
  /** No events at all yet. */
  empty: boolean;
  /** The line the page shows instead, when there's nothing to show. */
  notice: string | null;
}

const DAY_FORMAT = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

/** "Wed, Oct 14". */
export const dayLabel = (at: number): string => DAY_FORMAT.format(new Date(at));

interface Span {
  name: string;
  source: string | null;
  startedAt: number;
  endedAt: number | null;
  /** The stage.start it began with. */
  start: StoredEvent;
}

const scopeKey = (event: StoredEvent): string =>
  [
    event.pod ?? '',
    event.ticket ?? '',
    event.attempt ?? '',
    event.name ?? '',
  ].join('\u0000');

/** A pod's stage, whatever ticket or attempt: where a bare end looks. */
const stageKey = (event: StoredEvent): string =>
  [event.pod ?? '', event.name ?? ''].join('\u0000');

/** The open stages of one key, newest last; ended ones are dropped lazily. */
type Stack = Span[];

const push = (stacks: Map<string, Stack>, key: string, span: Span): void => {
  const stack = stacks.get(key);

  if (stack === undefined) {
    stacks.set(key, [span]);

    return;
  }

  stack.splice(stack.length, 0, span);
};

const newestOpen = (stack: Stack | undefined): Span | undefined => {
  if (stack === undefined) {
    return undefined;
  }

  while (stack.length > 0) {
    const top = stack[stack.length - 1];

    if (top !== undefined && top.endedAt === null) {
      return top;
    }

    stack.pop();
  }

  return undefined;
};

/**
 * Each stage.end closes the newest open start of the same stage: a stage
 * started again (a retry) ends the retry, and the abandoned start is the one
 * left open. An end naming no ticket or attempt closes its pod's newest open
 * start of that stage, whatever its ticket. One pass over the events.
 */
const stageSpans = (events: StoredEvent[]): Span[] => {
  const exact = new Map<string, Stack>();
  const byStage = new Map<string, Stack>();
  const spans = events
    .filter((event) => event.type === 'stage.start')
    .map(
      (event): Span => ({
        name: event.name ?? '(unnamed)',
        source: event.source,
        startedAt: event.at,
        endedAt: null,
        start: event,
      })
    );
  const spanOf = new Map(spans.map((span) => [span.start, span]));

  events.forEach((event) => {
    const span = spanOf.get(event);

    if (span !== undefined) {
      push(exact, scopeKey(event), span);
      push(byStage, stageKey(event), span);

      return;
    }

    if (event.type !== 'stage.end') {
      return;
    }

    const bare = event.ticket === null && event.attempt === null;
    const match =
      newestOpen(exact.get(scopeKey(event))) ??
      (bare ? newestOpen(byStage.get(stageKey(event))) : undefined);

    if (match !== undefined) {
      match.endedAt = event.at;
    }
  });

  return spans;
};

const averages = (spans: Span[]): Average[] => {
  const byName = new Map<string, { totalMs: number; count: number }>();
  spans.forEach((span) => {
    if (span.endedAt === null) {
      return;
    }

    const ms = span.endedAt - span.startedAt;
    const sum = byName.get(span.name);

    if (sum === undefined) {
      byName.set(span.name, { totalMs: ms, count: 1 });

      return;
    }

    sum.totalMs += ms;
    sum.count += 1;
  });

  return [...byName.entries()].map(([name, { totalMs, count }]) => ({
    name,
    count,
    averageMs: totalMs / count,
  }));
};

const ships = (events: StoredEvent[]): ShipTotal[] => {
  const keys = [
    ...new Set(
      events
        .filter(
          (event) =>
            event.type.startsWith('ship.') || event.type.startsWith('attempt.')
        )
        .map((event) => event.ticket ?? event.pod ?? '')
        .filter((key) => key !== '')
    ),
  ];

  return keys.map((key) => {
    const own = events.filter((event) => (event.ticket ?? event.pod) === key);
    const shipStart = own.find((event) => event.type === 'ship.start');
    const shipEnd = [...own]
      .reverse()
      .find((event) => event.type === 'ship.end');
    const starts = own.filter((event) => event.type === 'attempt.start');
    const ends = own.filter((event) => event.type === 'attempt.end');
    const firstGreen = ends.findIndex((event) => event.result === 'pass');
    // A failure no retry followed yet was never fixed: it adds nothing, so a
    // ship with only that reads "—", not 0.
    const fixing = ends
      .filter((end) => end.result === 'fail')
      .flatMap((end) => {
        const next = starts.find((start) => start.at >= end.at);

        return next === undefined ? [] : [next.at - end.at];
      });
    const from = shipStart?.at ?? starts[0]?.at ?? own[0]?.at ?? 0;
    const to = shipEnd?.at ?? ends.at(-1)?.at ?? from;

    return {
      name: key,
      totalMs: to - from,
      runsUntilGreen: firstGreen === -1 ? ends.length : firstGreen + 1,
      fixingMs:
        fixing.length === 0 ? null : fixing.reduce((sum, ms) => sum + ms, 0),
    };
  });
};

/**
 * The stage.start events with no end yet that have been open longer than
 * 24 hours: each gets a stored warning row (events/store.ts).
 */
export const overdueStages = (
  events: StoredEvent[],
  now: number
): StoredEvent[] =>
  stageSpans(events)
    .filter(
      (span) =>
        span.endedAt === null && now - span.startedAt > UNFINISHED_AFTER_MS
    )
    .map((span) => span.start);

/** "security-review (Wed, Oct 14)": one unfinished stage, as its row keeps it. */
export const unfinishedLabel = (name: string, at: number): string =>
  `${name} (${dayLabel(at)})`;

export const computeAnalytics = (events: StoredEvent[]): Analytics => {
  const spans = stageSpans(events);
  const unfinished = events.filter((event) => event.type === UNFINISHED_TYPE);
  const otherWarnings = events.flatMap((event) =>
    event.warning === null || event.type === UNFINISHED_TYPE
      ? []
      : [event.warning]
  );
  const warnings = [
    ...(unfinished.length === 0
      ? []
      : [
          `${unfinished.length} ${
            unfinished.length === 1 ? 'stage' : 'stages'
          } never finished: ${unfinished
            .map((event) =>
              unfinishedLabel(event.name ?? '(unnamed)', event.at)
            )
            .join(', ')}`,
        ]),
    ...otherWarnings,
  ];
  const empty = events.length === 0;

  return {
    warnings,
    steps: averages(spans.filter((span) => span.source === 'lambda')),
    stages: averages(spans.filter((span) => span.source !== 'lambda')),
    ships: ships(events.filter((event) => event.warning === null)),
    empty,
    notice: empty ? NOTHING_RECORDED : null,
  };
};
