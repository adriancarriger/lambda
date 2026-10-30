import { execFileSync } from 'child_process';
import { type Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';

import { POD_WINDOW_FORMAT, podWindowsOf } from '../../building/windows';
import { lambdaHome, loadMachineConfig } from '../../config/machineConfig';
import {
  type Project,
  SCRATCH_WINDOW,
  loadProjectConfig,
  resolvePodsRoot,
} from '../../config/projectConfig';
import { appWindowEnv, tmuxClientEnv } from '../../desktop/bundledTools';
import { lambdaBin } from '../../lambdaBin';
import { mothershipDbPath, openDb } from '../../mothership/db';
import { mothershipPort } from '../../mothership/loginLink';
import { linkProject } from '../../mothership/registry';
import { createPodStore } from '../../pod-store';
import { podSessionOf } from '../../pod/context';
import { computerName, ensureHostRunner } from '../../runner/hostRunner';
import { readRunnerState, writeRunnerState } from '../../runner/localFiles';
import {
  type Processes,
  createProcesses,
  hostsMothership,
  runnerConnected,
  waitForMothership,
} from '../../runner/processes';
import { projectIdentity } from '../../runner/projectsSetup';
import { resumeStep } from '../../setup/firstRun';
import { podSession } from '../tmux';
import { runShellCommand } from './shell';

/**
 * `lambda start`: the project's services, each in its own tmux window, then
 * this computer's runner (and, on the computer running Lambda, the
 * mothership), then the project's pods. `lambda stop`: the services start
 * opened and the project's pods' tmux sessions; `--all` also stops the
 * runner and the mothership.
 */

type Env = Record<string, string | undefined>;

/** Runs tmux; answers its output, or null when it failed. */
export type TmuxRun = (args: string[]) => string | null;

export interface StartDeps {
  tmux: TmuxRun;
  processes: Processes;
  hostsMothership: boolean;
  /** On the host: register this computer's runner and link the folder, through the database file. */
  linkOnHost: (project: Project) => void;
  /** The folder this computer is on, for its runner to report and link. */
  writeCurrent: (folder: string) => void;
  /** Stopped: if this computer was on that folder, it's on none now. */
  clearCurrent: (folder: string) => void;
  /** Did the mothership come up (the host only)? Answers its failure line when not. */
  waitForMothership: () => Promise<string | null>;
  /** Is the runner connected yet? */
  waitForConnected: () => Promise<boolean>;
  resumeAll: (folder: string) => Promise<void>;
  /** `commands.stop`. */
  runShell: (command: string, cwd: string) => Promise<void>;
  print: (line: string) => void;
  port: number;
  /** `~/.lambda/started-windows.json`. */
  startedFile: string;
  /** Where this computer's `~/.lambda` is: first run's state is read from it. */
  env: Env;
}

/** Printed by `lambda start` until first run is done. */
export const FINISH_SETUP = 'Finish setup in your browser: lambda open';

const NO_PROJECT = "There's no lambda.json here. Run lambda init first.";

/** `commands.services`, else `app.start` as a `web` window. */
export const projectServices = (project: Project): Record<string, string> => {
  const services = project.config.commands?.services;

  if (services !== undefined) {
    return services;
  }

  const start = project.config.app?.start;

  return start === undefined ? {} : { web: start };
};

type Started = Record<string, { session: string; windows: string[] }>;

const readStarted = (file: string): Started => {
  try {
    const started: Started = JSON.parse(fs.readFileSync(file, 'utf8'));

    return started;
  } catch {
    return {};
  }
};

const writeStarted = (file: string, started: Started): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(started, null, 2)}\n`, {
    mode: 0o600,
  });
};

const windowsIn = (tmux: TmuxRun, session: string): string[] | null => {
  const out = tmux([
    'list-windows',
    '-t',
    `=${session}`,
    '-F',
    '#{window_name}',
  ]);

  return out === null ? null : out.split('\n').filter((name) => name !== '');
};

const requireProject = (folder: string): Project => {
  const project = loadProjectConfig(folder);

  if (project === null) {
    throw new Error(NO_PROJECT);
  }

  return project;
};

/** The mothership (on the host) and this computer's runner. */
const startLambda = async (deps: StartDeps): Promise<void> => {
  if (deps.hostsMothership) {
    if (!deps.processes.isRunning('mothership')) {
      deps.processes.start('mothership');
    }

    const failure = await deps.waitForMothership();

    if (failure !== null) {
      throw new Error(failure);
    }
  }

  if (!deps.processes.isRunning('runner')) {
    deps.processes.start('runner');
  }
};

const printLambdaLines = async (deps: StartDeps): Promise<void> => {
  deps.print(
    (await deps.waitForConnected())
      ? `✓ ${'computer'.padEnd(12)} connected`
      : `… ${'computer'.padEnd(12)} connecting`
  );

  if (deps.hostsMothership) {
    deps.print(`✓ ${'Lambda server'.padEnd(12)} http://127.0.0.1:${deps.port}`);
  }

  // Until first run is done (`firstRun` in ~/.lambda/config.json).
  if (resumeStep(loadMachineConfig(deps.env), deps.env) !== null) {
    deps.print(FINISH_SETUP);
  }
};

