import * as fs from 'fs';
import * as path from 'path';

import { shimDir, shimPath } from './appPaths';

/**
 * The tools the Mac app carries, so a Mac with nothing installed still runs
 * agents: tmux and git built into `Contents/Resources/tools/`, Playwright in
 * the app's own node_modules, and the `lambda` shim, which runs the bundled
 * CLI through Electron itself (`ELECTRON_RUN_AS_NODE=1`), so agents'
 * `lambda …` calls work with no Node on the machine.
 */

type Env = Record<string, string | undefined>;

export interface AppLayout {
  /** `Lambda.app`. */
  bundle: string;
  /** `Lambda.app/Contents/Resources`. */
  resources: string;
  /** The Electron binary (`process.execPath` in the main process). */
  electron: string;
  /** The person's home folder. */
  home: string;
}

export const toolsDir = (layout: AppLayout): string =>
  path.join(layout.resources, 'tools');

export const toolsBinDir = (layout: AppLayout): string =>
  path.join(toolsDir(layout), 'bin');

/** The CLI inside the packaged app (Electron reads it out of app.asar). */
export const bundledCli = (layout: AppLayout): string =>
  path.join(layout.resources, 'app.asar', 'bin', 'lambda');

export interface BundledTools {
  tmux: string;
  git: string;
  lambda: string;
}

export const bundledTools = (layout: AppLayout): BundledTools => ({
  tmux: path.join(toolsBinDir(layout), 'tmux'),
  git: path.join(toolsBinDir(layout), 'git'),
  lambda: shimPath(layout.home),
});

/** PATH with the shim and the bundled tools first, the rest after. */
export const appPath = (
  layout: AppLayout,
  current: string | undefined
): string =>
  [
    shimDir(layout.home),
    toolsBinDir(layout),
    ...(current ?? '').split(path.delimiter),
  ]
    .filter((dir, index, all) => dir !== '' && all.indexOf(dir) === index)
    .join(path.delimiter);

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** The shim's text: the bundled CLI through Electron, as Node. */
export const shimScript = (layout: AppLayout): string =>
  [
    '#!/bin/sh',
    '# Written by the Lambda app: runs its own copy of the lambda CLI.',
    'ELECTRON_RUN_AS_NODE=1 \\',
    `LAMBDA_APP_BUNDLE=${quote(layout.bundle)} \\`,
    `exec ${quote(layout.electron)} ${quote(bundledCli(layout))} "$@"`,
    '',
  ].join('\n');

/** Write the shim (rewritten each launch, so a moved app still works). */
export const writeShim = (layout: AppLayout): string => {
  const file = shimPath(layout.home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, shimScript(layout), { mode: 0o755 });
  fs.chmodSync(file, 0o755);

  return file;
};

/**
 * The env the app starts `lambda start` with, and so the tmux server and
 * every agent: bundled tools first on PATH, the app bundle named, and
 * Playwright's browsers in the app's folder.
 */
export const appEnv = (
  layout: AppLayout,
  env: Env,
  browsersPath: string
): Env => ({
  ...env,
  PATH: appPath(layout, env.PATH),
  LAMBDA_APP_BUNDLE: layout.bundle,
  PLAYWRIGHT_BROWSERS_PATH: browsersPath,
  // git built with RUNTIME_PREFIX finds its own helpers next to itself.
  GIT_EXEC_PATH: path.join(toolsDir(layout), 'libexec', 'git-core'),
});

/**
 * What a tmux window needs from the app, whichever tmux server it lands on.
 * Not PATH: tmux gives a new window the PATH of the client that asked for
 * it (Lambda, run with the app's), over the server's and over `-e`.
 */
export const APP_WINDOW_KEYS = [
  'LAMBDA_APP_BUNDLE',
  'PLAYWRIGHT_BROWSERS_PATH',
  'GIT_EXEC_PATH',
];

/**
 * The env for a tmux client: everything but `ELECTRON_RUN_AS_NODE`, which the
 * shim sets for the CLI alone. A tmux server copies the env of the client
 * that starts it into every window, so a window would otherwise run Electron
 * as plain Node (an agent's `npx electron .` would never open a window).
 */
export const tmuxClientEnv = (env: Env = process.env): Env => {
  const { ELECTRON_RUN_AS_NODE: _asNode, ...rest } = env;

  return rest;
};

/**
 * `-e KEY=value` for each, run from the app (the shim sets
 * `LAMBDA_APP_BUNDLE`); nothing for an npm install. A tmux server the person
 * already runs has its own environment, which a new window gets instead of
 * the app's, so the app's has to be given to each window.
 */
export const appWindowEnv = (env: Env, keys = APP_WINDOW_KEYS): string[] =>
  env.LAMBDA_APP_BUNDLE === undefined
    ? []
    : keys.flatMap((key) => {
        const value = env[key];

        return value === undefined ? [] : ['-e', `${key}=${value}`];
      });
