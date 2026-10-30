import { execFileSync } from 'child_process';
import { type Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { WebSocket } from 'ws';

import {
  type MachineConfig,
  lambdaHome,
  loadMachineConfig,
  machineConfigPath,
  writeMachineConfig,
} from '../../config/machineConfig';
import {
  type Project,
  type ProjectConfig,
  loadProjectConfig,
} from '../../config/projectConfig';
import { randomId } from '../../mothership/crypto';
import { JOIN_CODE_REFUSED } from '../../mothership/pairing';
import { parseMessage } from '../../protocol';
import { socketUrl } from '../../runner/client';
import { computerName } from '../../runner/hostRunner';
import {
  defaultKeyPath,
  generateRunnerKeys,
  signChallenge,
  writePrivateKey,
} from '../../runner/keys';
import {
  readRunnerInfo,
  readRunnerState,
  removeLocalFiles,
  writeRunnerInfo,
} from '../../runner/localFiles';
import {
  createProcesses,
  mothershipUrl,
  runnerConnected,
  scriptPath,
} from '../../runner/processes';
import { projectName } from '../../runner/projectsSetup';
import {
  type ServiceControl,
  createServiceControl,
} from '../../runner/service';
import { type TmuxRun, projectServices } from '../start';

/**
 * `lambda join <code>`: make this computer one of your Lambda's runners.
 * `lambda leave`: undo it. `lambda status`: what this computer is doing.
 */

type Env = Record<string, string | undefined>;

export const NOT_JOINED =
  "This computer isn't part of a Lambda. Run lambda join <code> first.";

export const ALREADY_JOINED =
  'This computer is already part of a Lambda. Run lambda leave first.';

export const unreachable = (url: string): string => `Couldn't reach ${url}.`;

/** The mothership closed the socket on this runner: it doesn't know it. */
export class RunnerUnknownError extends Error {
  constructor() {
    super(NOT_JOINED);
    this.name = 'RunnerUnknownError';
  }
}

export interface JoinDeps {
  env: Env;
  fetch: typeof fetch;
  service: ServiceControl;
  computerName: () => string;
  /** The command the login service runs. */
  runnerCommand: string[];
  /** Unregisters again when the service can't be installed. */
  send: typeof sendAsRunner;
}

export const realJoinDeps = (env: Env = process.env): JoinDeps => ({
  env,
  fetch,
  service: createServiceControl({ env }),
  computerName,
  runnerCommand: [process.execPath, scriptPath('runner')],
  send: sendAsRunner,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** The mothership's yes: `{ ok: true, result: { runnerId, owner } }`. */
const isJoined = (
  body: unknown
): body is { ok: true; result: { runnerId: string; owner: string } } =>
  isRecord(body) &&
  body.ok === true &&
  isRecord(body.result) &&
  typeof body.result.runnerId === 'string' &&
  typeof body.result.owner === 'string';

const errorOf = (body: unknown): string | undefined =>
  isRecord(body) && typeof body.error === 'string' ? body.error : undefined;

export const installFailed = (reason: string): string =>
  `Couldn't set this computer to run Lambda at login: ${reason}. Nothing was kept; make a new join code with Add a computer and run lambda join again.`;

const readOrNull = (file: string): string | null => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/**
 * Register with a one-time join code from Add a computer. Nothing is written
 * (no key file, no config change, no service) unless the mothership said yes;
 * a service that won't install takes it all back, the registration too.
 */
export const runJoin = async (
  code: string,
  options: { server?: string; name?: string },
  deps: JoinDeps
): Promise<{ owner: string; name: string; runnerId: string }> => {
  const config: MachineConfig = loadMachineConfig(deps.env) ?? {};

  // A second join would replace the key and orphan this computer's runner.
  if (config.runner?.id !== undefined) {
    throw new Error(ALREADY_JOINED);
  }

  const url = (options.server ?? mothershipUrl(config, deps.env)).replace(
    /\/+$/,
    ''
  );
  const name = options.name ?? deps.computerName();
  const keys = generateRunnerKeys();

  const response = await deps
    .fetch(`${url}/api/runners/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name, publicKey: keys.publicKey }),
      signal: AbortSignal.timeout(15_000),
    })
    .catch(() => {
      throw new Error(unreachable(url));
    });
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok || !isJoined(body)) {
    throw new Error(errorOf(body) ?? JOIN_CODE_REFUSED);
  }

  const keyPath = config.runner?.keyPath ?? defaultKeyPath(deps.env);
  const configPath = machineConfigPath(deps.env);
  const configBefore = readOrNull(configPath);
  writePrivateKey(keyPath, keys.privateKey);
  writeMachineConfig(
    {
      ...config,
      runner: { id: body.result.runnerId, keyPath },
      mothership: { ...config.mothership, url },
    },
    deps.env
  );
  writeRunnerInfo({ name }, deps.env);

  try {
    deps.service.install(deps.runnerCommand);
  } catch (error) {
    // Left half-joined, a retry would only hit ALREADY_JOINED.
    await deps
      .send(url, body.result.runnerId, keys.privateKey, { type: 'leave' })
      .catch(() => undefined);
    fs.rmSync(keyPath, { force: true });
    fs.rmSync(path.join(lambdaHome(deps.env), 'runner.json'), { force: true });

    if (configBefore === null) {
      fs.rmSync(configPath, { force: true });
    } else {
      fs.writeFileSync(configPath, configBefore, { mode: 0o600 });
    }

    throw new Error(
      installFailed(error instanceof Error ? error.message : String(error))
    );
  }

  return { owner: body.result.owner, name, runnerId: body.result.runnerId };
};

const NEXT = 'Next, connect this computer: ';

/** The project in `cwd` (null with none there), or why its lambda.json can't be read. */
const projectIn = (
  cwd: string
): { project: Project | null } | { unreadable: string } => {
  try {
    return { project: loadProjectConfig(cwd) };
  } catch (error) {
    return {
      unreadable: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * The `lambda connect` commands this computer still needs: keys never travel
 * between computers, so each is set here. Claude always; the tracker's when
 * the project keeps its tickets there.
 */
export const connectCommands = (
  config: MachineConfig | null,
  tickets: ProjectConfig['tickets'] | undefined
): string[] => {
  const tokens = config?.tokens;
  const tracker =
    tickets?.source === 'linear' && tokens?.linear === undefined
      ? ['lambda connect linear']
      : tickets?.source === 'jira' && tokens?.jira === undefined
      ? [
          `lambda connect jira --site ${
            tickets.site ?? '<your Jira site>'
          } --email <your Jira email>`,
        ]
      : [];

  return [
    ...(tokens?.claude === undefined ? ['lambda connect claude'] : []),
    ...tracker,
  ];
};

/** What a successful `lambda join` prints. */
export const joinedLines = (
  joined: { owner: string; name: string },
  where: { env: Env; cwd: string }
): string[] => {
  const found = projectIn(where.cwd);
  const tickets =
    'project' in found ? found.project?.config.tickets : undefined;

  return [
    `✓ Joined ${joined.owner}'s Lambda as "${joined.name}"`,
    '✓ Runs in the background at login',
    ...connectCommands(loadMachineConfig(where.env), tickets).map(
      (command, index) =>
        `${index === 0 ? NEXT : ' '.repeat(NEXT.length)}${command}`
    ),
    // The join worked; only the tracker's connect line is unknown.
    ...('unreadable' in found
      ? [`Can't tell which tracker to connect: ${found.unreadable}`]
      : []),
  ];
};

/** Open the runner's socket from the CLI, send one write and wait for its result. */
export const sendAsRunner = (
  url: string,
  runnerId: string,
  privateKey: string,
  message: Record<string, unknown> & { type: string }
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl(url));
    const id = randomId('cli');
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(unreachable(url)));
    }, 15_000);
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      socket.close();
      fn();
    };

    socket.on('error', () => finish(() => reject(new Error(unreachable(url)))));
    socket.on('close', (code) => {
      if (code === 4401) {
        finish(() => reject(new RunnerUnknownError()));
      }
    });
    socket.on('message', (data) => {
      const incoming = parseMessage(data.toString());

      if (
        incoming?.type === 'challenge' &&
        typeof incoming.challenge === 'string'
      ) {
        socket.send(
          JSON.stringify({
            type: 'auth',
            runnerId,
            signature: signChallenge(
              privateKey,
              Buffer.from(incoming.challenge, 'base64')
            ),
          })
        );

        return;
      }

      if (incoming?.type === 'owner') {
        socket.send(JSON.stringify({ ...message, id }));

        return;
      }

      if (incoming?.type === 'result' && incoming.id === id) {
        finish(() =>
          incoming.ok === true
            ? resolve(incoming.result)
            : reject(new Error(String(incoming.error ?? 'Failed.')))
        );
      }
    });
  });

