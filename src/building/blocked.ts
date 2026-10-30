import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { currentRun } from '../app/shared/building';
import { runTicketsUpdate } from '../commands/tickets';
import { LAMBDA_GITIGNORE, loadProjectConfig } from '../config/projectConfig';
import { EVENTS_FILE } from '../events/watcher';
import {
  type BuildTicketRun,
  type BuildingState,
  type PodStore,
  newId,
  nowIso,
} from '../pod-store';
import { DEFAULT_DIR, DEFAULT_QUEUE } from '../tickets/markdown';
import type { TicketSource } from '../tickets/source';
import {
  type Compose,
  type VisualSection,
  buildVisualSection,
} from '../verdict/visualMisses';
import { type VisualVerdict, readVisualVerdict } from '../verdict/visualStore';
import {
  blockedJustBefore,
  foldedText,
  pauseBuilding,
  pausedByManagerText,
  twoInARowText,
} from './breaker';
import { leaveRelease } from './driver';
import type { BlockedParts } from './stall';
import { roundVisualDir } from './visualPictures';

/**
 * A blocked ticket: a four-part item in the owner's inbox (what, the
 * problem, the options, a recommendation), the ticket set `blocked` in its
 * source (ungated), and the run marked blocked so the runner releases its
 * claim and the pod takes the next Ready ticket that doesn't depend on it.
 * `lambda pod blocked` and the second stall both come here. Refused, it
 * writes nothing.
 *
 * A building pod works in the project's own checkout, so the ticket's
 * uncommitted work is set aside in `git stash` (the inbox item says so):
 * left in the tree, the next ticket's ship would commit it under its id.
 *
 * A ticket whose visual check is BLOCKED carries its pictures on every
 * path that blocks it: each composite in the inbox item (`pictures`) and in
 * one Blocked comment on the ticket. Without such a record nothing changes.
 */

/** git in a checkout, argv only; its output. */
export type Git = (cwd: string, args: string[]) => string;

