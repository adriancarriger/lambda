/**
 * `lambda ship <id>`: always the built-in. The verdict gate runs first and
 * refuses a ticket without a COMPLETE check-ticket verdict — or, for a ticket
 * with a design, without a passing visual check — running nothing.
 * Then the project's own `commands.ship`, with `{spec}` as the shell-quoted
 * ticket id; with none, Lambda's default ship: the project's tests, then one
 * `<id>: <title>` commit on the branch it has checked out (never pushed).
 * The default ship also moves the screenshot scenarios the ticket brought
 * (`<design.pendingDir>/<id>/`) into the tracked library, add-only; a
 * project's own ship command leaves that folder to the project.
 *
 * A ship that worked stamps the building pod's run shipped (the runner tells
 * the mothership, so the claim is kept for good) and marks the ticket done.
 * A ticket in an open shipping-together group is marked done when its group
 * ships, not now.
 */
import { execFileSync } from 'child_process';
import { type Command } from 'commander';
import * as path from 'path';

import { currentRun } from '../app/shared/building';
import { fillCommandTemplate } from '../commands/e2e';
import { recordEvent } from '../commands/event';
import { loadMachineConfig } from '../config/machineConfig';
import {
  type Project,
  loadProjectConfig,
  resolvePodsRoot,
} from '../config/projectConfig';
import { EVENTS_FILE } from '../events/watcher';
import { type BuildTicketRun, createPodStore, podKindOf } from '../pod-store';
import {
  discardPending,
  moveScenariosForShip,
  undoScenarioMove,
} from '../shot/pending';
import { openTicketSource } from '../tickets/context';
import { type TicketSource, assertTicketId } from '../tickets/source';
import { runInherited } from '../utils/run';
import {
  describeRefusal,
  describeVisualRefusal,
  needsVisualRecord,
} from '../verdict/gate';
import { readVerdict } from '../verdict/store';
import { readVisualVerdict } from '../verdict/visualStore';
import { uncommittedWork } from './blocked';
import { projectGroups } from './groups';
import { buildingStepIds } from './workflow';

type Env = Record<string, string | undefined>;

export interface ShipDeps {
  project: Project;
  tickets: TicketSource;
  env: Env;
  /** A command through the shell, its output shown as it runs. */
  runShell: (command: string, cwd: string) => Promise<number>;
  print: (line: string) => void;
  printError: (line: string) => void;
  now?: () => string;
}

export const NOT_A_GIT_REPO =
  "This folder isn't a git repository, so Lambda can't ship it. Add a `ship` command to lambda.json.";
export const TESTS_FAILED = 'Tests failed, so nothing was shipped.';
export const NOTHING_CHANGED = "Nothing changed, so there's nothing to ship.";