export interface LeaveDeps {
  env: Env;
  service: ServiceControl;
  send: typeof sendAsRunner;
  /** A runner in the `lambda-system` window outlives the service's removal. */
  stopRunner: () => void;
}

/** What `lambda leave` tells the mothership: answers its owner, or null. */
const unregister = async (
  deps: LeaveDeps,
  url: string,
  runnerId: string,
  keyPath: string
): Promise<unknown> => {
  try {
    return await deps.send(url, runnerId, fs.readFileSync(keyPath, 'utf8'), {
      type: 'leave',
    });
  } catch (error) {
    // Its database was reset or the computer removed: already unregistered.
    if (error instanceof RunnerUnknownError) {
      return null;
    }

    throw new Error(
      `${unreachable(
        url
      )} To take this computer out anyway, run lambda leave --local.`
    );
  }
};

/**
 * Unregister (a `leave` message), remove the service, delete the key. With
 * `local`, Lambda isn't asked (it's gone for good): answers null.
 */
export const runLeave = async (
  deps: LeaveDeps,
  options: { local?: boolean } = {}
): Promise<string | null> => {
  const config = loadMachineConfig(deps.env);
  const runnerId = config?.runner?.id;
  const keyPath = config?.runner?.keyPath;

  if (config === null || runnerId === undefined || keyPath === undefined) {
    throw new Error(NOT_JOINED);
  }

  const owner =
    options.local === true
      ? null
      : await unregister(
          deps,
          mothershipUrl(config, deps.env),
          runnerId,
          keyPath
        );
  deps.stopRunner();
  deps.service.remove();
  fs.rmSync(keyPath, { force: true });
  const { runner: _gone, ...rest } = config;
  writeMachineConfig(rest, deps.env);
  removeLocalFiles(deps.env);

  if (options.local === true) {
    return null;
  }

  return typeof owner === 'string' ? owner : 'your Lambda';
};

