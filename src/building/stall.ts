import { createHash } from 'crypto';

import { stepDisplayName } from '../app/shared/buildTimeline';
import type { BuildTicketRun, BuildingState } from '../pod-store';

/**
 * A stuck building pod. The runner looks at every active building pod once
 * a minute. Any step event for the current ticket starts the count again.
 *
 * What counts as stuck comes from the agents' turns (Claude's own hooks) and
 * the commands they run, not from a timer (Adrian, 2026-10-28):
 *
 * - Nobody working: no agent of the three mid-turn and none running a
 *   command, while the ticket isn't done. A handoff got lost (a report sent
 *   into a paused terminal, say). Three minutes of that get the Engineering
 *   manager a nudge saying so.
 * - Somebody working: a long E2E run is one long turn, and is never a stall.
 *   Only a turn whose panes stay frozen past HUNG_MS gets a nudge.
 *
 * After either nudge, another twenty stuck minutes on the same step and
 * attempt block the ticket the way `lambda pod blocked` does, and the pod
 * moves on. Someone starting work again clears an "idle" nudge.
 *
 * Without the turns (a caller that has none), it is the old pane watch:
 * twenty silent minutes nudge, a second twenty block.
 */

export const STALL_MS = 20 * 60_000;

/** Everyone idle this long, with the ticket not done: a lost handoff. */
export const IDLE_MS = 3 * 60_000;

/** A turn whose panes stay frozen this long is hung, not working. */
export const HUNG_MS = 3 * 60 * 60_000;

/** Who is working right now: mid-turn, or running a command. */
export interface Activity {
  /** Agents mid-turn, or with a message sent they haven't started on. */
  busy: string[];
  /** Agents with a command (a tool call, a background run) still going. */
  running: string[];
}

const working = (activity: Activity): boolean =>
  activity.busy.length > 0 || activity.running.length > 0;

export const idleNudgeText = (step: string): string =>
  `Nobody is working on ${stepDisplayName(
    step
  )}: you, the dev and qa have all finished your turns, and nothing is running. A report may not have reached you. Read the dev's and qa's last messages, then carry on, report the step with \`lambda pod step\`, or block the ticket with \`lambda pod blocked\`.`;

export const hungNudgeText = (step: string): string =>
  `${stepDisplayName(
    step
  )} has shown no change for 3 hours while a turn is still running. Check the dev and qa, then report the step with \`lambda pod step\` or block the ticket with \`lambda pod blocked\`.`;

export const nudgeText = (step: string): string =>
  `No progress on ${stepDisplayName(
    step
  )} for 20 minutes. Check the dev and qa, then report the step with \`lambda pod step\` or block the ticket with \`lambda pod blocked\`.`;

export interface BlockedParts {
  what: string;
  problem: string;
  options: string;
  recommendation: string;
}

/** Why the second stall blocked, by what the nudge was for. */
const stallProblem = (
  run: BuildTicketRun,
  nudgedFor: 'idle' | 'hung' | undefined
): string => {
  const step = stepDisplayName(run.step);

  if (nudgedFor === 'idle') {
    return `Nobody took ${step} up again in the 20 minutes after a nudge`;
  }

  if (nudgedFor === 'hung') {
    return `${step} showed no change for 3 hours, then 20 minutes more after a nudge`;
  }

  return `No progress on ${step} for 40 minutes`;
};

/** The second stall's inbox item, in its four parts. */
export const stallBlock = (
  run: BuildTicketRun,
  nudgedFor?: 'idle' | 'hung'
): BlockedParts => ({
  what: run.title,
  problem: stallProblem(run, nudgedFor),
  options: '1) look at the Agents tab  2) set it back to Ready to retry',
  recommendation:
    'Check the Agents tab. This Lambda moved on to the next ticket.',
});

/**
 * An agent stuck on a tool still ticks: its status line counts the seconds
 * and tokens ("✻ Running… (2m 13s · ↓ 1.2k tokens)") and its spinner turns.
 * That bracket, any other elapsed time and the spinner glyphs are evened out,
 * so only that reads as silent. Other numbers are left alone: a test run's
 * "[12/40]" or "13 passed" changing in place is progress.
 */