export const runGit: Git = (cwd, args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** Is this path ignored? (`git check-ignore -q` exits 1 when it isn't.) */
const isIgnored = (cwd: string, file: string, git: Git): boolean => {
  try {
    git(cwd, ['check-ignore', '-q', file]);

    return true;
  } catch {
    return false;
  }
};

/**
 * Every path but Lambda's own: the events file, the `.lambda/.gitignore`
 * `lambda init` writes (left uncommitted, it held every first pick-up), and
 * the ticket files of a project whose tickets live in its checkout (their
 * status is the tracker's, so it stays, and ships with the next commit). An
 * ignored path is never named: `git stash` refuses it, half-done.
 */
const workPathspec = (projectRoot: string, git: Git): string[] => {
  const tickets = loadProjectConfig(projectRoot)?.config.tickets;
  const ticketFiles =
    tickets?.source === 'markdown'
      ? [tickets.queue ?? DEFAULT_QUEUE, tickets.dir ?? DEFAULT_DIR]
      : [];

  return [
    '--',
    ':/',
    ...[EVENTS_FILE, LAMBDA_GITIGNORE, ...ticketFiles]
      .filter((file) => !isIgnored(projectRoot, file, git))
      .map((file) => `:(exclude)${file}`),
  ];
};

const isGitCheckout = (cwd: string, git: Git): boolean => {
  try {
    return git(cwd, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    // Not a git repository: there is no uncommitted work to speak of.
    return false;
  }
};

/** The checkout's uncommitted changes (`git status --porcelain` lines). */
export const uncommittedWork = (
  projectRoot: string,
  git: Git = runGit
): string[] =>
  isGitCheckout(projectRoot, git)
    ? git(projectRoot, [
        'status',
        '--porcelain',
        ...workPathspec(projectRoot, git),
      ])
        .split('\n')
        .filter((line) => line !== '')
    : [];

export const stashMessage = (
  ticketId: string,
  why: 'blocked' | 'ended'
): string => `lambda: ${ticketId} ${why}`;

/** Stashed, with untracked files; the stash's message, or null if clean. */
export const setAsideWork = (
  projectRoot: string,
  ticketId: string,
  why: 'blocked' | 'ended',
  git: Git = runGit
): string | null => {
  if (uncommittedWork(projectRoot, git).length === 0) {
    return null;
  }

  const message = stashMessage(ticketId, why);
  git(projectRoot, [
    'stash',
    'push',
    '--include-untracked',
    '--quiet',
    '-m',
    message,
    ...workPathspec(projectRoot, git),
  ]);

  // git can stash part of it and still exit 0: what's left is said, loudly.
  const left = uncommittedWork(projectRoot, git);

  if (left.length > 0) {
    throw new Error(
      `git stash left ${left.length} change${
        left.length === 1 ? '' : 's'
      } behind in ${projectRoot}`
    );
  }

  return message;
};

export const setAsideText = (message: string): string =>
  `Its uncommitted work is set aside: \`git stash list\` shows it as "${message}".`;

/** Said in the inbox item when the stash itself failed. */
const notSetAsideText = (error: unknown): string =>
  `Its uncommitted work couldn't be set aside (${
    error instanceof Error ? error.message.trim() : String(error)
  }). The next ticket waits until the checkout is clean.`;

export const FOUR_PARTS =
  'Blocked needs all four parts: --what, --problem, --options and --recommendation.';

export const blockedText = (parts: BlockedParts): string =>
  [
    `**What:** ${parts.what.trim()}`,
    `**Problem:** ${parts.problem.trim()}`,
    `**Options:** ${parts.options.trim()}`,
    `**Recommendation:** ${parts.recommendation.trim()}`,
  ].join('\n');

const complete = (parts: Partial<BlockedParts>): parts is BlockedParts =>
  [parts.what, parts.problem, parts.options, parts.recommendation].every(
    (part) => part !== undefined && part.trim() !== ''
  );

export const blockTicket = async (input: {
  store: PodStore;
  podId: string;
  ticketId: string;
  parts: Partial<BlockedParts>;
  source: TicketSource;
  git?: Git;
  /** `--visual`: fill the parts not passed from the BLOCKED visual record. */
  visual?: boolean;
  /** Draws the visual check's composites (Playwright by default). */
  compose?: Compose;
  log?: (line: string) => void;
  /**
   * Taken out of Lambda in its tracker: blocked here only. Its status there
   * is left as it is, as the ticket isn't Lambda's to change any more.
   */
  leftLambda?: boolean;
  /**
   * `--pause`: the problem isn't the ticket's, so the next ticket would stop
   * the same way. The pod is paused after this block (building/breaker.ts).
   */
  pause?: boolean;
}): Promise<void> => {
  const { store, podId, ticketId } = input;
  const log = input.log ?? ((line: string) => console.error(line));
  const current = currentRun(store.readBuilding(podId));
  const checkout = store.requirePod(podId).devCwd;
  // Every block of a building ticket looks for a BLOCKED visual record, so
  // one blocked without --visual still carries its pictures.
  const lookup = blockedVisualRecord(checkout, ticketId);
  const visual = 'verdict' in lookup ? lookup.verdict : null;

  if (input.visual === true && 'none' in lookup) {
    throw new Error(
      lookup.none === null
        ? `${ticketId} has no blocked visual check.`
        : `${ticketId} has no blocked visual check: ${lookup.none}.`
    );
  }

  const parts =
    input.visual === true && visual !== null
      ? {
          ...visualParts(current?.title ?? ticketId, visual),
          ...given(input.parts),
        }
      : input.parts;

  if (!complete(parts)) {
    throw new Error(FOUR_PARTS);
  }

  if (current?.id !== ticketId) {
    throw new Error(`${ticketId} isn't the ticket this pod is building.`);
  }

  const before = blockedJustBefore(store.readBuilding(podId));

  // The block before held this one too, before any work on it.
  if (
    before !== null &&
    current.step === 'pick-up' &&
    input.leftLambda !== true
  ) {
    foldBlock({
      store,
      podId,
      run: current,
      into: before,
      problem: parts.problem.trim(),
      git: input.git,
    });

    return;
  }

  // `lambda tickets update <id> --status blocked` first, with its own
  // refusals: if it refuses, nothing else is written.
  if (input.leftLambda !== true) {
    await runTicketsUpdate(
      { source: input.source, print: () => undefined },
      ticketId,
      // A status reason is one line; the inbox item keeps the whole problem.
      {
        status: 'blocked',
        reason: parts.problem.trim().split('\n')[0]?.trim(),
      }
    );
  }

  // Another block of this ticket can finish while the tracker answers, and
  // the pod take the next one: that one's run and work are left alone.
  const isCurrent = (state: BuildingState) =>
    currentRun(state)?.id === ticketId;

  if (!isCurrent(store.readBuilding(podId))) {
    return;
  }

  // Before the work is set aside: the composites are drawn from this
  // round's photos, which live in the checkout's verdicts folder.
  const pictures =
    visual === null
      ? null
      : await attachVisual({
          store,
          podId,
          checkout,
          verdict: visual,
          compose: input.compose,
        });
  // Posted before the inbox item is written, so the item can say when the
  // pictures didn't reach the ticket (drawn, copied or attached).
  const notAttached =
    visual === null || pictures === null
      ? null
      : await postBlockedVisualComment({
          source: input.source,
          ticketId,
          problem: parts.problem.trim(),
          verdict: visual,
          pictures,
          log,
        });
  const stash = (() => {
    try {
      return {
        message: setAsideWork(checkout, ticketId, 'blocked', input.git),
      };
    } catch (error) {
      return { failed: notSetAsideText(error) };
    }
  })();
  const setAside =
    'failed' in stash
      ? stash.failed
      : stash.message === null
      ? null
      : setAsideText(stash.message);
  const at = nowIso();
  const messageId = newId('m');
  const patched = store.updateBuilding(podId, (state) => ({
    ...state,
    runs: state.runs.map((run) =>
      run === currentRun(state) && isCurrent(state)
        ? {
            ...run,
            blocked: {
              at,
              what: parts.what.trim(),
              problem: parts.problem.trim(),
              options: parts.options.trim(),
              recommendation: parts.recommendation.trim(),
              messageId,
              ...('message' in stash && stash.message !== null
                ? { setAside: stash.message }
                : {}),
            },
          }
        : run
    ),
  }));

  if (!patched.runs.some((run) => run.blocked?.messageId === messageId)) {
    return;
  }

  const paused =
    input.pause === true
      ? pausedByManagerText
      : before === null
      ? null
      : twoInARowText(before.id, ticketId);

  store.appendThread({
    id: messageId,
    podId,
    from: 'engineering-manager',
    mode: 'note',
    text: [
      blockedText(parts),
      ...(setAside === null ? [] : [setAside]),
      ...(notAttached === null
        ? []
        : [
            // A reason that ends its own sentence keeps one full stop.
            `The pictures couldn't be attached: ${notAttached.replace(
              /\.+$/,
              ''
            )}.`,
          ]),
      ...(paused === null ? [] : [paused]),
    ].join('\n\n'),
    expectsReply: true,
    createdAt: at,
    ...(pictures !== null && 'files' in pictures
      ? {
          pictures: pictures.files,
          picturesAt: { ticketId, round: pictures.round },
        }
      : {}),
  });

  if (paused !== null) {
    pauseBuilding(store, podId, paused, at);
  }
};

/**
 * A ticket the block before held too, before any work on it: not blocked
 * itself. Its run is dropped, it's listed on that block's item, the runner
 * puts it back to Ready and lets its claim go (`_releases.json`), and the
 * pod is paused (building/breaker.ts).
 */
const foldBlock = (input: {
  store: PodStore;
  podId: string;
  run: BuildTicketRun;
  into: BuildTicketRun;
  problem: string;
  git?: Git;
}): void => {
  const { store, podId, run, into } = input;
  const pod = store.requirePod(podId);
  // A pick-up writes nothing, but whatever is there isn't left in the tree.
  const left = (() => {
    try {
      const message = setAsideWork(pod.devCwd, run.id, 'blocked', input.git);

      return message === null ? null : setAsideText(message);
    } catch (error) {
      return notSetAsideText(error);
    }
  })();
  const at = nowIso();
  const held = { id: run.id, title: run.title, at, problem: input.problem };
  const folded = store.updateBuilding(podId, (state) =>
    currentRun(state)?.id === run.id
      ? {
          ...state,
          runs: state.runs.flatMap((one): BuildTicketRun[] =>
            one === state.runs.at(-1)
              ? []
              : [
                  one.id === into.id &&
                  one.blocked !== undefined &&
                  one.blocked.at === into.blocked?.at
                    ? {
                        ...one,
                        blocked: {
                          ...one.blocked,
                          alsoHeld: [...(one.blocked.alsoHeld ?? []), held],
                        },
                      }
                    : one,
                ]
          ),
        }
      : state
  );

  // Another block of it finished first: nothing more here.
  if (currentRun(folded)?.id === run.id) {
    return;
  }

  leaveRelease(store.root, run.id, pod.projectId);
  store.appendThread({
    id: newId('m'),
    podId,
    from: 'engineering-manager',
    mode: 'note',
    text: [
      foldedText(run, into, input.problem),
      ...(left === null ? [] : [left]),
    ].join('\n\n'),
    expectsReply: false,
    createdAt: at,
  });
  pauseBuilding(
    store,
    podId,
    `${run.id} was held by the same problem as ${into.id}.`,
    at
  );
};

// ── a ticket blocked by its visual check ────────────────────────────────────

/**
 * The ticket's visual record when it is BLOCKED, or why there is none to
 * use: `--visual` names that cause, a plain block goes on without pictures.
 */
const blockedVisualRecord = (
  checkout: string,
  ticketId: string
): { verdict: VisualVerdict } | { none: string | null } => {
  try {
    const lookup = readVisualVerdict(checkout, ticketId);

    if (lookup.state === 'unreadable') {
      return { none: `its record couldn't be read (${lookup.reason})` };
    }

    return lookup.state === 'found' && lookup.verdict.result === 'BLOCKED'
      ? { verdict: lookup.verdict }
      : { none: null };
  } catch (error) {
    // A ticket id no record can have, or a folder without lambda.json.
    return { none: error instanceof Error ? error.message : String(error) };
  }
};

/** The parts the caller did pass: an empty one is left to the record. */
const given = (parts: Partial<BlockedParts>): Partial<BlockedParts> =>
  Object.fromEntries(
    Object.entries(parts).filter(
      ([, value]) => value !== undefined && value.trim() !== ''
    )
  );

/** `--visual`'s four parts, from the BLOCKED record. */
export const visualParts = (
  title: string,
  verdict: VisualVerdict
): BlockedParts => {
  const high = verdict.issues.find((issue) => issue.severity === 'high');

  return {
    what: title,
    problem: `After ${
      verdict.rounds
    } rounds the finished screen still differs from the design: ${
      high === undefined
        ? 'a high issue is left'
        : `${high.situation}: ${high.what}`
    }`,
    options:
      'compare the pictures and set it back to Ready to retry · change the design in a planning pod',
    recommendation:
      'Compare the pictures. This Lambda moved on to the next ticket.',
  };
};

type AttachedPictures =
  | { round: number; files: string[]; section: VisualSection }
  | { failed: string };

/**
 * Every picture with an issue worse than low gets its composite, copied into
 * `<pods root>/<pod>/visual/<ticket>/<final round>/composite-<scenarioId>.png`:
 * the only folder the app's visual picture route serves. Never throws: what
 * went wrong is answered, and the ticket is blocked either way.
 */
const attachVisual = async (input: {
  store: PodStore;
  podId: string;
  checkout: string;
  verdict: VisualVerdict;
  compose?: Compose;
}): Promise<AttachedPictures> => {
  try {
    const section = await buildVisualSection(
      input.checkout,
      input.verdict,
      input.compose
    );
    const dir = roundVisualDir(
      input.store,
      input.podId,
      input.verdict.ticketId,
      input.verdict.rounds
    );
    fs.mkdirSync(dir, { recursive: true });
    const files = section.composites.map(({ scenarioId, file }) => {
      const name = `composite-${scenarioId}.png`;
      fs.copyFileSync(file, path.join(dir, name));

      return name;
    });

    return { round: input.verdict.rounds, files, section };
  } catch (error) {
    return {
      failed: error instanceof Error ? error.message.trim() : String(error),
    };
  }
};

/**
 * The Blocked comment on the ticket: the problem, then the visual check's
 * heading and its pictures. When the pictures couldn't be made or attached,
 * the comment goes out without them, saying why, and the reason is answered
 * for the inbox item; when even that comment fails, it is logged.
 */
const postBlockedVisualComment = async (input: {
  source: TicketSource;
  ticketId: string;
  problem: string;
  verdict: VisualVerdict;
  pictures: AttachedPictures;
  log: (line: string) => void;
}): Promise<string | null> => {
  const heading = `### 🎨 Visual check: a high issue is left after ${input.verdict.rounds} rounds`;
  const reasonOf = (error: unknown): string =>
    error instanceof Error ? error.message.trim() : String(error);
  /** The comment with no pictures, saying why. Never throws. */
  const withoutPictures = async (reason: string): Promise<string> => {
    try {
      await input.source.comment(
        input.ticketId,
        [
          input.problem,
          '',
          heading,
          '',
          `_visual section could not be attached: ${reason}_`,
        ].join('\n')
      );
    } catch (error) {
      input.log(
        `Could not post the visual check's Blocked comment on ${
          input.ticketId
        }: ${reasonOf(error)}`
      );
    }

    return reason;
  };

  if ('failed' in input.pictures) {
    return withoutPictures(input.pictures.failed);
  }

  try {
    await input.source.comment(
      input.ticketId,
      [input.problem, '', heading, '', input.pictures.section.body].join('\n'),
      { images: input.pictures.section.images }
    );

    return null;
  } catch (error) {
    // Attaching is part of the comment: a picture the tracker refused fails
    // it whole, so the comment goes again without them.
    return withoutPictures(reasonOf(error));
  }
};