/** The four lines of `lambda status`. */
export const statusLines = (
  env: Env,
  tmux: TmuxRun,
  isRunner?: (pid: number) => boolean
): string[] => {
  const config = loadMachineConfig(env);
  const runnerId = config?.runner?.id;

  if (runnerId === undefined) {
    throw new Error(NOT_JOINED);
  }

  const name = readRunnerInfo(env)?.name ?? computerName();
  const folder = readRunnerState(env).current;
  const project = folder === null ? null : loadProjectConfig(folder);
  const services = project === null ? {} : projectServices(project);
  const windows =
    project === null
      ? []
      : (
          tmux([
            'list-windows',
            '-t',
            `=${project.config.tmux.session}`,
            '-F',
            '#{window_name}',
          ]) ?? ''
        )
          .split('\n')
          .filter((window) => window !== '');
  const servicesText = Object.keys(services)
    .map(
      (service) =>
        `${service} ${windows.includes(service) ? '✓ running' : '✗ stopped'}`
    )
    .join(', ');

  return [
    `Computer    ${name} (${runnerId})`,
    `Connected   ${runnerConnected(env, isRunner) ? 'yes' : 'no'}`,
    `Codebase    ${project === null ? 'none' : projectName(project)}`,
    `Services    ${servicesText === '' ? 'none' : servicesText}`,
  ];
};

export const registerJoinCommand = (program: Command): void => {
  program
    .command('join <code>')
    .description('Make this computer one of your Lambda’s computers')
    .option(
      '--server <url>',
      'The computer running Lambda, e.g. http://100.64.0.2:4580'
    )
    .option('--name <name>', "This computer's name in Lambda")
    .action(
      async (code: string, options: { server?: string; name?: string }) => {
        const joined = await runJoin(code, options, realJoinDeps());
        joinedLines(joined, { env: process.env, cwd: process.cwd() }).forEach(
          (line) => console.log(line)
        );
      }
    );
};

const leftLine = (owner: string | null): string => {
  if (owner === null) {
    return "✓ Left on this computer; it no longer runs at login. Lambda wasn't told, so its Computers screen still lists it, offline.";
  }

  return `✓ Left ${
    owner === 'your Lambda' ? owner : `${owner}'s Lambda`
  }; no longer runs at login`;
};

export const registerLeaveCommand = (program: Command): void => {
  program
    .command('leave')
    .description('Take this computer out of your Lambda')
    .option(
      '--local',
      "Leave without asking Lambda (when it can't be reached any more)"
    )
    .action(async (options: { local?: boolean }) => {
      const owner = await runLeave(
        {
          env: process.env,
          service: createServiceControl(),
          send: sendAsRunner,
          stopRunner: () => createProcesses(process.env).stop('runner'),
        },
        { local: options.local === true }
      );
      console.log(leftLine(owner));
    });
};

export const registerStatusCommand = (program: Command): void => {
  program
    .command('status')
    .description('What this computer is doing for Lambda')
    .action(() => {
      statusLines(process.env, (args) => {
        try {
          return execFileSync('tmux', args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          });
        } catch {
          return null;
        }
      }).forEach((line) => console.log(line));
    });
};
