import * as fs from 'fs';
import * as path from 'path';

import { realStartDeps } from '../commands/start';
import { runShellCommand } from '../commands/start/shell';
import {
  type MachineConfig,
  lambdaHome,
  loadMachineConfig,
} from '../config/machineConfig';
import type { TicketSource } from '../tickets/source';
import { RESUME_ALL_TIMEOUT_MS, STOP_TIMEOUT_MS } from './budgets';
import { type RunnerClient, createRunnerClient } from './client';
import { computerName } from './hostRunner';
import { readRunnerInfo, writeRunnerStatus } from './localFiles';
import { createOutbox } from './outbox';
import { type LambdaCli, type Tmux, createPodHost } from './podHost';
import { mothershipUrl } from './processes';
import { createRuntime, realLambda, realTmux } from './runtime';

/**
 * The runner process's parts, wired: its runtime and its one socket to the
 * mothership. What the mothership says about whose Lambda this is (its
 * `owner` message) goes straight to the runtime, which keeps it for
 * pick-up: this computer's own config never decides whose tickets it builds.
 */

type Env = Record<string, string | undefined>;

export interface RunnerProcessOptions {
  config: MachineConfig | null;
  runnerId: string;
  privateKey: string;
  log: (line: string) => void;
  env?: Env;
  /** For tests: `lambda` and tmux, as every part of the runner sees them. */
  lambda?: { run: LambdaCli; spawn: ReturnType<typeof realLambda>['spawn'] };
  tmux?: Tmux;
  /** For tests: a project's tickets, for building pods' pick-up. */
  buildingSource?: (folder: string) => TicketSource;
  /** For tests: the clock (pick-up's 60-second poll reads it). */
  now?: () => number;
}

export const createRunnerProcess = (options: RunnerProcessOptions) => {
  const env = options.env ?? process.env;
  const { config, runnerId, privateKey, log } = options;
  const home = lambdaHome(env);
  const computer = readRunnerInfo(env)?.name ?? computerName();
  const lambda = options.lambda ?? realLambda(env);
  const tmux = options.tmux ?? realTmux;
  const holder: { client: RunnerClient | null } = { client: null };
  const client = (): RunnerClient => {
    if (holder.client === null) {
      throw new Error('The runner is not started.');
    }

    return holder.client;
  };

  const runtime = createRuntime({
    // A reset mothership: `lambda start` registers this computer again,
    // writing a new id while this runs.
    runnerId: () => loadMachineConfig(env)?.runner?.id ?? runnerId,
    computer,
    client,
    env,
    now: options.now,
    buildingSource: options.buildingSource,
    lambda: lambda.run,
    tmux,
    makeHost: (folder) =>
      createPodHost({
        folder,
        lambda: lambda.run,
        spawnLambda: lambda.spawn,
        tmux,
        onChange: () => runtime.pushState(folder),
        log,
        isCurrent: () => runtime.isCurrent(folder),
        computer,
        env,
      }),
    startDeps: () => ({
      ...realStartDeps(env),
      // Already running: it's us.
      waitForConnected: async () => true,
      resumeAll: async (folder) => {
        await lambda.run(['pod', 'resume-all', '--stagger', '5'], {
          cwd: folder,
          timeoutMs: RESUME_ALL_TIMEOUT_MS,
        });
      },
      // The project's own stop, mid idle switch: bounded, never blocking.
      runShell: (command, cwd) =>
        runShellCommand(command, cwd, { timeoutMs: STOP_TIMEOUT_MS }),
      print: log,
    }),
    log,
  });

  const status = (connected: boolean) =>
    writeRunnerStatus(
      { connected, at: new Date().toISOString(), pid: process.pid },
      env
    );

  holder.client = createRunnerClient({
    url: mothershipUrl(config, env),
    runnerId,
    privateKey,
    // A reset mothership: `lambda start` registers this computer again,
    // writing a new id and key while this runs.
    credentials: () => {
      const latest = loadMachineConfig(env)?.runner;

      return latest?.id === undefined || latest.keyPath === undefined
        ? { runnerId, privateKey }
        : {
            runnerId: latest.id,
            privateKey: fs.readFileSync(latest.keyPath, 'utf8'),
          };
    },
    outbox: createOutbox(path.join(home, 'outbox.jsonl'), log),
    handle: runtime.handle,
    onOwner: (owner, known) => runtime.setOwner(owner, known),
    onConnected: (connected) => {
      status(connected);
      log(connected ? 'Connected.' : 'Disconnected; reconnecting.');

      if (connected) {
        runtime.onConnected().catch((error: unknown) => log(String(error)));
      }
    },
    log,
  });

  return { runtime, client: client(), status };
};
