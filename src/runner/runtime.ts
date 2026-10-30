import {
  type ChildProcess,
  execFile,
  execFileSync,
  spawn,
} from 'child_process';
import * as path from 'path';

import { currentRun } from '../app/shared/building';
import type { PodIntake } from '../app/shared/snapshot';
import { buildingOnThisComputer } from '../building/lifecycle';
import type { OwnerIdentity } from '../building/owner';
import { type StartDeps, runStart, runStop } from '../commands/start';
import { lambdaHome, loadMachineConfig } from '../config/machineConfig';
import { loadProjectConfig, resolvePodsRoot } from '../config/projectConfig';
import { tmuxClientEnv } from '../desktop/bundledTools';
import {
  EVENTS_FILE,
  type WatchSource,
  eventMessage,
  scanOnce,
} from '../events/watcher';
import { lambdaBin } from '../lambdaBin';
import { randomId } from '../mothership/crypto';
import { createPodStore } from '../pod-store';
import type { Message } from '../protocol';
import type { KnownAssignees } from '../tickets/assignees';
import type { TicketSource } from '../tickets/source';
import { type WhoAmI, whoAmI } from '../tickets/whoAmI';
import { createBuildingRunner } from './building';
import type { RunnerClient } from './client';
import { makeDesignSystem, readDesignSystemPage } from './designSystemSettings';
import { diagnose } from './diagnose';
import {
  readRunnerState,
  writeKnownAssignees,
  writeRunnerState,
} from './localFiles';
import { podFileRequestOf } from './podFiles';
import {
  type LambdaCli,
  type PodHost,
  type Tmux,
  createPodHost,
} from './podHost';
import { readProcessSettings, switchProcessStep } from './processSettings';
import { linkProject } from './projectLink';
import { runSwitch } from './projectSwitch';
import { addProject, newProject } from './projectsSetup';
import { type TicketRequests, createTicketRequests } from './ticketRequests';

/**
 * Everything a runner does once connected: a pod host per project folder,
 * the answers to the mothership's requests, pod-state pushes, the folder
 * it's on (`runner-state`), and events.
 */

type Env = Record<string, string | undefined>;

/** Pod-agent env must never leak into `lambda` calls made for the app. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

// The mothership is ours: a shape check on the top-level keys is enough.
const isIntake = (value: unknown): value is PodIntake =>
  isRecord(value) && typeof value.text === 'string';

const appEnv = (env: Env): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => key !== 'POD_ID' && key !== 'POD_AGENT'
    )
  );

export const realLambda = (env: Env = process.env) => ({
  run: (
    args: string[],
    options: { cwd: string; timeoutMs?: number }
  ): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [lambdaBin(), ...args],
        {
          cwd: options.cwd,
          env: appEnv(env),
          timeout: options.timeoutMs ?? 180_000,
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            reject(new Error((stderr || stdout || error.message).trim()));

            return;
          }

          resolve(stdout.trim());
        }
      );
    }),
  spawn: (args: string[], cwd: string): ChildProcess =>
    spawn(process.execPath, [lambdaBin(), ...args], {
      cwd,
      env: appEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
});

export const realTmux: Tmux = (args) => {
  try {
    return execFileSync('tmux', args, {
      env: tmuxClientEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
};

export interface RuntimeDeps {
  /** Read when used: `lambda start` may register this computer again. */
  runnerId: string | (() => string);
  /** This computer's name, for messages. */
  computer: string;
  client: () => RunnerClient;
  makeHost: (folder: string) => PodHost;
  /** `lambda start` / `lambda stop` as the idle switch runs them. */
  startDeps: () => StartDeps;
  log: (line: string) => void;
  env?: Env;
  /** For tests: the clock `arrivedAt` is read from. */
  now?: () => number;
  /** For tests: the Tickets screen's and building pods' answers. */
  tickets?: TicketRequests;
  /** For tests: a project's tickets, for building pods' pick-up. */
  buildingSource?: (folder: string) => TicketSource;
  /** For tests: `lambda` as the app's requests and building pods run it. */
  lambda?: LambdaCli;
  /** For tests: tmux as building pods capture their panes. */
  tmux?: Tmux;
  /** For tests: the building pod this computer runs, if any. */
  building?: () => { project: string; podsRoot: string; podId: string } | null;
  /** For tests: who this computer is in its trackers. */
  whoAmI?: () => Promise<WhoAmI>;
}

