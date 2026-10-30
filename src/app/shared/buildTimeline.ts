import type { TimelineEvent } from './building';

/**
 * The building pod's Workflow rail, from the project's stored events: each
 * step of a ticket with its time (retries summed, "Test · attempt 2"), Ship
 * opened into the stages the project reported, This ticket against Typical
 * ticket, and the Whole run's share per step. Pure: events in, numbers out.
 * Time only, never cost.
 */

const STEP_NAMES: Record<string, string> = {
  'pick-up': 'Pick up',
  build: 'Build',
  'self-review': 'Self-review',
  'check-ticket': 'Check ticket',
  'visual-check': 'Visual check',
  'design-check': 'Design check',
  test: 'Test',
  ship: 'Ship',
};

/** A step's short name ("Test"); an added step's id, spaced and capitalised. */
export const stepDisplayName = (id: string): string => {
  const known = STEP_NAMES[id];

  if (known !== undefined) {
    return known;
  }

  const spaced = id.replace(/[-_]+/g, ' ').trim();

  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
};

/** "4m", "1h 52m". */
export const formatMinutes = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const rest = minutes % 60;

  return `${Math.floor(minutes / 60)}h${rest === 0 ? '' : ` ${rest}m`}`;
};

interface Span {
  name: string;
  ticket: string | null;
  attempt: number | null;
  from: number;
  to: number | null;
}

/** Each stage.start with the first stage.end of the same name, ticket and attempt after it. */
const spansOf = (events: TimelineEvent[]): Span[] => {
  const ordered = [...events].sort((a, b) => a.at - b.at);
  const open = new Map<string, Span[]>();
  const spans: Span[] = [];
  const key = (event: TimelineEvent) =>
    [event.name ?? '', event.ticket ?? '', event.attempt ?? ''].join('\u0000');

  ordered.forEach((event) => {
    if (event.type === 'stage.start') {
      const span: Span = {
        name: event.name ?? '',
        ticket: event.ticket,
        attempt: event.attempt,
        from: event.at,
        to: null,
      };
      spans.splice(spans.length, 0, span);
      open.set(key(event), [...(open.get(key(event)) ?? []), span]);

      return;
    }

    if (event.type !== 'stage.end') {
      return;
    }

    const waiting = open.get(key(event)) ?? [];
    const match = waiting.at(-1);

    if (match !== undefined) {
      match.to = event.at;
      open.set(key(event), waiting.slice(0, -1));
    }
  });

  return spans;
};

/**
 * Each `ship.start` … `ship.end` of a ticket. A run that never reported its
 * end (it died) is over once the ticket moved on: at its next `ship.start`,
 * when the Ship step ended, or when the Ship step or Pick up started again.
 * Only a run with none of those after it is still going.
 */
const shipWindows = (
  events: TimelineEvent[]
): { ticket: string | null; from: number; to: number }[] => {
  const ordered = [...events].sort((a, b) => a.at - b.at);
  const endsRun = (event: TimelineEvent, start: TimelineEvent): boolean =>
    event.type === 'ship.end' ||
    event.type === 'ship.start' ||
    (event.type === 'stage.end' && event.name === 'ship') ||
    // The Ship step's own start can share the run's millisecond.
    (event.type === 'stage.start' &&
      event.at > start.at &&
      (event.name === 'ship' || event.name === 'pick-up'));

  return ordered.flatMap((start, index) =>
    start.type === 'ship.start'
      ? [
          {
            ticket: start.ticket,
            from: start.at,
            to:
              ordered
                .slice(index + 1)
                .find(
                  (event) =>
                    event.ticket === start.ticket &&
                    event.at >= start.at &&
                    endsRun(event, start)
                )?.at ?? Number.POSITIVE_INFINITY,
          },
        ]
      : []
  );
};

/**
 * A ticket's step spans: a stage that starts inside a `lambda ship` run (its
 * `test` and `commit` parts, a project's own) is a part of that ship, never
 * the step of the same name. The Ship step's own `ship` span is the step.
 */
