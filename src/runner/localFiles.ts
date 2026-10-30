import * as fs from 'fs';
import * as path from 'path';

import { lambdaHome } from '../config/machineConfig';
import { type KnownAssignees, parseKnownAssignees } from '../tickets/assignees';

const ASSIGNEES_FILE = 'assignees.json';

/**
 * Small files a runner and the CLI on the same computer share, under
 * `~/.lambda/` (none of them is the machine config):
 *
 * - `runner.json`: this computer's name in its Lambda.
 * - `runner-state.json`: the project folder it's on, written by
 *   `lambda start` (and the idle switch); the runner reports it.
 * - `runner-status.json`: whether the runner is connected, for
 *   `lambda status`.
 */

type Env = Record<string, string | undefined>;

const file = (name: string, env: Env) => path.join(lambdaHome(env), name);

const readJson = <T>(name: string, env: Env): T | null => {
  try {
    const parsed: T = JSON.parse(fs.readFileSync(file(name, env), 'utf8'));

    return parsed;
  } catch {
    return null;
  }
};

const writeJson = (name: string, value: unknown, env: Env): void => {
  const target = file(name, env);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  // Written whole, then renamed: the runner never reads half a file.
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temp, target);
};

export interface RunnerInfo {
  name: string;
}

export const readRunnerInfo = (env: Env = process.env) =>
  readJson<RunnerInfo>('runner.json', env);

export const writeRunnerInfo = (info: RunnerInfo, env: Env = process.env) =>
  writeJson('runner.json', info, env);

/**
 * `assignees.json`: the map Lambda hands this computer (who each computer
 * and the owner are in each tracker). Kept on disk so every ticket source on
 * this computer uses it: the runner's, its pods' and the CLI's.
 */
export const readKnownAssignees = (env: Env = process.env): KnownAssignees =>
  parseKnownAssignees(readJson<unknown>(ASSIGNEES_FILE, env));

/** Written only when it changed: the runner hears it on every connect. */
export const writeKnownAssignees = (
  known: KnownAssignees,
  env: Env = process.env
): boolean => {
  const before = JSON.stringify(readKnownAssignees(env));

  if (before === JSON.stringify(known)) {
    return false;
  }

  writeJson(ASSIGNEES_FILE, known, env);

  return true;
};

export interface RunnerState {
  /** The project folder this computer is on, or null. */
  current: string | null;
}

export const RUNNER_STATE_FILE = 'runner-state.json';

export const readRunnerState = (env: Env = process.env): RunnerState =>
  readJson<RunnerState>(RUNNER_STATE_FILE, env) ?? { current: null };

export const writeRunnerState = (state: RunnerState, env: Env = process.env) =>
  writeJson(RUNNER_STATE_FILE, state, env);

export const runnerStatePath = (env: Env = process.env) =>
  file(RUNNER_STATE_FILE, env);

export interface RunnerStatus {
  connected: boolean;
  at: string;
  pid: number;
}

export const readRunnerStatus = (env: Env = process.env) =>
  readJson<RunnerStatus>('runner-status.json', env);

export const writeRunnerStatus = (
  status: RunnerStatus,
  env: Env = process.env
) => writeJson('runner-status.json', status, env);

/**
 * What `lambda leave` takes with it. The outbox and events cursor too: left
 * behind, the old Lambda's unsent items would go to the next one joined.
 */
export const removeLocalFiles = (env: Env = process.env): void =>
  [
    'runner.json',
    RUNNER_STATE_FILE,
    'runner-status.json',
    'outbox.jsonl',
    'events-cursor.json',
    'runner.pid',
  ].forEach((name) => fs.rmSync(file(name, env), { force: true }));
