import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { NOTHING_READY_TO_BUILD, currentRun } from '../app/shared/building';
import { fillCommandTemplate } from '../commands/e2e';
import { loadProjectConfig } from '../config/projectConfig';
import { isSetupTicket } from '../design/system/setupTicket';
import {
  type BuildTicketRun,
  type BuildingState,
  type PodStore,
  newId,
} from '../pod-store';
import { withFileLock, writeJsonAtomic } from '../pod-store/store';
import { runScenariosPull, scenariosDepsFor } from '../tickets/scenarios';
import type { Ticket, TicketSource } from '../tickets/source';
import { blockedText, uncommittedWork } from './blocked';
import { pauseBuilding } from './breaker';
import type { OwnerIdentity } from './owner';
import { type ClaimOutcome, pickUp } from './pickUp';
import type { ClaimRow } from './queue';
import { type Activity, type BlockedParts, checkStall } from './stall';

/**
 * One building pod, as the runner holding it keeps it going (`tick`, every
 * few seconds):
 *
 * - claims follow the pod: a blocked ticket's claim is released, and so is
 *   an ended pod's current one (its ticket back to Ready); a shipped ticket
 *   is told to the mothership, and a grouped one is done once its group
 *   ships. Pause and `lambda stop` keep the claim.
 * - with no current ticket, pick-up: the next one in the queue, claimed
 *   first. Nothing Ready, or the mothership unreachable, asks again after
 *   60 seconds; meanwhile the pod is idle.
 * - a ticket that can't be set `building` three pick-ups running is skipped
 *   for this pod, so the pod gets on to the next one.
 * - with one, the stall watch, once a minute.
 */

export const POLL_MS = 60_000;
export const STALL_CHECK_MS = 60_000;
/** Pick-ups in a row a ticket can fail to be set `building` before it's skipped. */
export const SET_BUILDING_TRIES = 3;

/** `<pods root>/_releases.json`: claims an ended pod left for the runner. */
export const RELEASES_FILE = '_releases.json';
/** `<pods root>/_shipped.json`: ships an ended pod left, still to report. */
export const SHIPPED_FILE = '_shipped.json';

export interface BuildingMothership {
  claims: () => Promise<ClaimRow[]>;
  claim: (
    ticketId: string,
    reporter: { name: string; email?: string } | null
  ) => Promise<ClaimOutcome>;
  /** Outbox items: kept until the mothership has them. */
  release: (ticketId: string) => void;
  shipped: (ticketId: string) => void;
}

export interface BuildingDriverDeps {
  store: PodStore;
  podId: string;
  projectRoot: string;
  runnerId: string;
  /** This computer's name: tickets assigned to another one are skipped. */
  computer?: string;
  source: () => TicketSource;
  /** The mothership's `owner` message, kept in memory; null until it came. */
  owner: () => OwnerIdentity | null;
  mothership: BuildingMothership;
  /** A message to one of the pod's windows (`lambda pod send`). */
  send: (target: string, text: string) => Promise<void>;
  /** Stop an agent's turn now (`lambda pod interrupt`). */
  interrupt: (agent: 'dev' | 'qa') => Promise<void>;
  /**
   * Block the current ticket: what `lambda pod blocked` does. `leftLambda`:
   * it was taken out of Lambda, so its tracker status is left alone.
   */
  block: (
    ticketId: string,
    parts: BlockedParts,
    how?: { leftLambda: boolean }
  ) => Promise<void>;
  /** The engineering-manager, dev and qa panes, captured. */
  panes: () => string;
  /**
   * Who is working: the three agents' turns and running commands. Without
   * it, the stall watch reads the panes alone (see building/stall.ts).
   */
  activity?: () => Activity;
  now: () => number;
  log: (line: string) => void;
  /** The checkout's uncommitted changes: pick-up waits until there are none. */
  uncommitted?: () => string[];
  /**
   * Downloads a ticket's screenshot scenarios into the checkout's pending
   * folder (`lambda tickets scenarios pull`); throws when it can't.
   */
  pullScenarios?: (ticketId: string) => Promise<void>;
  /**
   * Sets the checkout up for a claimed ticket: the project's
   * `commands.pickUp`. The command run, or null with none; throws
   * `PickUpCommandFailed` when it fails.
   */
  prepare?: (ticketId: string) => Promise<string | null>;
}