const stepSpansOf = (events: TimelineEvent[]): Span[] => {
  const windows = shipWindows(events);

  return spansOf(events).filter(
    (span) =>
      span.name === 'ship' ||
      !windows.some(
        (window) =>
          window.ticket === span.ticket &&
          span.from >= window.from &&
          span.from <= window.to
      )
  );
};

export type StepStatus = 'done' | 'active' | 'todo' | 'skipped';

export interface StepTime {
  id: string;
  /**
   * "Test", or "Test · attempt 2" once retried; "Visual check · skipped: no
   * design" for a step skipped rather than run.
   */
  label: string;
  /** Every attempt's time summed; an open attempt counts up to `now`. */
  ms: number;
  attempt: number;
  status: StepStatus;
}

export interface TicketTimeline {
  ticket: string;
  steps: StepTime[];
  /** "Attempt 2", then each ship stage and Fixing, in the order first reported. */
  shipStages: string[];
  /** Pick-up start to ship done; null until it has shipped. */
  totalMs: number | null;
}

/**
 * The latest `lambda ship` run's parts: a failed ship is run again, and the
 * rail shows the run that's going (or last went), not the first one.
 */
const shipStagesOf = (events: TimelineEvent[]): string[] => {
  const ordered = [...events].sort((a, b) => a.at - b.at);
  const window = shipWindows(ordered).at(-1);

  if (window === undefined) {
    return [];
  }

  const within = ordered.filter(
    (event) => event.at >= window.from && event.at <= window.to
  );
  // Every stage reported inside the ship run is one of its parts, a
  // `test` included; only the Ship step's own `ship` isn't.
  const stages = spansOf(within).filter(
    (span) => span.name !== '' && span.name !== 'ship'
  );
  const firstSeen = new Map<string, { at: number; ms: number }>();
  stages.forEach((span) => {
    const seen = firstSeen.get(span.name);
    const ms = span.to === null ? 0 : span.to - span.from;
    firstSeen.set(span.name, {
      at: seen?.at ?? span.from,
      ms: (seen?.ms ?? 0) + ms,
    });
  });
  const attemptStarts = within.filter(
    (event) => event.type === 'attempt.start'
  );
  const attemptEnds = within.filter((event) => event.type === 'attempt.end');
  const fixing = attemptEnds
    .filter((event) => event.result === 'fail')
    .flatMap((failed) => {
      const next = attemptStarts.find((started) => started.at >= failed.at);

      return next === undefined
        ? []
        : [{ at: failed.at, ms: next.at - failed.at }];
    });
  const parts = [
    ...[...firstSeen.entries()].map(([name, seen]) => ({
      at: seen.at,
      text: `${stepDisplayName(name)} ${formatMinutes(seen.ms)}`,
    })),
    ...(fixing.length === 0
      ? []
      : [
          {
            at: fixing[0]?.at ?? 0,
            text: `Fixing ${formatMinutes(
              fixing.reduce((sum, one) => sum + one.ms, 0)
            )}`,
          },
        ]),
  ].sort((a, b) => a.at - b.at);
  const attempts = Math.max(
    0,
    ...[...attemptStarts, ...attemptEnds].map((event) => event.attempt ?? 0)
  );

  return [
    ...(attempts === 0 ? [] : [`Attempt ${attempts}`]),
    ...parts.map((part) => part.text),
  ];
};

/** Pick-up start to ship done, from one ticket's own events; null until shipped. */
const ticketSpan = (
  own: TimelineEvent[]
): { from: number; to: number } | null => {
  const spans = spansOf(own);
  const end = spans
    .filter((span) => span.name === 'ship' && span.to !== null)
    .at(-1)?.to;

  if (end === undefined || end === null) {
    return null;
  }

  // The pick-up that led to the ship: a ticket blocked on day 1 and taken
  // again on day 3 took the time since day 3, not since day 1.
  const pickUp = spans
    .filter((span) => span.name === 'pick-up' && span.from <= end)
    .at(-1);

  return pickUp === undefined ? null : { from: pickUp.from, to: end };
};

