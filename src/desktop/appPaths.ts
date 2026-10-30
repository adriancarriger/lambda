import * as os from 'os';
import * as path from 'path';

/**
 * Where the Mac app keeps its own things, outside `~/.lambda`: the `lambda`
 * shim agents call, Chromium for Playwright, Kokoro's model, and the app's
 * small state file. `LAMBDA_APP_BUNDLE` (set by the shim) says Lambda is
 * running inside the app.
 */

type Env = Record<string, string | undefined>;

export const APP_NAME = 'Lambda';

/** The app bundle's path when running inside the Mac app, else null. */
export const appBundle = (env: Env = process.env): string | null => {
  const bundle = env.LAMBDA_APP_BUNDLE;

  return bundle === undefined || bundle === '' ? null : bundle;
};

export const appSupportDir = (home: string = os.homedir()): string =>
  path.join(home, 'Library', 'Application Support', APP_NAME);

export const shimDir = (home: string = os.homedir()): string =>
  path.join(appSupportDir(home), 'bin');

export const shimPath = (home: string = os.homedir()): string =>
  path.join(shimDir(home), 'lambda');

/** `PLAYWRIGHT_BROWSERS_PATH` for every agent the app runs. */
export const browsersDir = (home: string = os.homedir()): string =>
  path.join(appSupportDir(home), 'ms-playwright');

export const modelsDir = (home: string = os.homedir()): string =>
  path.join(appSupportDir(home), 'models');

/** Kokoro's own node_modules, which the app carries outside app.asar. */
export const kokoroModulesDir = (bundle: string): string =>
  path.join(bundle, 'Contents', 'Resources', 'kokoro', 'node_modules');

/** The app's own state: the last day it posted the renewal notification. */
export const appStateFile = (home: string = os.homedir()): string =>
  path.join(appSupportDir(home), 'state.json');

export const appLogDir = (home: string = os.homedir()): string =>
  path.join(home, 'Library', 'Logs', APP_NAME);