/** A pick-up command can restart the project's services: it gets this long. */
export const PICK_UP_COMMAND_MS = 10 * 60_000;

export class PickUpCommandFailed extends Error {
  constructor(readonly command: string, readonly output: string) {
    super(`${command} failed: ${output}`);
  }
}

/** The last lines of a command's output: what it said when it stopped. */
const lastLines = (output: string, count = 12): string =>
  output.trim().split('\n').slice(-count).join('\n');

/** The default prepare: the project's `commands.pickUp`, in its checkout. */
export const runPickUpCommand =
  (projectRoot: string) =>
  async (ticketId: string): Promise<string | null> => {
    const template = loadProjectConfig(projectRoot)?.config.commands?.pickUp;

    if (template === undefined) {
      return null;
    }

    const command = fillCommandTemplate(template, [ticketId]);

    await new Promise<void>((resolve, reject) => {
      execFile(
        '/bin/sh',
        ['-c', command],
        {
          cwd: projectRoot,
          timeout: PICK_UP_COMMAND_MS,
          maxBuffer: 8 * 1024 * 1024,
          encoding: 'utf8',
        },
        (error, stdout, stderr) =>
          error === null
            ? resolve()
            : reject(
                new PickUpCommandFailed(
                  command,
                  lastLines(`${stdout}\n${stderr}`) || error.message
                )
              )
      );
    });

    return command;
  };

/** The owner's item when the pick-up command failed: four parts. */
export const notPreparedText = (
  ticket: Pick<Ticket, 'id' | 'title'>,
  error: unknown
): string =>
  blockedText({
    what: `${ticket.id} ${ticket.title}. Not started: no code was written.`,
    problem:
      error instanceof PickUpCommandFailed
        ? `Lambda couldn't set the checkout up for it: \`${error.command}\` failed.\n\n${error.output}`
        : `Lambda couldn't set the checkout up for it: ${
            error instanceof Error ? error.message : String(error)
          }`,
    options: `1) Fix what it says, then resume this builder: ${ticket.id} is back in Ready and is picked up again  2) Take \`pickUp\` out of lambda.json to build without it`,
    recommendation:
      '1. This builder is paused, so no other ticket is claimed only to stop the same way.',
  });

export const scenariosFailedText = (ticketId: string, reason: string): string =>
  `Couldn't fetch ${ticketId}'s screenshot scenarios (${reason}).`;

/** The default pull: the project's own source, into its checkout. */
const pullInto =
  (
    projectRoot: string,
    source: () => TicketSource,
    log: (line: string) => void
  ) =>
  async (ticketId: string): Promise<void> => {
    const project = loadProjectConfig(projectRoot);

    if (project === null) {
      return;
    }

    await runScenariosPull(
      ticketId,
      scenariosDepsFor(project, projectRoot, {
        source: source(),
        // A ticket with none is the usual case: nothing to say.
        print: (line) => {
          if (!line.startsWith('No screenshot scenarios')) {
            log(line);
          }
        },
        printError: log,
      })
    );
  };

const patchRun = (
  state: BuildingState,
  id: string,
  patch: Partial<BuildTicketRun>
): BuildingState => ({
  ...state,
  runs: state.runs.map((run) => (run.id === id ? { ...run, ...patch } : run)),
});

/**
 * A claim an ended pod left. `projectId` rides along so the release still
 * finds its claim after the folder is re-linked; an older runner wrote the
 * bare ticket id.
 */
export interface PendingRelease {
  ticketId: string;
  projectId?: string;
}

const toRelease = (entry: unknown): PendingRelease[] => {
  if (typeof entry === 'string') {
    return [{ ticketId: entry }];
  }

  if (
    typeof entry !== 'object' ||
    entry === null ||
    !('ticketId' in entry) ||
    typeof entry.ticketId !== 'string'
  ) {
    return [];
  }

  return 'projectId' in entry && typeof entry.projectId === 'string'
    ? [{ ticketId: entry.ticketId, projectId: entry.projectId }]
    : [{ ticketId: entry.ticketId }];
};

const readReleases = (file: string): PendingRelease[] => {
  if (!fs.existsSync(file)) {
    return [];
  }

  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));

  return Array.isArray(parsed) ? parsed.flatMap(toRelease) : [];
};

