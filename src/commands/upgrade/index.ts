import { spawn } from 'child_process';
import { type Command } from 'commander';

import { appBundle } from '../../desktop/appPaths';
import { CHECK_FOR_UPDATES_ARG } from '../../desktop/updater';

/**
 * `lambda upgrade`: the newest Lambda. An npm install updates itself from
 * npm. Run through the Mac app's shim (which sets `LAMBDA_APP_BUNDLE`), it
 * asks the running app to check for an update instead, through the app's
 * single-instance handoff; the app never restarts by itself. `open -n`
 * starts a second copy even while the app runs (plain `open -a` only brings
 * the running one to the front, with no arguments): that copy hands its
 * arguments to the first through `second-instance` and quits.
 */

type Env = Record<string, string | undefined>;

export const NPM_PACKAGE = '@adriancarriger/lambda';

export type Spawn = (command: string, args: string[]) => Promise<number>;

export const upgradeCommand = (env: Env): [string, string[]] => {
  const bundle = appBundle(env);

  return bundle === null
    ? ['npm', ['i', '-g', `${NPM_PACKAGE}@latest`]]
    : ['open', ['-n', '-a', bundle, '--args', CHECK_FOR_UPDATES_ARG]];
};

export const runUpgrade = (env: Env, run: Spawn): Promise<number> => {
  const [command, args] = upgradeCommand(env);

  return run(command, args);
};

const spawnInherit: Spawn = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });

export const registerUpgradeCommand = (program: Command): void => {
  program
    .command('upgrade')
    .description('Update Lambda to the newest version')
    .action(async () => {
      process.exitCode = await runUpgrade(process.env, spawnInherit);
    });
};