export const createRuntime = (deps: RuntimeDeps) => {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const hosts = new Map<string, PodHost>();
  const lambda = deps.lambda ?? realLambda(env).run;
  const tickets =
    deps.tickets ?? createTicketRequests({ lambda, log: deps.log });
  const lastSent = new Map<string, string>();
  /**
   * Whose tickets this computer builds: the mothership's `owner` message,
   * never this computer's own config. Null until it has come.
   */
  const owner: { identity: OwnerIdentity | null } = { identity: null };
  const building = createBuildingRunner({
    runnerId: deps.runnerId,
    client: deps.client,
    lambda,
    tmux: deps.tmux ?? realTmux,
    owner: () => owner.identity,
    computer: deps.computer,
    log: deps.log,
    now,
    source: deps.buildingSource,
    isCurrent: (folder) => current.folder === folder && switching.to === null,
  });
  const current: { folder: string | null } = {
    folder: readRunnerState(env).current,
  };
  const switching: { to: string | null } = { to: null };
  /** When it arrived on `current.folder`: the idle switch counts from it. */
  const arrived: { at: number } = { at: now() };

  const reportState = (): void => {
    deps.client().enqueue(
      {
        type: 'runner-state',
        id: randomId('st'),
        folder: current.folder,
        switching: switching.to,
        arrivedAt: arrived.at,
      },
      (other) => other.type === 'runner-state'
    );
  };

  /**
   * Who this computer is in its trackers, asked of each key on every
   * connect (a changed key is noticed then): the mothership builds the
   * assignee map from every computer's answer.
   */
  const reportIdentities = async (): Promise<void> => {
    const found = await (
      deps.whoAmI ?? (() => whoAmI(loadMachineConfig(env), env))
    )();
    found.problems.forEach((problem) =>
      deps.log(`Couldn't tell who this computer is in ${problem}`)
    );
    deps.client().enqueue(
      {
        type: 'tracker-identity',
        id: randomId('who'),
        identities: found.identities,
      },
      (other) => other.type === 'tracker-identity'
    );
  };

  /** Push every pod of a folder when anything about them changed. */
  const pushState = (folder: string): void => {
    const host = hosts.get(folder);

    if (host === undefined) {
      return;
    }

    try {
      const { pods, tts } = host.snapshots();
      const body = JSON.stringify({ pods, tts });

      if (lastSent.get(folder) === body) {
        return;
      }

      lastSent.set(folder, body);
      deps.client().enqueue(
        {
          type: 'pod-state',
          id: randomId('ps'),
          folder,
          pods,
          removed: [],
          all: pods.map((snapshot) => snapshot.podId),
          tts,
        },
        // Only the newest state of a folder matters.
        (other) => other.type === 'pod-state' && other.folder === folder
      );
    } catch (error) {
      deps.log(`Couldn't read the pods in ${folder}: ${String(error)}`);
    }
  };

  const host = (folder: string): PodHost => {
    const existing = hosts.get(folder);

    if (existing !== undefined) {
      return existing;
    }

    const made = deps.makeHost(folder);
    hosts.set(folder, made);
    pushState(folder);

    return made;
  };

  const folderOf = (message: Message): string => {
    if (typeof message.folder !== 'string' || message.folder === '') {
      throw new Error('Missing "folder"');
    }

    return message.folder;
  };

  /** `pod-file`'s project: its `folder` is the pod's own folder. */
  const projectFolderOf = (message: Message): string => {
    if (
      typeof message.projectFolder !== 'string' ||
      message.projectFolder === ''
    ) {
      throw new Error('Missing "projectFolder"');
    }

    return message.projectFolder;
  };

  const intakeOf = (message: Message): PodIntake => {
    if (!isIntake(message.intake)) {
      throw new Error('Missing "intake"');
    }

    return message.intake;
  };

  const setCurrent = (folder: string | null): void => {
    if (folder !== current.folder) {
      arrived.at = now();
    }

    current.folder = folder;
    writeRunnerState({ current: folder }, env);
  };

  /** Link the folder this computer is on, then say so. */
  const linkCurrent = async (): Promise<void> => {
    const { folder } = current;

    if (folder === null) {
      reportState();

      return;
    }

    const project = loadProjectConfig(folder);

    if (project !== null && deps.client().isConnected()) {
      await linkProject(project, (message) =>
        deps.client().request(message)
      ).catch((error: unknown) =>
        deps.log(`Couldn't link ${folder}: ${String(error)}`)
      );
      host(project.root);
    }

    reportState();
  };

  /** A project this computer left: its host's watchdog must stop with it. */
  const release = (folder: string): void => {
    hosts.get(folder)?.dispose();
    hosts.delete(folder);
    lastSent.delete(folder);
  };

  const releaseAllBut = (folder: string | null): void =>
    [...hosts.keys()]
      .filter((held) => held !== folder)
      .forEach((held) => release(held));

  /** The switch in progress, so a pod for its target waits for it. */
  const running: { switch: Promise<unknown> | null } = { switch: null };

  /**
   * A switch runs `lambda stop` here, which would end this computer's
   * building pod: refused while it builds a project other than `folder`.
   * For a new pod, only while it's on a ticket: one with nothing Ready is
   * idle, and resume-all brings it back when the runner returns.
   */
  const refuseWhileBuilding = (
    folder: string,
    asking: 'pod' | 'build'
  ): void => {
    if (current.folder === folder) {
      return;
    }

    const busy = (deps.building ?? buildingOnThisComputer)();

    if (busy === null) {
      return;
    }

    if (
      asking === 'pod' &&
      currentRun(createPodStore(busy.podsRoot).readBuilding(busy.podId)) ===
        null
    ) {
      return;
    }

    const target = loadProjectConfig(folder);
    const buildingTarget =
      target !== null &&
      busy.podsRoot === resolvePodsRoot(target, env) &&
      busy.project === (target.config.name ?? path.basename(target.root));

    if (buildingTarget) {
      return;
    }

    throw new Error(
      `${deps.computer} is already building ${busy.project}. Add another computer to build two tickets at once.`
    );
  };

  /** What a request does once the runner is on its folder: answers a pod id. */
  type Arrival = (folder: string) => Promise<string>;

  /**
   * Run `arrive` on `folder`, switching the runner there first when it's on
   * another project: a new pod and a building pod both need their project
   * to be the one this computer holds.
   */
  const switchTo = async (
    folder: string,
    arrive: Arrival
  ): Promise<string | undefined> => {
    if (switching.to !== null) {
      if (switching.to !== folder) {
        throw new Error(
          `${deps.computer} is switching codebases. Try again in a minute.`
        );
      }

      await running.switch;

      return switchTo(folder, arrive);
    }

    if (current.folder === folder) {
      return arrive(folder);
    }

    const startDeps = deps.startDeps();
    const switched = runSwitch(
      {
        stop: async (from) => {
          await runStop(from, { all: false }, startDeps);
          release(from);
        },
        start: (to) => runStart(to, startDeps),
        newPod: (to, next) => next(to),
        report: (state) => {
          switching.to = state.switching;

          if (state.switching === null) {
            setCurrent(state.folder);
          }

          reportState();
        },
      },
      current.folder,
      folder,
      [arrive]
    );
    running.switch = switched.catch(() => undefined);
    const [podId] = await switched.finally(() => {
      running.switch = null;
    });

    return podId;
  };

  /**
   * `lambda pod build` there, its project held first, so tickBuilding picks
   * the pod up and watches it; then push its pods.
   */
  const startBuilding =
    (message: Message): Arrival =>
    async (folder) => {
      host(folder);
      const podId = await tickets.startBuilding(message);
      pushState(folder);

      return podId;
    };

  const handle = async (message: Message): Promise<unknown> => {
    const projectId =
      typeof message.projectId === 'string' ? message.projectId : undefined;

    switch (message.type) {
      case 'pod-new': {
        const intake = intakeOf(message);
        refuseWhileBuilding(folderOf(message), 'pod');

        return switchTo(folderOf(message), (folder) =>
          host(folder).newPod(intake, projectId)
        );
      }
      case 'pod-action':
        return host(folderOf(message)).handle(
          String(message.action),
          typeof message.podId === 'string' ? message.podId : undefined,
          isRecord(message.body) ? message.body : {}
        );
      case 'term-read':
        return host(folderOf(message)).termRead(
          String(message.podId),
          String(message.window)
        );
      case 'term-keys':
        return host(folderOf(message)).termKeys(
          String(message.podId),
          String(message.window),
          Array.isArray(message.hex) ? message.hex : []
        );
      case 'diagnose':
        return diagnose(message, {
          env,
          computer: deps.computer,
          folder: current.folder,
          podsRoot: (folder) => {
            const project = loadProjectConfig(folder);

            if (project === null) {
              throw new Error(`No lambda.json in ${folder}.`);
            }

            return resolvePodsRoot(project, env);
          },
          lambdaHome: lambdaHome(env),
        });
      case 'pod-file':
        return host(projectFolderOf(message)).podFile(
          podFileRequestOf(message)
        );
      case 'tickets-list':
        return tickets.list(message);
      case 'tracker-projects':
        return tickets.trackerProjects(message);
      case 'tracker-views':
        return tickets.trackerViews(message);
      case 'ticket-get':
        return tickets.get(message);
      case 'ticket-update':
        return tickets.update(message);
      case 'ticket-create':
        return tickets.create(message);
      case 'ticket-move':
        return tickets.move(message);
      case 'plan-more':
        return tickets.planMore(message);
      case 'ticket-talk':
        // Held, so tickBuilding puts its one-shot Product manager to sleep.
        host(folderOf(message));

        return tickets.talk(message);
      case 'building-start':
        refuseWhileBuilding(folderOf(message), 'build');

        return switchTo(folderOf(message), startBuilding(message));
      case 'process-read':
        return readProcessSettings(folderOf(message));
      case 'process-switch':
        return switchProcessStep(
          folderOf(message),
          String(message.process),
          String(message.step),
          message.on === true
        );
      case 'design-system-read':
        return readDesignSystemPage(folderOf(message));
      case 'design-system-make':
        return makeDesignSystem(
          folderOf(message),
          typeof message.by === 'string' && message.by !== ''
            ? message.by
            : deps.computer
        );
      case 'project-add':
        return addProject({
          typed: String(message.folder ?? ''),
          known: Array.isArray(message.known) ? message.known.map(String) : [],
          computer: deps.computer,
        });
      case 'project-new':
        return newProject({ name: String(message.name ?? '') });
      default:
        throw new Error(`Unknown request "${message.type}".`);
    }
  };

  /** One events pass over every folder this runner holds. */
  const scanEvents = (cursorFile: string): void =>
    hosts.forEach((folderHost, folder) => {
      const worktrees = folderHost.worktrees();
      const active = new Set(worktrees.map(({ podId }) => podId));
      const sources: WatchSource[] = [
        { file: path.join(folder, EVENTS_FILE), kind: 'events' },
        ...worktrees.map(({ podId, path: worktree }) => ({
          file: path.join(worktree, EVENTS_FILE),
          kind: 'events' as const,
          pod: podId,
        })),
        // A pod that isn't active writes no steps: read once to its end.
        ...folderHost.store.listPodIds().map((podId) => ({
          file: folderHost.store.file(podId, 'steps.jsonl'),
          kind: 'steps' as const,
          pod: podId,
          settled: !active.has(podId),
        })),
      ];
      scanOnce({
        runnerId:
          typeof deps.runnerId === 'string' ? deps.runnerId : deps.runnerId(),
        sources,
        cursorFile,
        store: folderHost.store,
        send: (id, event, generation) =>
          deps.client().enqueue({
            type: 'event',
            ...eventMessage(id, generation),
            folder,
            event,
          }),
      });
    });

  return {
    handle,
    host,
    hosts,
    pushState,
    linkCurrent,
    /** Is this the folder the computer is on? A pod host's watchdog asks. */
    isCurrent: (folder: string): boolean =>
      current.folder === folder && switching.to === null,
    scanEvents,
    /** Did `lambda start` (or a switch) move this computer to another folder? */
    pollCurrent: async (): Promise<void> => {
      const next = readRunnerState(env).current;

      if (next !== current.folder && switching.to === null) {
        current.folder = next;
        arrived.at = now();
        // `lambda stop` (or a start elsewhere) left these projects.
        releaseAllBut(next);
        await linkCurrent();
      }
    },
    /** On (re)connect: fresh state for every folder, and where it is. */
    onConnected: async (): Promise<void> => {
      lastSent.clear();
      await linkCurrent();
      hosts.forEach((_host, folder) => pushState(folder));
      await reportIdentities();
    },
    /**
     * The mothership's `owner` message: kept in memory for pick-up, and its
     * assignee map on disk, for every ticket source on this computer.
     */
    setOwner: (identity: OwnerIdentity, known?: KnownAssignees): void => {
      owner.identity = identity;

      if (known !== undefined) {
        writeKnownAssignees(known, env);
      }
    },
    /** Every building pod of every project held: claims, pick-up, stalls. */
    tickBuilding: (): Promise<void> => building.tick(hosts),
    cursorFile: () => path.join(lambdaHome(env), 'events-cursor.json'),
    dispose: () => hosts.forEach((folderHost) => folderHost.dispose()),
  };
};
