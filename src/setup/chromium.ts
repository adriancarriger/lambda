import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { appBundle, browsersDir } from '../desktop/appPaths';
import { FAILED_LINES, lastPercent, outputLines } from './connectClaude';

/**
 * The browser agents test with. In the Mac app, Playwright's own installer
 * (`install chromium`, from the bundled Playwright) fetches Chromium into
 * `~/Library/Application Support/Lambda/ms-playwright` in the background
 * while setup runs; it never blocks a step. An npm install skips this, and
 * `lambda doctor` reports the browser's state instead.
 */

type Env = Record<string, string | undefined>;

export type BrowserState =
  | { phase: 'not-app' }
  | { phase: 'idle' }
  | { phase: 'installing'; percent: number | null }
  | { phase: 'failed'; lines: string[] }
  | { phase: 'done' };

export interface ChildLike {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface ChromiumDeps {
  env: Env;
  home: string;
  /** Runs Playwright's CLI: `install chromium`. */
  spawnInstaller: (env: Env) => ChildLike;
  onChange?: () => void;
}

/** Playwright writes this into a build's folder once its download is whole. */
export const INSTALL_MARKER = 'INSTALLATION_COMPLETE';

/** A whole Chromium build in the folder (not one a quit cut short). */
export const chromiumInstalled = (dir: string): boolean => {
  try {
    return fs
      .readdirSync(dir)
      .some(
        (name) =>
          name.startsWith('chromium') &&
          fs.existsSync(path.join(dir, name, INSTALL_MARKER))
      );
  } catch {
    return false;
  }
};

const couldntStart = (error: unknown): BrowserState => ({
  phase: 'failed',
  lines: [
    `Couldn't start Playwright's installer: ${
      error instanceof Error ? error.message : String(error)
    }`,
  ],
});

export interface ChromiumInstaller {
  /** Starts it when it's needed and hasn't run yet. */
  start: () => void;
  /** After a failure: the page's Retry. */
  retry: () => void;
  state: () => BrowserState;
}

export const createChromiumInstaller = (
  deps: ChromiumDeps
): ChromiumInstaller => {
  const dir = browsersDir(deps.home);
  const run: { state: BrowserState } = {
    state:
      appBundle(deps.env) === null
        ? { phase: 'not-app' }
        : chromiumInstalled(dir)
        ? { phase: 'done' }
        : { phase: 'idle' },
  };

  const set = (state: BrowserState): void => {
    run.state = state;
    deps.onChange?.();
  };

  const install = (): void => {
    if (chromiumInstalled(dir)) {
      set({ phase: 'done' });

      return;
    }

    set({ phase: 'installing', percent: null });
    const seen = { text: '' };
    const child = ((): ChildLike | null => {
      try {
        return deps.spawnInstaller({
          ...deps.env,
          PLAYWRIGHT_BROWSERS_PATH: dir,
        });
      } catch (error) {
        set(couldntStart(error));

        return null;
      }
    })();

    if (child === null) {
      return;
    }

    // Node emits `close` after a spawn's `error`: the error is the reason.
    const failed = { toStart: false };
    child.on('error', (error) => {
      failed.toStart = true;
      set(couldntStart(error));
    });
    const onData = (chunk: Buffer | string) => {
      seen.text += chunk.toString();
      const percent = lastPercent(seen.text);

      // Every change reloads every open page: only a new percentage counts.
      if (run.state.phase !== 'installing' || run.state.percent !== percent) {
        set({ phase: 'installing', percent });
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('close', (code) => {
      if (failed.toStart) {
        return;
      }

      set(
        code === 0
          ? { phase: 'done' }
          : {
              phase: 'failed',
              lines: outputLines(seen.text).slice(-FAILED_LINES),
            }
      );
    });
  };

  return {
    start: () => {
      if (run.state.phase === 'idle') {
        install();
      }
    },
    retry: () => {
      if (run.state.phase === 'failed') {
        install();
      }
    },
    state: () => run.state,
  };
};

/** The bundled Playwright's CLI, run by this same runtime. */
export const spawnPlaywrightInstall = (env: Env): ChildLike =>
  spawn(
    process.execPath,
    [require.resolve('playwright/cli'), 'install', 'chromium'],
    {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
