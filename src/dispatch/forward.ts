import { spawn } from 'child_process';
import { type EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type Project } from '../config/projectConfig';

/** Signals passed on to the project CLI while it runs. */
export const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** Set in the project CLI's env, so a second hop is refused. */
export const FORWARDED_ENV = 'LAMBDA_FORWARDED';

export interface ForwardResult {
  code: number;
  /** Printed to stderr when set. */
  message?: string;
}

export interface ForwardOptions {
  /** The whole argv after `lambda`; the first entry is the command name. */
  args: string[];
  project: Project | null;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Where SIGINT/SIGTERM/SIGHUP come from. `process` by default. */
  signals?: EventEmitter;
  /** The running lambda's own script, so `cli: "lambda"` never runs itself. */
  runningBinary?: string;
}

export const unknownCommandMessage = (name: string): string =>
  [
    `Unknown command "${name}".`,
    "Run lambda init to set a codebase CLI, or lambda doctor to see what's available.",
  ].join('\n');

const realpath = (file: string): string => {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};

const isFile = (file: string): boolean => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * The executable for `cli`: a path when it has a `/` (from the project root,
 * not the current folder), else a bare name looked up on PATH. For
 * `lambda`, the project's own copy, never the one running now.
 */
const resolveExecutable = (
  cli: string,
  project: Project,
  runningBinary: string | undefined
): { file: string } | { error: string } => {
  if (cli === 'lambda') {
    const self =
      runningBinary === undefined ? undefined : realpath(runningBinary);
    const own = [
      path.join(project.root, 'bin', 'lambda'),
      path.join(project.root, 'node_modules', '.bin', 'lambda'),
    ].find((file) => isFile(file) && realpath(file) !== self);

    return own === undefined
      ? {
          error:
            'Project CLI "lambda" is this lambda. Set "cli" in lambda.json to your project\'s own command.',
        }
      : { file: own };
  }

  return { file: cli.includes('/') ? path.resolve(project.root, cli) : cli };
};

const signalExitCode = (signal: NodeJS.Signals): number =>
  128 + (os.constants.signals[signal] ?? 0);

/**
 * Run the project's CLI with the same argv: inherited stdio, no shell, the
 * child's exit code, and signals passed on.
 */
export const forwardToProjectCli = (
  options: ForwardOptions
): Promise<ForwardResult> => {
  const { args, project } = options;
  const env = options.env ?? process.env;
  const signals = options.signals ?? process;
  const name = args[0] ?? '';
  const cli = project?.config.cli;

  if (project === null || cli === undefined) {
    return Promise.resolve({ code: 1, message: unknownCommandMessage(name) });
  }

  if (env[FORWARDED_ENV] === '1') {
    return Promise.resolve({
      code: 1,
      message: `Already forwarded once; refusing to forward "${name}" again.`,
    });
  }

  const executable = resolveExecutable(cli, project, options.runningBinary);

  if ('error' in executable) {
    return Promise.resolve({ code: 1, message: executable.error });
  }

  return new Promise((resolve) => {
    const child = spawn(executable.file, args, {
      cwd: options.cwd ?? process.cwd(),
      env: { ...env, [FORWARDED_ENV]: '1' },
      stdio: 'inherit',
    });
    const relays = FORWARDED_SIGNALS.map((signal) => {
      const relay = (): void => {
        child.kill(signal);
      };
      signals.on(signal, relay);

      return { signal, relay };
    });
    const stopRelaying = (): void => {
      relays.forEach(({ signal, relay }) => signals.off(signal, relay));
    };

    child.on('error', (error: NodeJS.ErrnoException) => {
      stopRelaying();
      resolve(
        error.code === 'ENOENT'
          ? { code: 127, message: `Project CLI "${cli}" not found.` }
          : {
              code: 1,
              message: `Project CLI "${cli}" failed: ${error.message}`,
            }
      );
    });
    child.on('exit', (code, signal) => {
      stopRelaying();
      resolve({
        code: signal === null ? code ?? 1 : signalExitCode(signal),
      });
    });
  });
};