/**
 * `lambda pod done` adds to these lists while the runner settles them, each
 * in its own process: every change is read and written under the file's lock,
 * so neither loses the other's entry.
 */
const LIST_LOCK = { timeoutMs: 10_000, staleMs: 30_000 };

const settleIn = (file: string, ticketId: string): void =>
  withFileLock(file, LIST_LOCK, () =>
    writeJsonAtomic(
      file,
      readReleases(file).filter((release) => release.ticketId !== ticketId)
    )
  );

const leaveIn = (file: string, ticketId: string, projectId?: string): void =>
  withFileLock(file, LIST_LOCK, () =>
    writeJsonAtomic(file, [
      ...readReleases(file).filter((release) => release.ticketId !== ticketId),
      projectId === undefined ? { ticketId } : { ticketId, projectId },
    ])
  );

/**
 * Claims a pod ended (`done`, `delete`) left behind, still to release. Each
 * stays in the file until `settleRelease`: one that fails (the tracker down)
 * is tried again on the next tick, and the rest aren't lost with it.
 */
export const pendingReleases = (podsRoot: string): PendingRelease[] =>
  readReleases(path.join(podsRoot, RELEASES_FILE));

/** One release done: off the list, the rest (and any new ones) kept. */
export const settleRelease = (podsRoot: string, ticketId: string): void =>
  settleIn(path.join(podsRoot, RELEASES_FILE), ticketId);

/** What `done`/`delete` leave for the runner: the runner releases them. */
export const leaveRelease = (
  podsRoot: string,
  ticketId: string,
  projectId?: string
): void => leaveIn(path.join(podsRoot, RELEASES_FILE), ticketId, projectId);

/**
 * Tickets an ended pod shipped that the runner hadn't reported yet: their
 * claims are kept (shipped), so they go to the mothership as ships, never
 * as releases.
 */
export const pendingShips = (podsRoot: string): PendingRelease[] =>
  readReleases(path.join(podsRoot, SHIPPED_FILE));

export const settleShip = (podsRoot: string, ticketId: string): void =>
  settleIn(path.join(podsRoot, SHIPPED_FILE), ticketId);

export const leaveShip = (
  podsRoot: string,
  ticketId: string,
  projectId?: string
): void => leaveIn(path.join(podsRoot, SHIPPED_FILE), ticketId, projectId);

/**
 * The Engineering manager's pick-up message. The ticket that makes the
 * design system (known by its exact title) is built by
 * `/design-system-setup`, not `/start`.
 */
export const pickedUpText = (
  run: Pick<BuildTicketRun, 'id' | 'title'>,
  position: { n: number; m: number },
  notes: string[] = []
): string => {
  const picked = [
    `Picked up ${run.id} ${run.title} (ticket ${position.n} of ${position.m}): it's claimed and building.`,
    ...notes,
    `Post "picked up ${run.id} ${run.title}" with \`lambda pod reply --fyi\`, then go on from Step 2 (Build).`,
  ].join(' ');

  if (!isSetupTicket(run)) {
    return picked;
  }

  return `${picked} This is the ticket that makes the design system: in Step 2 send the dev \`/design-system-setup ${run.id}\` instead of \`/start ${run.id}\`.`;
};

/** A mothership call that failed for a reason other than being unreachable. */
class LambdaAnswer extends Error {
  constructor(readonly label: string, message: string) {
    super(message);
  }
}

/**
 * A mothership call whose failure says it was Lambda's, not the tickets'.
 * Unreachable stays as it is: pick-up waits that one out.
 */
const fromLambda =
  <A extends unknown[], R>(label: string, call: (...args: A) => Promise<R>) =>
  (...args: A): Promise<R> =>
    call(...args).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);

      throw /reach Lambda/i.test(message)
        ? error
        : new LambdaAnswer(label, message);
    });

const TRACKER_NAMES: Record<TicketSource['kind'], string> = {
  linear: 'Linear',
  jira: 'Jira',
  markdown: 'its ticket file',
};