/** The events file holds what this ship reports: it is never committed. */
const NEVER_COMMITTED = `:(exclude)${EVENTS_FILE}`;

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const isGitRepo = (cwd: string): boolean => {
  try {
    return git(cwd, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    return false;
  }
};

/** Anything staged? (`git diff --cached --quiet` exits 1 when there is.) */
const hasStaged = (cwd: string): boolean => {
  try {
    git(cwd, ['diff', '--cached', '--quiet']);

    return false;
  } catch {
    return true;
  }
};

/** Is this path ignored? (`git check-ignore -q` exits 1 when it isn't.) */
const isIgnored = (cwd: string, file: string): boolean => {
  try {
    git(cwd, ['check-ignore', '-q', file]);

    return true;
  } catch {
    return false;
  }
};

/**
 * Every change, except the events file. `lambda init` already ignores it;
 * naming an ignored path in a pathspec is refused, so it's only excluded
 * by name when the project doesn't ignore it.
 */
const stageAll = (cwd: string): void => {
  git(cwd, [
    'add',
    '-A',
    ...(isIgnored(cwd, EVENTS_FILE) ? [] : ['--', '.', NEVER_COMMITTED]),
  ]);
};

/** Every building pod still going, with the ticket it's building now. */
const buildingRuns = (
  project: Project,
  env: Env
): { podId: string; run: BuildTicketRun }[] => {
  const store = createPodStore(resolvePodsRoot(project, env));

  return store
    .listPodIds()
    .map((podId) => store.readPod(podId))
    .flatMap((pod) => {
      if (
        pod === null ||
        podKindOf(pod) !== 'building' ||
        pod.status === 'done'
      ) {
        return [];
      }

      const run = currentRun(store.readBuilding(pod.id));

      return run === null ? [] : [{ podId: pod.id, run }];
    });
};

/**
 * A building pod that stopped on this ticket: its last run, blocked. Blocked
 * isn't current, so without this a pod with nothing else to build would let
 * the ticket through as one shipped by hand.
 */
const blockedIn = (
  project: Project,
  env: Env,
  ticketId: string
): { podId: string; problem: string } | null => {
  const store = createPodStore(resolvePodsRoot(project, env));

  return (
    store.listPodIds().flatMap((podId) => {
      const pod = store.readPod(podId);

      if (
        pod === null ||
        podKindOf(pod) !== 'building' ||
        pod.status === 'done'
      ) {
        return [];
      }

      const last = store.readBuilding(pod.id).runs.at(-1);

      return last?.id === ticketId && last.blocked !== undefined
        ? [{ podId: pod.id, problem: last.blocked.problem }]
        : [];
    })[0] ?? null
  );
};

export const COMMIT_FAILED = 'The commit failed, so nothing was shipped.';

/** What git said when the commit failed (a hook's own output included). */
const gitFailure = (error: unknown): string => {
  const said =
    typeof error === 'object' && error !== null && 'stderr' in error
      ? String(error.stderr)
      : error instanceof Error
      ? error.message
      : String(error);

  return said.trim();
};

const markRunShipped = (
  project: Project,
  env: Env,
  podId: string,
  ticketId: string,
  attempt: number,
  at: string
): void => {
  const store = createPodStore(resolvePodsRoot(project, env));
  // Once stamped the run is no longer current, so `lambda pod step ship done`
  // can't find it: the ship step is closed here, where the ticket's time ends.
  store.appendStep(podId, {
    at,
    step: 'ship',
    event: 'done',
    by: 'ship',
    pass: attempt,
    ticket: ticketId,
  });
  store.updateBuilding(podId, (state) => ({
    ...state,
    runs: state.runs.map((run) =>
      run.id === ticketId &&
      run.shippedAt === undefined &&
      run.blocked === undefined
        ? { ...run, shippedAt: at }
        : run
    ),
  }));
};

export const runShip = async (
  rawId: string,
  deps: ShipDeps
): Promise<number> => {
  const ticketId = assertTicketId(rawId.trim());
  const { project, env } = deps;
  const { root } = project;
  const now = deps.now ?? (() => new Date().toISOString());
  // A ticket that can't be read refuses: it is never taken as "no design".
  const read = await deps.tickets.get(ticketId).then(
    (found) => ({ found }),
    (error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    })
  );

  if ('error' in read) {
    deps.printError(
      `✗ ${ticketId}: the ticket couldn't be read (${read.error}).`
    );

    return 1;
  }

  const ticket = read.found;
  // Every reason it can't ship, in one refusal.
  const refusals = [
    describeRefusal(ticket, readVerdict(root, ticketId)),
    needsVisualRecord({
      stepOn: buildingStepIds(root).includes('visual-check'),
      hasPhotoHook: project.config.commands?.shot !== undefined,
      description: ticket.description,
    })
      ? describeVisualRefusal(ticket, readVisualVerdict(root, ticketId))
      : null,
  ].flatMap((lines) => lines ?? []);

  if (refusals.length > 0) {
    refusals.forEach((line) => deps.printError(line));

    return 1;
  }

  // A verdict is never stale-checked, so a ticket shipped once, or one a
  // building pod has moved on from, is refused here: its tree holds the
  // pod's current ticket's work, which a commit would ship under this id.
  if (ticket.status === 'done') {
    deps.printError(
      `✗ ${ticketId} is already done, so it was not shipped again.`
    );

    return 1;
  }

  const blocked = blockedIn(project, env, ticketId);

  if (blocked !== null) {
    deps.printError(
      `✗ ${ticketId} is blocked in building pod ${blocked.podId}, so it was not shipped: ${blocked.problem}`
    );

    return 1;
  }

  const runs = buildingRuns(project, env);
  const found = runs.find((each) => each.run.id === ticketId);

  if (found === undefined && runs.length > 0) {
    deps.printError(
      `✗ ${ticketId} isn't the ticket a building pod is on now (${runs
        .map((each) => each.run.id)
        .join(', ')}), so it was not shipped.`
    );

    return 1;
  }

  const run =
    found === undefined
      ? null
      : { podId: found.podId, attempt: found.run.attempt };
  const tag = { ticket: ticketId, attempt: String(run?.attempt ?? 1) };
  const report = (type: string, extra: { name?: string; result?: string }) =>
    recordEvent(root, type, { ...tag, ...extra }, env, now);
  // A part that throws still ends its stage and the ship, failed: else the
  // app's ship window stays open for ever. The error still goes up.
  const stage = async <T>(name: string, part: () => Promise<T> | T) => {
    report('stage.start', { name });
    const result = await Promise.resolve()
      .then(part)
      .catch((error: unknown) => {
        report('stage.end', { name, result: 'fail' });

        throw error;
      });
    report('stage.end', { name });

    return result;
  };
  const end = (code: number): number => {
    report('ship.end', { result: code === 0 ? 'pass' : 'fail' });

    return code;
  };
  const shipping = async (body: () => Promise<number>): Promise<number> => {
    report('ship.start', {});

    return body().catch((error: unknown) => {
      end(1);

      throw error;
    });
  };

  /** The ticket done, unless it ships with a group (done when that ships). */
  const markDone = async (): Promise<void> => {
    if (projectGroups(root).groupOf(ticketId) === undefined) {
      await deps.tickets.update(ticketId, { status: 'done' });
    }
  };

  /** Shipped: the run (and so its claim) stamped, once the change is in. */
  const stampShipped = (): void => {
    if (run !== null) {
      markRunShipped(project, env, run.podId, ticketId, run.attempt, now());
    }
  };

  /**
   * The project's ship command went out: that is the ship, whatever the
   * tracker says next. A ticket that can't be marked done is said loudly,
   * never reported as a failed ship, which would invite a second one.
   */
  const shipped = async (): Promise<void> => {
    stampShipped();
    await markDone().catch((error: unknown) =>
      deps.printError(
        `${ticketId} shipped, but it couldn't be marked done: ${
          error instanceof Error ? error.message : String(error)
        }. Set it done by hand.`
      )
    );
  };

  /** Lambda's default ship: the project's tests, then one commit. */
  const defaultShip = async (): Promise<number> => {
    const testCommand = project.config.commands?.test;

    if (testCommand !== undefined) {
      const code = await stage('test', () => deps.runShell(testCommand, root));

      if (code !== 0) {
        deps.printError(TESTS_FAILED);

        return end(1);
      }
    }

    const committed = await stage(
      'commit',
      async (): Promise<'committed' | 'nothing' | { failed: string }> => {
        // The screenshot scenarios the ticket brought go into the library
        // with its work (they can be all it changed); taken out again if
        // nothing ships.
        const scenarios = moveScenariosForShip(
          project,
          root,
          ticketId,
          (line) => deps.print(line)
        );
        // Never throws: it runs on the way out of a failure, and the files
        // come off disk even when git can't unstage them (that is said).
        const takeScenariosBack = (): void => {
          if (scenarios.added.length === 0) {
            return;
          }

          const files = scenarios.added.map((file) =>
            path.relative(root, file)
          );

          try {
            git(root, [
              'rm',
              '--cached',
              '-q',
              '--ignore-unmatch',
              '--',
              ...files,
            ]);
          } catch (error) {
            deps.printError(
              `Scenarios: couldn't unstage ${files.join(', ')} (${gitFailure(
                error
              )}). Run \`git rm --cached -- ${files.join(' ')}\`.`
            );
          } finally {
            undoScenarioMove(scenarios.added);
          }
        };
        const landed = (): void => {
          if (!scenarios.failed) {
            discardPending(project, root, ticketId);
          }
        };

        // The ticket files pick-up wrote don't count as work.
        if (uncommittedWork(root).length === 0) {
          takeScenariosBack();

          return 'nothing';
        }

        try {
          stageAll(root);
        } catch (error) {
          takeScenariosBack();

          throw error;
        }

        if (!hasStaged(root)) {
          takeScenariosBack();

          return 'nothing';
        }

        const before = ticket.status;
        // A project whose tickets live in its own files: done first, so the
        // ticket is committed as done with its work. A tracker's ticket is
        // marked done only once the commit exists.
        const inFiles = deps.tickets.kind === 'markdown';

        if (inFiles) {
          try {
            await markDone();
          } catch (error) {
            // Nothing shipped: the scenarios go back out with it.
            takeScenariosBack();

            throw error;
          }

          try {
            stageAll(root);
          } catch (error) {
            // Nothing shipped: the ticket as it was, the scenarios back out.
            await deps.tickets.update(ticketId, { status: before });
            takeScenariosBack();

            throw error;
          }
        }

        try {
          // argv, never a shell: titles come from the tracker.
          git(root, ['commit', '-q', '-m', `${ticketId}: ${ticket.title}`]);
        } catch (error) {
          // Nothing shipped: the ticket as it was first, its claim kept.
          if (inFiles) {
            await deps.tickets.update(ticketId, { status: before });
          }

          takeScenariosBack();

          return { failed: gitFailure(error) };
        }

        landed();

        if (!inFiles) {
          await shipped();

          return 'committed';
        }

        stampShipped();

        return 'committed';
      }
    );

    if (committed === 'nothing') {
      deps.printError(NOTHING_CHANGED);

      return end(1);
    }

    if (committed !== 'committed') {
      if (committed.failed !== '') {
        deps.printError(committed.failed);
      }

      deps.printError(COMMIT_FAILED);

      return end(1);
    }

    deps.print(`✓ ${ticketId} shipped: ${ticket.title}`);

    return end(0);
  };

  const projectShip = project.config.commands?.ship;

  if (projectShip !== undefined) {
    return shipping(async () => {
      const code = await deps.runShell(
        fillCommandTemplate(projectShip, [ticketId]),
        root
      );

      if (code !== 0) {
        deps.printError(`The codebase's ship command failed (exit ${code}).`);

        return end(1);
      }

      await shipped();
      deps.print(`✓ ${ticketId} shipped: ${ticket.title}`);

      return end(0);
    });
  }

  if (!isGitRepo(root)) {
    deps.printError(NOT_A_GIT_REPO);

    return 1;
  }

  return shipping(defaultShip);
};

const loadDeps = (): ShipDeps => {
  const project = loadProjectConfig(process.cwd());

  if (project === null) {
    throw new Error('No codebase here: run lambda init first.');
  }

  return {
    project,
    tickets: openTicketSource(project, loadMachineConfig()),
    env: process.env,
    runShell: (command, cwd) => runInherited(command, [], { cwd, shell: true }),
    print: (line) => console.log(line),
    printError: (line) => console.error(line),
  };
};

export const registerShipCommand = (
  program: Command,
  deps: () => ShipDeps = loadDeps
): void => {
  program
    .command('ship <ticket-id>')
    .description(
      "Ship a ticket behind its check-ticket verdict: the codebase's ship command, or one commit"
    )
    .action(async (ticketId: string) => {
      process.exitCode = await runShip(ticketId, deps());
    });
};