/**
 * `lambda start` outside any project (the Mac app runs it from the home
 * folder, before setup has made one): only Lambda itself, on the computer
 * running it. Anywhere else a project is needed, as before.
 */
const startWithoutProject = async (deps: StartDeps): Promise<void> => {
  if (!deps.hostsMothership) {
    throw new Error(NO_PROJECT);
  }

  await startLambda(deps);
  await printLambdaLines(deps);
};

/**
 * Bring up the project's services, and a scratchPad shell; adopt any window
 * already open.
 */
export const startServices = (
  project: Project,
  deps: Pick<StartDeps, 'tmux' | 'startedFile' | 'env'>
): { opened: string[]; adopted: string[]; failed: string[] } => {
  const { session } = project.config.tmux;
  const services = projectServices(project);
  // No command: tmux opens the person's own shell, in the project folder.
  const windows: [string, string | null][] = [
    ...Object.entries(services),
    ...(SCRATCH_WINDOW in services
      ? []
      : [[SCRATCH_WINDOW, null] satisfies [string, null]]),
  ];
  const existing = windowsIn(deps.tmux, session);
  const adopted = windows
    .map(([name]) => name)
    .filter((name) => existing?.includes(name));
  const toOpen = windows.filter(([name]) => !adopted.includes(name));

  // Each window in turn; a failed new-session leaves no session to add to.
  const tried = toOpen.reduce<{
    hasSession: boolean;
    opened: string[];
    failed: string[];
  }>(
    (so, [name, command]) => {
      const out = deps.tmux(
        so.hasSession
          ? [
              'new-window',
              '-d',
              '-t',
              `=${session}:`,
              '-n',
              name,
              '-c',
              project.root,
              ...appWindowEnv(deps.env),
              ...(command === null ? [] : [command]),
            ]
          : [
              'new-session',
              '-d',
              '-s',
              session,
              '-n',
              name,
              '-c',
              project.root,
              ...appWindowEnv(deps.env),
              ...(command === null ? [] : [command]),
            ]
      );

      return out === null
        ? { ...so, failed: [...so.failed, name] }
        : { ...so, hasSession: true, opened: [...so.opened, name] };
    },
    { hasSession: existing !== null, opened: [], failed: [] }
  );

  const { opened, failed } = tried;
  const started = readStarted(deps.startedFile);
  const previous = started[project.root]?.windows ?? [];
  writeStarted(deps.startedFile, {
    ...started,
    [project.root]: {
      session,
      // Still ours if an earlier start opened it and it's still open.
      windows: [
        ...new Set([
          ...previous.filter((name) => adopted.includes(name)),
          ...opened,
        ]),
      ],
    },
  });

  return { opened, adopted, failed };
};

export const runStart = async (
  folder: string,
  deps: StartDeps
): Promise<void> => {
  const project = loadProjectConfig(folder);

  if (project === null) {
    await startWithoutProject(deps);

    return;
  }

  const services = projectServices(project);
  const { failed } = startServices(project, deps);
  Object.keys(services).forEach((name) =>
    deps.print(
      failed.includes(name)
        ? `✗ ${name.padEnd(12)} didn't start`
        : `✓ ${name.padEnd(12)} ${
            name === 'web' && project.config.app?.url !== undefined
              ? project.config.app.url
              : 'running'
          }`
    )
  );

  if (deps.hostsMothership) {
    if (!deps.processes.isRunning('mothership')) {
      deps.processes.start('mothership');
    }

    const failure = await deps.waitForMothership();

    if (failure !== null) {
      throw new Error(failure);
    }

    deps.linkOnHost(project);
  }

  deps.writeCurrent(project.root);

  if (!deps.processes.isRunning('runner')) {
    deps.processes.start('runner');
  }

  await printLambdaLines(deps);
  await deps.resumeAll(project.root);
};