/** A ticket's run, as the pod's building state keeps it. */
export interface RunWindow {
  startedAt: string;
  shippedAt?: string;
  blocked?: { at: string };
}

/**
 * Which events count: only `pod`'s (an event naming no pod is the
 * project's, and counts), and with `run`, only that run's, from its start.
 */
export interface TimelineScope {
  pod?: string;
  run?: RunWindow;
}

const isPods =
  (pod: string | undefined) =>
  (event: TimelineEvent): boolean =>
    pod === undefined || event.pod === null || event.pod === pod;

/** When a run stopped (shipped or blocked); null while it's going. */
const runEnd = (run: RunWindow | undefined): number | null => {
  const end = run?.shippedAt ?? run?.blocked?.at;

  return end === undefined ? null : Date.parse(end);
};

/**
 * Each step span with its time. One that never reported its end is over
 * when the ticket's next step started, or when its run stopped; only the
 * last one of a run that's still going counts up to `now`.
 */
const timedSpansOf = (
  events: TimelineEvent[],
  until: number | null,
  now: number
): (Span & { ms: number })[] => {
  const spans = stepSpansOf(events);

  return spans.map((span) => {
    if (span.to !== null) {
      return { ...span, ms: span.to - span.from };
    }

    const end = Math.min(
      now,
      until ?? Number.POSITIVE_INFINITY,
      ...spans
        .filter(
          (other) => other.ticket === span.ticket && other.from > span.from
        )
        .map((other) => other.from)
    );

    return { ...span, ms: Math.max(0, end - span.from) };
  });
};

/**
 * One ticket's steps, in the project's order, with their times. A step
 * switched off (`off`) never runs: it's shown only when this ticket reported
 * it skipped ("Visual check · skipped: switched off").
 */
export const ticketTimeline = (
  events: TimelineEvent[],
  ticket: string,
  steps: { id: string; label: string; off?: boolean }[],
  now: number = Date.now(),
  scope: TimelineScope = {}
): TicketTimeline => {
  const from =
    scope.run === undefined
      ? Number.NEGATIVE_INFINITY
      : Date.parse(scope.run.startedAt);
  const own = events.filter(
    (event) =>
      event.ticket === ticket && event.at >= from && isPods(scope.pod)(event)
  );
  const ended = runEnd(scope.run);
  const spans = timedSpansOf(own, ended, now);
  const stepIds = new Set(steps.map((one) => one.id));
  const latest = [...spans]
    .filter((span) => stepIds.has(span.name))
    .sort((a, b) => a.from - b.from)
    .at(-1);

  // A skip opens no span: it's a lone `stage.end` marked skipped.
  const skips = own.filter(
    (event) => event.type === 'stage.end' && event.skipped === true
  );

  const skipped = new Set(skips.map((event) => event.name));
  // A step that ended without a start the agent reported (Ship, when the
  // Engineering manager went straight to `/ship`): done, its time unknown.
  const endedAlone = new Set(
    own
      .filter(
        (event) =>
          event.type === 'stage.end' &&
          event.skipped !== true &&
          event.result !== 'fail'
      )
      .map((event) => event.name)
  );

  return {
    ticket,
    steps: steps
      .filter((one) => one.off !== true || skipped.has(one.id))
      .map((one) => {
        const mine = spans.filter((span) => span.name === one.id);
        const skip = skips.filter((event) => event.name === one.id).at(-1);

        if (mine.length === 0 && skip !== undefined) {
          const why = skip.skipReason ?? '';

          return {
            id: one.id,
            label: `${stepDisplayName(one.id)} · skipped${
              why === '' ? '' : `: ${why}`
            }`,
            ms: 0,
            attempt: 0,
            status: 'skipped',
          };
        }
        const attempt = Math.max(
          1,
          mine.length,
          ...mine.map((span) => span.attempt ?? 1)
        );
        const ms = mine.reduce((sum, span) => sum + span.ms, 0);
        const status: StepStatus =
          mine.length === 0
            ? endedAlone.has(one.id)
              ? 'done'
              : 'todo'
            : ended === null &&
              latest !== undefined &&
              latest.name === one.id &&
              latest.to === null
            ? 'active'
            : 'done';

        return {
          id: one.id,
          label: `${stepDisplayName(one.id)}${
            attempt > 1 ? ` · attempt ${attempt}` : ''
          }`,
          ms,
          attempt,
          status,
        };
      }),
    shipStages: shipStagesOf(own),
    totalMs: (() => {
      const span = ticketSpan(own);

      return span === null ? null : span.to - span.from;
    })(),
  };
};

