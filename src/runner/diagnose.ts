import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * `diagnose`: what a computer can say about itself when it's debugged from
 * another one (`lambda computer <name> <action>`). A fixed set of reads, never
 * a command line: the mothership can ask a runner these and nothing else, so
 * a stolen session reads state but runs nothing.
 *
 * - `status`: the runner's own process, PATH and the tools it finds on it
 *   (pod actions need tmux on that PATH).
 * - `pod`: a pod's pod.json and building.json, as on disk.
 * - `log`: the end of the runner's log.
 * - `git`: the checkout it's on: branch, changes, last commit.
 */

export const DIAGNOSE_ACTIONS = ['status', 'pod', 'log', 'git'] as const;

export type DiagnoseAction = (typeof DIAGNOSE_ACTIONS)[number];

type Env = Record<string, string | undefined>;

/** The tools a runner needs on its PATH. */
const TOOLS = ['tmux', 'git', 'node', 'claude'] as const;

const DEFAULT_LINES = 50;
const MAX_LINES = 500;

/** A pod id names a folder: nothing that could climb out of the pods root. */
const POD_ID = /^[a-z0-9][a-z0-9-]*$/;

export interface DiagnoseDeps {
  env: Env;
  /** This computer's name. */
  computer: string;
  /** The codebase it's on, if any. */
  folder: string | null;
  /** Where that codebase keeps its pods. */
  podsRoot: (folder: string) => string;
  /** Lambda's home (`~/.lambda`): its runner.log when run in tmux. */
  lambdaHome: string;
  home?: string;
  /** `git <args>` in `cwd`; throws on a failure. */
  git?: (args: string[], cwd: string) => string;
  now?: () => number;
}

/** The first `name` on `PATH` that this process may run, as spawn finds it. */
export const findOnPath = (
  name: string,
  pathValue: string | undefined
): string | null =>
  (pathValue ?? '')
    .split(path.delimiter)
    .filter((dir) => dir !== '')
    .map((dir) => path.join(dir, name))
    .find((file) => {
      try {
        fs.accessSync(file, fs.constants.X_OK);

        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    }) ?? null;

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const tail = (file: string, lines: number): string[] | null => {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines);
  } catch {
    return null;
  }
};

const realGit = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

const needFolder = (deps: DiagnoseDeps): string => {
  if (deps.folder === null) {
    throw new Error(`${deps.computer} isn't on a codebase.`);
  }

  return deps.folder;
};

const status = (deps: DiagnoseDeps) => {
  const now = deps.now ?? Date.now;
  const [, script] = process.argv;
  const builtAt = (() => {
    try {
      return script === undefined
        ? null
        : fs.statSync(script).mtime.toISOString();
    } catch {
      return null;
    }
  })();

  return {
    computer: deps.computer,
    pid: process.pid,
    node: process.version,
    script: script ?? null,
    builtAt,
    startedAt: new Date(now() - process.uptime() * 1000).toISOString(),
    folder: deps.folder,
    path: deps.env.PATH ?? null,
    tools: Object.fromEntries(
      TOOLS.map((tool) => [tool, findOnPath(tool, deps.env.PATH)])
    ),
  };
};

const pod = (deps: DiagnoseDeps, podId: string) => {
  if (!POD_ID.test(podId)) {
    throw new Error(`Not a pod id: ${podId}`);
  }

  const dir = path.join(deps.podsRoot(needFolder(deps)), podId);

  if (!fs.existsSync(dir)) {
    throw new Error(`No pod ${podId} on ${deps.computer}.`);
  }

  return {
    podId,
    pod: readJson(path.join(dir, 'pod.json')),
    building: readJson(path.join(dir, 'building.json')),
  };
};

const log = (deps: DiagnoseDeps, lines: number) => {
  const home = deps.home ?? os.homedir();
  // In tmux it writes Lambda's own log; as a login service, launchd's.
  const files = [
    path.join(deps.lambdaHome, 'runner.log'),
    path.join(home, 'Library', 'Logs', 'lambda-runner.log'),
  ];

  return {
    logs: files.flatMap((file) => {
      const last = tail(file, lines);

      return last === null ? [] : [{ file, lines: last }];
    }),
  };
};

const git = (deps: DiagnoseDeps) => {
  const folder = needFolder(deps);
  const run = deps.git ?? realGit;

  return {
    folder,
    branch: run(['branch', '--show-current'], folder),
    status: run(['status', '--porcelain=v1', '--branch'], folder),
    last: run(['log', '-1', '--format=%h %s (%cr)'], folder),
  };
};

const linesOf = (value: unknown): number => {
  const lines = typeof value === 'number' ? value : Number(value);

  return Number.isInteger(lines) && lines > 0
    ? Math.min(lines, MAX_LINES)
    : DEFAULT_LINES;
};

export const isDiagnoseAction = (value: unknown): value is DiagnoseAction =>
  DIAGNOSE_ACTIONS.some((action) => action === value);

export const diagnose = (
  message: Record<string, unknown>,
  deps: DiagnoseDeps
): unknown => {
  const { action } = message;

  if (!isDiagnoseAction(action)) {
    throw new Error(
      `Unknown diagnose action: ${String(action)} (${DIAGNOSE_ACTIONS.join(
        ', '
      )})`
    );
  }

  switch (action) {
    case 'status':
      return status(deps);
    case 'pod':
      return pod(deps, String(message.podId ?? ''));
    case 'log':
      return log(deps, linesOf(message.lines));
    case 'git':
      return git(deps);
  }
};