/** The Blocked item for a ticket taken out of Lambda mid-build. */
export const leftLambdaBlock = (
  run: Pick<BuildTicketRun, 'id' | 'title'>,
  kind: TicketSource['kind']
): BlockedParts => ({
  what: run.title,
  problem: `Removed from Lambda in ${TRACKER_NAMES[kind]}: ${run.id} lost Lambda's label while it was being built.`,
  options: `1) Add the label back in ${TRACKER_NAMES[kind]}, then set it to Ready to build it again  2) Leave it out of Lambda: its work stays set aside`,
  recommendation:
    'Leave it out unless the label came off by mistake. This Lambda moved on to the next ticket.',
});

/**
 * Idle with Ready tickets someone else reported: which, by whom, and how to
 * count that login as the owner's. Null when there are none.
 */
export const notYoursReason = (notYours: Ticket[]): string | null => {
  if (notYours.length === 0) {
    return null;
  }

  const ids = notYours.slice(0, 3).map((ticket) => ticket.id);
  const more =
    notYours.length > ids.length
      ? ` and ${notYours.length - ids.length} more`
      : '';
  const reporters = [
    ...new Set(
      notYours.map(
        (ticket) => ticket.reporter?.email ?? ticket.reporter?.name ?? 'someone'
      )
    ),
  ];
  const [only] = reporters;
  // One reporter: the exact command (a name with a space, quoted). Several:
  // which is yours isn't Lambda's to guess.
  const fix =
    reporters.length === 1 && only !== undefined
      ? `If that's you, run lambda account alias add ${
          /\s/.test(only) ? `"${only}"` : only
        }`
      : 'If one of them is you, add it with lambda account alias add';

  return `Skipping ${ids.join(
    ', '
  )}${more}: Ready, but reported by ${reporters.join(
    ', '
  )}, and Lambda builds only tickets you report. ${fix}`;
};

/** The Engineering manager's word that the ticket it's on left Lambda. */
export const leftLambdaStopText = (
  run: Pick<BuildTicketRun, 'id' | 'title'>,
  kind: TicketSource['kind']
): string =>
  `Stop: ${run.id} ${run.title} was taken out of Lambda in ${TRACKER_NAMES[kind]} while it was being built. The dev and QA were stopped, its work is set aside, and the owner has been asked. Send them nothing more for it and don't ship it: the runner tells you when it picks up the next ticket.`;