/**
 * The project's pods that are open, and how each is closed: its own session
 * (`lambda-pod-<id>`) ended, or — a building pod in the project's explicit
 * `tmux.session` — only its own windows, so the session and the project's
 * other windows stay.
 */
interface OpenPod {
  session: string;
  /** Its own windows in a shared session; null: the whole session is its. */
  windows: string[] | null;
}

const openPods = (
  project: Project,
  tmux: TmuxRun,
  print: (line: string) => void
): OpenPod[] => {
  const open = (tmux(['list-sessions', '-F', '#{session_name}']) ?? '')
    .split('\n')
    .filter((name) => name !== '');
  const store = createPodStore(resolvePodsRoot(project));
  /**
   * A record that can't be read (bad JSON, an old shape) never stops the
   * rest: that pod's own session is ended, since its record can't say it
   * sits in a shared one.
   */
  const readable = (podId: string) => {
    try {
      return { kind: 'read' as const, pod: store.readPod(podId) };
    } catch (error) {
      const session = podSession(podId);

      if (open.includes(session)) {
        print(
          `✗ Couldn't read pod ${podId} (${
            error instanceof Error ? error.message : String(error)
          }): ending its session ${session}`
        );
      }

      return { kind: 'unreadable' as const, session };
    }
  };
  const found = store.listPodIds().flatMap((podId): OpenPod[] => {
    const read = readable(podId);

    if (read.kind === 'unreadable') {
      return open.includes(read.session)
        ? [{ session: read.session, windows: null }]
        : [];
    }

    const { pod } = read;

    // An ended pod's windows in a shared session are gone; only its own
    // session can linger (a `pod done` whose kill failed).
    if (
      pod === null ||
      (pod.status === 'done' && pod.tmuxSession !== undefined)
    ) {
      return [];
    }

    const session = podSessionOf(pod);

    if (!open.includes(session)) {
      return [];
    }

    if (pod.tmuxSession === undefined) {
      return [{ session, windows: null }];
    }

    const listing = tmux([
      'list-windows',
      '-t',
      `=${session}`,
      '-F',
      POD_WINDOW_FORMAT,
    ]);
    const windows = podWindowsOf(listing ?? '', pod.id);

    return windows.length === 0 ? [] : [{ session, windows }];
  });

  // One entry per session: two pods' records naming it are closed once.
  return [...new Set(found.map((one) => one.session))].map((session) => {
    const its = found.filter((one) => one.session === session);

    return its.some((one) => one.windows === null)
      ? { session, windows: null }
      : {
          session,
          windows: [...new Set(its.flatMap((one) => one.windows ?? []))],
        };
  });
};

/**
 * Stop the project: `commands.stop` if set, else close the service windows
 * `lambda start` opened (an adopted one keeps running); then end the pods'
 * tmux sessions, leaving each pod `active` so the next start resumes it.
 * Ticket claims are never released here.
 */
export const runStop = async (
  folder: string,
  options: { all: boolean },
  deps: StartDeps
): Promise<void> => {
  if (options.all && loadProjectConfig(folder) === null) {
    stopLambda(deps);

    return;
  }

  const project = requireProject(folder);
  const started = readStarted(deps.startedFile);
  const mine = started[project.root];
  const stopCommand = project.config.commands?.stop;
  const closed = stopCommand === undefined ? mine?.windows ?? [] : [];

  if (stopCommand !== undefined) {
    await deps.runShell(stopCommand, project.root);
  } else {
    closed.forEach((name) => {
      deps.tmux([
        'kill-window',
        '-t',
        // `=name`: exactly this window, never one whose name starts the same.
        `=${mine?.session ?? project.config.tmux.session}:=${name}`,
      ]);
    });
  }

  const { [project.root]: _done, ...rest } = started;
  writeStarted(deps.startedFile, rest);

  const pods = openPods(project, deps.tmux, deps.print);
  pods.forEach(({ session, windows }) => {
    if (windows === null) {
      deps.tmux(['kill-session', '-t', `=${session}`]);

      return;
    }

    windows.forEach((name) =>
      deps.tmux(['kill-window', '-t', `=${session}:=${name}`])
    );
  });
  deps.clearCurrent(project.root);

  if (options.all) {
    deps.processes.stop('runner');

    if (deps.hostsMothership) {
      deps.processes.stop('mothership');
    }
  }

  const parts = [
    ...(stopCommand === undefined ? closed : ['the services']),
    ...(pods.length === 0
      ? []
      : [`${pods.length} ${pods.length === 1 ? 'Lambda' : 'Lambdas'}`]),
  ];
  deps.print(
    parts.length === 0
      ? '✓ Nothing was running'
      : `✓ Stopped ${
          parts.length === 1
            ? parts[0]
            : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
        }`
  );

  if (options.all) {
    deps.print(
      `✓ Stopped this computer's runner${
        deps.hostsMothership ? ' and the Lambda server' : ''
      }`
    );
  }
};