const TICKING =
  /\([^()\n]*(?:\b[0-9]+[hms]\b|\btokens?\b)[^()\n]*\)|\b[0-9]+[hms](?: [0-9]+[hms])*\b|[·✢✳✶✻✽]/g;

export const panesHash = (captures: string): string =>
  createHash('sha256').update(captures.replace(TICKING, '#')).digest('hex');

export type StallAction =
  | { kind: 'none' }
  | { kind: 'nudge'; text: string }
  | { kind: 'block'; parts: BlockedParts };

/**
 * One look at the current run: the stall watch as it now stands, and what to
 * do. `lastStepAt` is the latest step event for this ticket (epoch ms).
 * `activity`, when known, decides what stuck means (see the top).
 */
export const checkStall = (input: {
  stall: BuildingState['stall'];
  run: BuildTicketRun;
  lastStepAt: number | null;
  panes: string;
  now: number;
  activity?: Activity;
}): { stall: NonNullable<BuildingState['stall']>; action: StallAction } => {
  const { run, now, activity } = input;
  const at = new Date(now).toISOString();
  const panes = panesHash(input.panes);
  const fresh = {
    ticket: run.id,
    step: run.step,
    attempt: run.attempt,
    quietSince: at,
    panes,
    ...(activity !== undefined && !working(activity) ? { idleSince: at } : {}),
  };
  const watch = input.stall;

  if (
    watch === undefined ||
    watch.ticket !== run.id ||
    watch.step !== run.step ||
    watch.attempt !== run.attempt ||
    (input.lastStepAt !== null &&
      input.lastStepAt > Date.parse(watch.quietSince))
  ) {
    return { stall: fresh, action: { kind: 'none' } };
  }

  if (activity === undefined) {
    return paneWatch(watch, run, panes, at, now);
  }

  const busy = working(activity);
  // A pane changed: not frozen. A nudge already sent still counts.
  const quietSince = watch.panes === panes ? watch.quietSince : at;
  // The nudge did its job: work started again after an "idle" one, or the
  // frozen turn ended after a "hung" one. Either way the count starts over.
  const recovered =
    (busy && watch.nudgedFor === 'idle') ||
    (!busy && watch.nudgedFor === 'hung');
  const { idleSince: _idle, nudgedAt, nudgedFor, ...base } = watch;
  const next = {
    ...base,
    panes,
    quietSince,
    ...(busy ? {} : { idleSince: watch.idleSince ?? at }),
    ...(recovered || nudgedAt === undefined ? {} : { nudgedAt, nudgedFor }),
  };
  const since = busy ? next.quietSince : next.idleSince ?? at;
  const waited = now - Date.parse(since);
  const limit =
    next.nudgedAt !== undefined ? STALL_MS : busy ? HUNG_MS : IDLE_MS;

  if (waited < limit) {
    return { stall: next, action: { kind: 'none' } };
  }

  if (next.nudgedAt === undefined) {
    return {
      stall: {
        ...next,
        quietSince: at,
        ...(busy ? {} : { idleSince: at }),
        nudgedAt: at,
        nudgedFor: busy ? 'hung' : 'idle',
      },
      action: {
        kind: 'nudge',
        text: busy ? hungNudgeText(run.step) : idleNudgeText(run.step),
      },
    };
  }

  return {
    stall: next,
    action: { kind: 'block', parts: stallBlock(run, next.nudgedFor) },
  };
};

/** The watch without turns: twenty silent minutes nudge, twenty more block. */
const paneWatch = (
  watch: NonNullable<BuildingState['stall']>,
  run: BuildTicketRun,
  panes: string,
  at: string,
  now: number
): { stall: NonNullable<BuildingState['stall']>; action: StallAction } => {
  // A pane changed: not silent. The nudge already sent still counts.
  if (watch.panes !== panes) {
    return {
      stall: { ...watch, quietSince: at, panes },
      action: { kind: 'none' },
    };
  }

  if (now - Date.parse(watch.quietSince) < STALL_MS) {
    return { stall: watch, action: { kind: 'none' } };
  }

  if (watch.nudgedAt === undefined) {
    return {
      stall: { ...watch, quietSince: at, nudgedAt: at },
      action: { kind: 'nudge', text: nudgeText(run.step) },
    };
  }

  return { stall: watch, action: { kind: 'block', parts: stallBlock(run) } };
};
