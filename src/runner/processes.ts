import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  type MachineConfig,
  lambdaHome,
  resolveMothershipUrl,
} from '../config/machineConfig';
import { appBundle } from '../desktop/appPaths';
import { appWindowEnv, tmuxClientEnv } from '../desktop/bundledTools';
import { mothershipPort } from '../mothership/loginLink';
import {
  MOTHERSHIP_HEADER,
  MOTHERSHIP_HEADER_VALUE,
} from '../mothership/server';
import { readRunnerStatus } from './localFiles';
import { type ServiceControl, createServiceControl } from './service';

/**
 * The two long-running Lambda processes on a computer: the runner, and on
 * the computer running Lambda the mothership. A joined computer's runner is
 * a login service (`lambda join` installs it); otherwise each runs in a
 * window of the `lambda-system` tmux session. Each writes its pid to
 * `~/.lambda/<name>.pid`.
 */

export type ProcessName = 'mothership' | 'runner';

export const SYSTEM_SESSION = 'lambda-system';

type Env = Record<string, string | undefined>;

/**
 * This computer runs the mothership when `mothership.url` (after
 * `LAMBDA_URL`) is unset or points at 127.0.0.1 or localhost.
 */
export const hostsMothership = (
  config: MachineConfig | null,
  env: Env = process.env
): boolean => {
  const url = resolveMothershipUrl(config, env);

  if (url === undefined) {
    return true;
  }

  try {
    return ['127.0.0.1', 'localhost'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};

/** Where this computer reaches the mothership. */
export const mothershipUrl = (
  config: MachineConfig | null,
  env: Env = process.env
): string =>
  resolveMothershipUrl(config, env) ??
  `http://127.0.0.1:${mothershipPort(config?.mothership?.port)}`;

const pidFile = (name: ProcessName, env: Env) =>
  path.join(lambdaHome(env), `${name}.pid`);

export const readPid = (
  name: ProcessName,
  env: Env = process.env
): number | null => {
  try {
    const pid = Number(fs.readFileSync(pidFile(name, env), 'utf8').trim());

    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

/** A process's command line (`ps -o command=`), or null when it's gone. */
export const commandOf = (pid: number): string | null => {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
};

/**
 * Is this pid Lambda's own `name` process? A pid file outlives a reboot or a
 * crash, and the pid then belongs to something else: alive isn't enough.
 * Another copy of Lambda's build counts too (a second checkout serving the
 * mothership): it holds the port, so starting this one beside it would fail.
 */
export const isLambdaProcess = (
  name: ProcessName,
  pid: number,
  command: (pid: number) => string | null = commandOf
): boolean => {
  const line = command(pid) ?? '';

  return (
    alive(pid) &&
    (line.includes(scriptPath(name)) ||
      line.includes(path.join('lambda', 'dist', `${name}.js`)))
  );
};

/** Connected, by `runner-status.json` — only while that runner is alive. */
export const runnerConnected = (
  env: Env = process.env,
  isRunner: (pid: number) => boolean = (pid) => isLambdaProcess('runner', pid)
): boolean => {
  const status = readRunnerStatus(env);

  return status?.connected === true && isRunner(status.pid);
};

export interface Processes {
  isRunning: (name: ProcessName) => boolean;
  start: (name: ProcessName) => void;
  stop: (name: ProcessName) => void;
  service: ServiceControl;
}

const realTmux = (args: string[]): string | null => {
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

const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;

/** The scripts beside this one in dist: mothership.js, runner.js. */
export const scriptPath = (name: ProcessName): string =>
  path.resolve(__dirname, `${name}.js`);

export const createProcesses = (
  env: Env = process.env,
  deps: {
    tmux?: (args: string[]) => string | null;
    isLambda?: (name: ProcessName, pid: number) => boolean;
    service?: ServiceControl;
  } = {}
): Processes => {
  const service = deps.service ?? createServiceControl({ env });
  const tmux = deps.tmux ?? realTmux;
  const isLambda = deps.isLambda ?? isLambdaProcess;

  /** The pid of the running `name`, only when it really is Lambda's. */
  const livePid = (name: ProcessName): number | null => {
    const pid = readPid(name, env);

    return pid !== null && isLambda(name, pid) ? pid : null;
  };

  const isRunning = (name: ProcessName): boolean => livePid(name) !== null;

  return {
    service,
    isRunning,
    start: (name) => {
      if (isRunning(name)) {
        return;
      }

      // Written again from this environment, then loaded: a service joined
      // before it kept PATH (or with a Node since moved) starts right too.
      if (name === 'runner' && service.installed()) {
        service.install([process.execPath, scriptPath('runner')]);

        return;
      }

      // Only this start's failure is read back by `lambda start`.
      fs.rmSync(path.join(lambdaHome(env), `${name}.log`), { force: true });
      // In the app, the script runs on Electron's binary, as Node only with
      // ELECTRON_RUN_AS_NODE: set for the script alone, never the window, or
      // the shell left in it after a crash would run Electron as Node too.
      const asNode =
        appBundle(env) === null || env.ELECTRON_RUN_AS_NODE === undefined
          ? []
          : [`ELECTRON_RUN_AS_NODE=${shellQuote(env.ELECTRON_RUN_AS_NODE)}`];
      const command = [
        'env',
        ...asNode,
        ...(env.LAMBDA_HOME === undefined
          ? []
          : [`LAMBDA_HOME=${shellQuote(env.LAMBDA_HOME)}`]),
        shellQuote(process.execPath),
        shellQuote(scriptPath(name)),
      ].join(' ');
      const hasSession =
        tmux(['has-session', '-t', `=${SYSTEM_SESSION}`]) !== null;
      // A tmux server the person already runs has none of the app's env.
      const appEnv = appWindowEnv(env);

      // A crash leaves the window open with its last words, for reading.
      tmux(
        hasSession
          ? [
              'new-window',
              '-d',
              '-t',
              `=${SYSTEM_SESSION}:`,
              '-n',
              name,
              ...appEnv,
              `${command}; exec $SHELL`,
            ]
          : [
              'new-session',
              '-d',
              '-s',
              SYSTEM_SESSION,
              '-n',
              name,
              ...appEnv,
              `${command}; exec $SHELL`,
            ]
      );
    },
    stop: (name) => {
      if (name === 'runner' && service.installed()) {
        service.stop();
      }

      const pid = livePid(name);

      if (pid !== null) {
        process.kill(pid, 'SIGTERM');
      }

      tmux(['kill-window', '-t', `=${SYSTEM_SESSION}:=${name}`]);
    },
  };
};

/**
 * Wait until the mothership answers on 127.0.0.1:<port>. Stops early once
 * `gaveUp` says its process has exited (a port in use, say): its own line
 * then says why.
 */
export const waitForMothership = async (
  port: number,
  timeoutMs = 15_000,
  gaveUp: () => boolean = () => false
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;

  const attempt = async (): Promise<boolean> => {
    if (await answering(port)) {
      return true;
    }

    if (Date.now() > deadline || gaveUp()) {
      return false;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));

    return attempt();
  };

  return attempt();
};

/**
 * Is the mothership answering on 127.0.0.1:<port>? Only a response carrying
 * its header counts: another server holding the port is not Lambda.
 */
export const answering = async (port: number): Promise<boolean> => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/session`, {
      signal: AbortSignal.timeout(1500),
    });

    return response.headers.get(MOTHERSHIP_HEADER) === MOTHERSHIP_HEADER_VALUE;
  } catch {
    return false;
  }
};