/** `lambda stop --all` outside any project: just the runner and the mothership. */
const stopLambda = (deps: StartDeps): void => {
  deps.processes.stop('runner');

  if (deps.hostsMothership) {
    deps.processes.stop('mothership');
  }

  deps.print(
    `✓ Stopped this computer's runner${
      deps.hostsMothership ? ' and the Lambda server' : ''
    }`
  );
};

const realTmux: TmuxRun = (args) => {
  try {
    return execFileSync('tmux', args, {
      env: tmuxClientEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
};

const lastLine = (file: string): string | null => {
  try {
    return (
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .at(-1) ?? null
    );
  } catch {
    return null;
  }
};

/** How long a just-started mothership has to write its pid file. */
const STARTING_GRACE_MS = 2000;

/**
 * Did the mothership come up? `null` when it answers as itself; otherwise
 * the line it died with (`~/.lambda/mothership.log`: a port in use, say),
 * so `lambda start` reports that line and exits 1. Another server answering
 * on the port is not it.
 */
export const mothershipUp = async (options: {
  port: number;
  home: string;
  isRunning: () => boolean;
  timeoutMs?: number;
}): Promise<string | null> => {
  const started = Date.now();
  const up = await waitForMothership(
    options.port,
    options.timeoutMs,
    () => Date.now() - started > STARTING_GRACE_MS && !options.isRunning()
  );

  return up
    ? null
    : lastLine(path.join(options.home, 'mothership.log')) ??
        `Lambda's server didn't start on 127.0.0.1:${options.port}.`;
};

/** The real thing: this computer's tmux, processes and files. */
export const realStartDeps = (env: Env = process.env): StartDeps => {
  const config = loadMachineConfig(env);
  const port = mothershipPort(config?.mothership?.port);
  const home = lambdaHome(env);

  return {
    tmux: realTmux,
    processes: createProcesses(env),
    hostsMothership: hostsMothership(config, env),
    linkOnHost: (project) => {
      const db = openDb(mothershipDbPath(env));

      try {
        const runnerId = ensureHostRunner(db, {
          name: computerName(),
          now: Date.now(),
          env,
        });
        const identity = projectIdentity(project);
        linkProject(
          db,
          { runnerId, folder: project.root, ...identity },
          Date.now()
        );
      } finally {
        db.close();
      }
    },
    writeCurrent: (folder) => writeRunnerState({ current: folder }, env),
    clearCurrent: (folder) => {
      if (readRunnerState(env).current === folder) {
        writeRunnerState({ current: null }, env);
      }
    },
    waitForMothership: () =>
      mothershipUp({
        port,
        home,
        isRunning: () => createProcesses(env).isRunning('mothership'),
      }),
    waitForConnected: async () => {
      const deadline = Date.now() + 10_000;
      const check = async (): Promise<boolean> => {
        if (runnerConnected(env)) {
          return true;
        }

        if (Date.now() > deadline) {
          return false;
        }

        await new Promise((resolve) => setTimeout(resolve, 250));

        return check();
      };

      return check();
    },
    resumeAll: async (folder) => {
      execFileSync(process.execPath, [lambdaBin(), 'pod', 'resume-all'], {
        cwd: folder,
        stdio: 'inherit',
      });
    },
    runShell: (command, cwd) =>
      runShellCommand(command, cwd, { stdio: 'inherit' }),
    print: (line) => console.log(line),
    port,
    startedFile: path.join(home, 'started-windows.json'),
    env,
  };
};

export const registerStartCommand = (program: Command): void => {
  program
    .command('start')
    .description(
      "Start this codebase's services, this computer's runner and Lambda"
    )
    .action(async () => {
      await runStart(process.cwd(), realStartDeps());
    });
};

export const registerStopCommand = (program: Command): void => {
  program
    .command('stop')
    .description("Stop this codebase's services and its pods' sessions")
    .option('--all', "Also stop this computer's runner and the Lambda server")
    .action(async (options: { all?: boolean }) => {
      await runStop(
        process.cwd(),
        { all: options.all === true },
        realStartDeps()
      );
    });
};