/**
 * The rail's This ticket: pick-up to ship once shipped (`totalMs`), else
 * from its start up to when it stopped — shipped, blocked, or still going
 * (then now). A blocked ticket's time doesn't keep counting while it waits.
 */
export const thisTicketMs = (
  run: { startedAt: string; shippedAt?: string; blocked?: { at: string } },
  totalMs: number | null,
  now: number
): number => {
  if (totalMs !== null) {
    return totalMs;
  }

  const end = run.shippedAt ?? run.blocked?.at;

  return Math.max(
    0,
    (end === undefined ? now : Date.parse(end)) - Date.parse(run.startedAt)
  );
};

/** Pick-up start to ship done, for every shipped ticket in the events. */
export const shippedTicketDurations = (events: TimelineEvent[]): number[] => {
  // Grouped once: the project's every event is read on each page poll.
  const byTicket = new Map<string, TimelineEvent[]>();
  events.forEach((event) => {
    if (event.ticket !== null) {
      byTicket.set(event.ticket, [
        ...(byTicket.get(event.ticket) ?? []),
        event,
      ]);
    }
  });

  return [...byTicket.values()].flatMap((own) => {
    const span = ticketSpan(own);

    return span === null ? [] : [span.to - span.from];
  });
};

/** The median; the mean of the middle two for an even count; none under 2. */
export const typicalTicketMs = (durations: number[]): number | null => {
  if (durations.length < 2) {
    return null;
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? null;
  }

  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

export interface WholeRun {
  totalMs: number;
  steps: { id: string; label: string; ms: number; percent: number }[];
}

/**
 * Each step's total and share of the time across `tickets` (this pod's).
 * With `runs` (the pod's, in the order taken), each run counts its own
 * events, from its start up to the next run of the same ticket.
 */
export const wholeRun = (
  events: TimelineEvent[],
  tickets: string[],
  steps: { id: string; label: string }[],
  now: number = Date.now(),
  scope: { pod?: string; runs?: (RunWindow & { id: string })[] } = {}
): WholeRun => {
  const taken = new Set(tickets);
  const mine = events.filter(
    (event) =>
      event.ticket !== null &&
      taken.has(event.ticket) &&
      isPods(scope.pod)(event)
  );
  const { runs } = scope;
  const spans =
    runs === undefined
      ? timedSpansOf(mine, null, now)
      : runs.flatMap((run, index) => {
          const from = Date.parse(run.startedAt);
          const nextStart = runs
            .slice(index + 1)
            .find((later) => later.id === run.id)?.startedAt;
          const to =
            nextStart === undefined
              ? Number.POSITIVE_INFINITY
              : Date.parse(nextStart);

          return taken.has(run.id)
            ? timedSpansOf(
                mine.filter(
                  (event) =>
                    event.ticket === run.id && event.at >= from && event.at < to
                ),
                runEnd(run),
                now
              )
            : [];
        });
  const totals = steps.map((one) => ({
    id: one.id,
    label: stepDisplayName(one.id),
    ms: spans
      .filter((span) => span.name === one.id)
      .reduce((sum, span) => sum + span.ms, 0),
  }));
  const totalMs = totals.reduce((sum, one) => sum + one.ms, 0);

  return {
    totalMs,
    steps: totals.map((one) => ({
      ...one,
      percent: totalMs === 0 ? 0 : Math.round((one.ms / totalMs) * 100),
    })),
  };
};