export const createBuildingDriver = (deps: BuildingDriverDeps) => {
  const { store, podId } = deps;
  const checked: { at: number } = { at: Number.NEGATIVE_INFINITY };
  /** When the current ticket's membership was last asked. */
  const membership: { at: number } = { at: Number.NEGATIVE_INFINITY };
  /** Each ticket's failed tries in a row to be set `building`. */
  const setBuildingFailures = new Map<string, number>();
  const uncommitted =
    deps.uncommitted ?? (() => uncommittedWork(deps.projectRoot));
  const pullScenarios =
    deps.pullScenarios ?? pullInto(deps.projectRoot, deps.source, deps.log);
  const prepare = deps.prepare ?? runPickUpCommand(deps.projectRoot);
  /** Tickets whose scenarios this driver has pulled (a new one: resumed). */
  const pulledScenarios = new Set<string>();

  /**
   * The ticket's screenshot scenarios, once per ticket per driver: after its
   * claim, and again when a restarted runner resumes it. A failed pull never
   * fails the pick-up: the Engineering manager says so in the thread.
   */
  const fetchScenarios = async (ticketId: string): Promise<void> => {
    if (pulledScenarios.has(ticketId)) {
      return;
    }

    pulledScenarios.add(ticketId);

    try {
      await pullScenarios(ticketId);
    } catch (error) {
      store.appendThread({
        id: newId('m'),
        podId,
        from: 'engineering-manager',
        mode: 'note',
        text: scenariosFailedText(
          ticketId,
          error instanceof Error ? error.message : String(error)
        ),
        expectsReply: false,
        createdAt: new Date(deps.now()).toISOString(),
      });
    }
  };

  /** Claims follow the pod, whatever its status. */
  const syncClaims = async (): Promise<void> => {
    const pod = store.readPod(podId);

    if (pod === null) {
      return;
    }

    // An ended pod's claims go through `_releases.json` and
    // `_shipped.json`: the runner only ticks pods that aren't done.
    const state = store.readBuilding(podId);
    const blocked = state.runs.filter(
      (run) => run.blocked !== undefined && run.claim === 'claimed'
    );
    blocked.forEach((run) => deps.mothership.release(run.id));
    const shipped = state.runs.filter(
      (run) => run.shippedAt !== undefined && run.shipReported !== true
    );
    shipped.forEach((run) => deps.mothership.shipped(run.id));

    if (blocked.length > 0 || shipped.length > 0) {
      await store.updateBuildingAsync(podId, (latest) =>
        latest.runs.reduce(
          (next, run) =>
            blocked.some((one) => one.id === run.id)
              ? patchRun(next, run.id, { claim: 'released' })
              : shipped.some((one) => one.id === run.id)
              ? patchRun(next, run.id, { shipReported: true })
              : next,
          latest
        )
      );
    }
  };

  const lastStepAt = (ticketId: string): number | null => {
    const times = store
      .readSteps(podId)
      .filter((step) => step.ticket === ticketId)
      .map((step) => Date.parse(step.at))
      .filter((at) => Number.isFinite(at));

    return times.length === 0 ? null : Math.max(...times);
  };

  const watchStall = async (run: BuildTicketRun): Promise<void> => {
    if (deps.now() - checked.at < STALL_CHECK_MS) {
      return;
    }

    checked.at = deps.now();
    const state = store.readBuilding(podId);
    const { stall, action } = checkStall({
      stall: state.stall,
      run,
      lastStepAt: lastStepAt(run.id),
      panes: deps.panes(),
      now: deps.now(),
      activity: deps.activity?.(),
    });

    if (action.kind === 'nudge') {
      // Counted as sent only once it went: a failed send is nudged again.
      await deps.send('engineering-manager', action.text);
    }

    await store.updateBuildingAsync(podId, (latest) => ({ ...latest, stall }));

    if (action.kind === 'nudge') {
      return;
    }

    if (action.kind === 'block') {
      await deps.block(run.id, action.parts);
      await store.updateBuildingAsync(podId, (latest) => ({
        ...latest,
        stall: undefined,
      }));
      // Released now, not on the next tick: the pod moves straight on.
      await syncClaims();
    }
  };

  /**
   * The ticket being built is still Lambda's: once a minute, the tracker is
   * asked. Taken out (its member label gone), the build stops on it: the dev
   * and QA are stopped before its work is set aside, the owner is asked (its
   * tracker status left alone), and the Engineering manager is told to stand
   * down. A tracker that doesn't answer is asked again next minute: nothing
   * is decided on a failed read.
   */
  const watchMembership = async (run: BuildTicketRun): Promise<void> => {
    if (deps.now() - membership.at < STALL_CHECK_MS) {
      return;
    }

    membership.at = deps.now();
    const source = deps.source();
    const member = await (
      source.isMember?.(run.id) ?? Promise.resolve(true)
    ).catch(() => true);

    if (member) {
      return;
    }

    if (currentRun(store.readBuilding(podId))?.id !== run.id) {
      return;
    }

    // Stopped first, so nothing is still writing when the work is set aside.
    // One that can't be stopped never keeps the ticket from being blocked.
    await (['dev', 'qa'] as const).reduce(async (done, agent) => {
      await done;
      await deps
        .interrupt(agent)
        .catch((error: unknown) =>
          deps.log(
            `Couldn't stop the ${agent} on ${run.id}: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
    }, Promise.resolve());
    await deps.block(run.id, leftLambdaBlock(run, source.kind), {
      leftLambda: true,
    });
    await deps.send(
      'engineering-manager',
      leftLambdaStopText(run, source.kind)
    );
    await syncClaims();
  };

  /** A blocked last ticket first: it's waiting on the owner. */
  const idleReasonOf = (
    state: BuildingState,
    notYours: Ticket[] = []
  ): string => {
    const last = state.runs.at(-1);

    return last?.blocked === undefined
      ? notYoursReason(notYours) ?? NOTHING_READY_TO_BUILD
      : `${last.id} is Blocked`;
  };

  const dirtyReason = (changes: number): string =>
    `${deps.projectRoot} has uncommitted changes (${changes} file${
      changes === 1 ? '' : 's'
    }): commit or stash them, and the next ticket starts.`;

  /**
   * One more failed try to set a ticket `building`. The last one allowed
   * skips it for this pod (as `lambda pod skip-ticket` does): true then.
   */
  const failedAgain = (failure: { ticketId: string; reason: string }) => {
    const tries = (setBuildingFailures.get(failure.ticketId) ?? 0) + 1;

    if (tries < SET_BUILDING_TRIES) {
      setBuildingFailures.set(failure.ticketId, tries);

      return false;
    }

    setBuildingFailures.delete(failure.ticketId);
    store.updatePod(podId, (current) =>
      (current.skipped ?? []).includes(failure.ticketId)
        ? current
        : {
            ...current,
            skipped: [...(current.skipped ?? []), failure.ticketId],
          }
    );
    deps.log(
      `Couldn't set ${failure.ticketId} to building ${SET_BUILDING_TRIES} times (${failure.reason}): skipped it for this pod.`
    );

    return true;
  };

  /**
   * A ticket claimed and set building that no run will build: back to
   * Ready, then released. A tracker that refuses leaves it to the runner's
   * leftover releases, which try again.
   */
  const putBack = async (ticketId: string, projectId?: string) => {
    try {
      await deps.source().update(ticketId, { status: 'ready' });
      deps.mothership.release(ticketId);
    } catch (error) {
      deps.log(
        `Couldn't set ${ticketId} back to Ready (${
          error instanceof Error ? error.message : String(error)
        }): left for the runner to release.`
      );
      leaveRelease(store.root, ticketId, projectId);
    }
  };

  const takeNext = async (): Promise<void> => {
    const state = store.readBuilding(podId);

    // Only a poll that took nothing waits: a ticket that just shipped or
    // blocked is followed by the next one at once.
    if (
      state.idleReason !== undefined &&
      state.polledAt !== undefined &&
      deps.now() - Date.parse(state.polledAt) < POLL_MS
    ) {
      return;
    }

    const polledAt = new Date(deps.now()).toISOString();
    const result = await pickUp({
      source: deps.source(),
      owner: deps.owner(),
      runnerId: deps.runnerId,
      computer: deps.computer,
      skipped: store.requirePod(podId).skipped ?? [],
      claims: fromLambda("Couldn't read the claims", deps.mothership.claims),
      claim: fromLambda("Couldn't claim a ticket", deps.mothership.claim),
      release: deps.mothership.release,
      uncommitted,
    }).catch(async (error: unknown) => {
      // The tracker down or rate-limited, or Lambda refusing a claim: idle
      // with the reason, and the same 60-second wait as any other poll that
      // took nothing. Still thrown, so the runner logs it.
      await store.updateBuildingAsync(podId, (latest) => ({
        ...latest,
        polledAt,
        upNext: [],
        idleReason:
          error instanceof LambdaAnswer
            ? `${error.label}: ${error.message}`
            : `Couldn't read tickets: ${
                error instanceof Error ? error.message : String(error)
              }`,
      }));

      throw error;
    });

    const skippedNow = result.kind === 'failed' && failedAgain(result);

    if (result.kind !== 'picked') {
      await store.updateBuildingAsync(podId, (latest) => ({
        ...latest,
        polledAt,
        upNext: [],
        idleReason:
          result.kind === 'nothing'
            ? idleReasonOf(latest, result.notYours)
            : result.kind === 'failed'
            ? `Couldn't set ${result.ticketId} to building${
                skippedNow
                  ? ` ${SET_BUILDING_TRIES} times, so it's skipped for this pod`
                  : ''
              }: ${result.reason}`
            : result.kind === 'dirty'
            ? dirtyReason(result.changes)
            : 'Waiting for Lambda to answer',
      }));

      return;
    }

    setBuildingFailures.delete(result.ticket.id);

    // Before the run is written: a checkout that can't be set up builds
    // nothing, and no other ticket is claimed to stop the same way.
    const prepared = await prepare(result.ticket.id).then(
      (command) => ({ command }),
      (error: unknown) => ({ error })
    );

    if ('error' in prepared) {
      await notPrepared(result.ticket, prepared.error, polledAt);

      return;
    }

    const at = new Date(deps.now()).toISOString();
    const run: BuildTicketRun = {
      id: result.ticket.id,
      title: result.ticket.title,
      step: 'pick-up',
      attempt: 1,
      startedAt: at,
      claim: 'claimed',
      announced: false,
      ...(prepared.command === null ? {} : { prepared: prepared.command }),
    };
    // The owner can end the pod while the claim and the status update are
    // on their way: ended, it gets no run, and the ticket goes back.
    const ended: { yes: boolean; projectId?: string } = { yes: false };
    const next = await store.updateBuildingAsync(podId, (latest) => {
      const pod = store.readPod(podId);

      if (pod?.status !== 'active') {
        ended.yes = true;
        ended.projectId = pod?.projectId;

        return latest;
      }

      return {
        ...latest,
        runs: [...latest.runs, run],
        upNext: result.upNext.map(({ id, title }) => ({ id, title })),
        polledAt,
        idleReason: undefined,
        stall: undefined,
      };
    });

    if (ended.yes) {
      await putBack(run.id, ended.projectId);

      return;
    }
    // A ticket's time runs from its pick-up start.
    [
      { event: 'start' as const, at },
      { event: 'done' as const, at },
    ].forEach((step) =>
      store.appendStep(podId, {
        at: step.at,
        step: 'pick-up',
        event: step.event,
        by: 'runner',
        pass: 1,
        ticket: run.id,
      })
    );
    await fetchScenarios(run.id);
    await announce(run, next);
  };

  /**
   * The pick-up command failed: the ticket goes back to Ready, the owner
   * gets an item saying what it said, and the pod is paused.
   */
  const notPrepared = async (
    ticket: Ticket,
    error: unknown,
    polledAt: string
  ): Promise<void> => {
    const pod = store.requirePod(podId);
    await putBack(ticket.id, pod.projectId);
    deps.log(
      `Couldn't set the checkout up for ${ticket.id}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    const at = new Date(deps.now()).toISOString();
    store.appendThread({
      id: newId('m'),
      podId,
      from: 'engineering-manager',
      mode: 'note',
      text: notPreparedText(ticket, error),
      expectsReply: true,
      createdAt: at,
    });
    const reason = `Lambda couldn't set the checkout up for ${ticket.id}.`;
    pauseBuilding(store, podId, reason, at);
    await store.updateBuildingAsync(podId, (latest) => ({
      ...latest,
      polledAt,
      upNext: [],
      idleReason: reason,
    }));
  };

  /**
   * What Lambda did to the checkout before this ticket, for the
   * Engineering manager: the last ticket's work set aside, and the
   * project's pick-up command.
   */
  const checkoutNotes = (
    run: BuildTicketRun,
    state: BuildingState
  ): string[] => {
    const index = state.runs.findIndex(
      (one) => one.id === run.id && one.startedAt === run.startedAt
    );
    const before = index > 0 ? state.runs[index - 1] : undefined;
    const stash = before?.blocked?.setAside;

    return [
      ...(before === undefined || stash === undefined
        ? []
        : [
            `The checkout is clean: ${before.id}'s work is set aside, not in this tree (\`git stash list\` shows "${stash}").`,
          ]),
      ...(run.prepared === undefined
        ? []
        : [`Lambda ran \`${run.prepared}\` to set the checkout up for it.`]),
    ];
  };

  /**
   * Tells the Engineering manager the ticket is picked up. Marked only once
   * it went: a send that throws is tried again on the next tick, instead of
   * leaving the manager waiting until the stall watch blocks the ticket.
   */
  const announce = async (
    run: BuildTicketRun,
    state: BuildingState
  ): Promise<void> => {
    await deps.send(
      'engineering-manager',
      pickedUpText(
        run,
        {
          n: state.runs.length,
          m: state.runs.length + state.upNext.length,
        },
        checkoutNotes(run, state)
      )
    );
    await store.updateBuildingAsync(podId, (latest) =>
      patchRun(latest, run.id, { announced: true })
    );
  };

  const tick = async (): Promise<void> => {
    const pod = store.readPod(podId);

    if (pod === null) {
      return;
    }

    await syncClaims();

    if (pod.status !== 'active') {
      return;
    }

    const state = store.readBuilding(podId);
    const current = currentRun(state);

    if (current !== null) {
      await fetchScenarios(current.id);

      if (current.announced === false) {
        await announce(current, state);
      }

      await watchStall(current);
      await watchMembership(current);

      return;
    }

    await takeNext();
  };

  return { tick };
};
