import * as fs from 'fs';
import * as path from 'path';

import { readReadyFile } from '../mothership/readyFile';
import { localOrigin } from './navigation';

/**
 * Opening the Mac app: `lambda start` runs as a child process (never inside
 * Electron's main process), the app waits for the mothership's ready file,
 * then opens one window already signed in with a single-use login link.
 * If the mothership hasn't come up within 30 s, the app says so in a native
 * dialog with the log, rather than opening a blank window.
 */

export const READY_TIMEOUT_MS = 30_000;
export const READY_POLL_MS = 250;
export const LOG_LINES = 20;

export const CANT_START_TITLE = "Lambda couldn't start";

export type MothershipWait =
  | { ok: true; port: number }
  | { ok: false; logPath: string; lastLines: string[] };

const lastLines = (file: string, count: number): string[] => {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .slice(-count);
  } catch {
    return [];
  }
};

/** Poll `~/.lambda/mothership.ready` every 250 ms, for up to 30 s. */
export const waitForMothership = (options: {
  /** `~/.lambda`. */
  lambdaHome: string;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<MothershipWait> => {
  const timeoutMs = options.timeoutMs ?? READY_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? READY_POLL_MS;
  const logPath = path.join(options.lambdaHome, 'mothership.log');

  return new Promise((resolve) => {
    const waited = { ms: 0 };
    const check = () => {
      const ready = readReadyFile(options.lambdaHome);

      if (ready !== null) {
        resolve({ ok: true, port: ready.port });

        return;
      }

      if (waited.ms >= timeoutMs) {
        resolve({
          ok: false,
          logPath,
          lastLines: lastLines(logPath, LOG_LINES),
        });

        return;
      }

      waited.ms += intervalMs;
      setTimeout(check, intervalMs);
    };
    check();
  });
};

/**
 * A second launch's argv (`lambda upgrade` sends `--check-for-updates`) can
 * arrive during the up-to-30 s wait, before the updater exists: it waits for
 * the updater rather than being dropped.
 */
export const createPendingSecondInstances = () => {
  const state: { waiting: string[][]; run: ((argv: string[]) => void) | null } =
    { waiting: [], run: null };

  return {
    arrived: (argv: string[]): void => {
      if (state.run === null) {
        state.waiting = [...state.waiting, argv];

        return;
      }

      state.run(argv);
    },
    ready: (run: (argv: string[]) => void): void => {
      state.run = run;
      const { waiting } = state;
      state.waiting = [];
      waiting.forEach(run);
    },
  };
};

/** What startup needs of a window: somewhere to load the signed-in link. */
export interface StartupWindow {
  loadURL: (url: string) => Promise<unknown>;
}

export interface StartupDeps {
  wait: () => Promise<MothershipWait>;
  /** A single-use login link for the port (the function `lambda open` uses). */
  mintLoginLink: (port: number) => string;
  createWindow: (origin: string) => StartupWindow;
  showError: (title: string, message: string) => void;
}

export type Startup =
  | { ok: true; port: number; window: StartupWindow }
  | { ok: false };

export const cantStartMessage = (logPath: string, lines: string[]): string =>
  [
    `The Lambda server didn't come up within ${
      READY_TIMEOUT_MS / 1000
    } seconds.`,
    '',
    `Its log: ${logPath}`,
    ...(lines.length === 0 ? ['(The log is empty.)'] : ['', ...lines]),
  ].join('\n');

/**
 * The app window's options. It opens hidden and shows on `ready-to-show`, so
 * a blank window never appears while the page loads, nor flashes before the
 * "Lambda couldn't start" dialog when the page fails to load.
 */
export const windowOptions = (preload: string) => ({
  width: 1280,
  height: 860,
  title: 'Lambda',
  show: false,
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    preload,
  },
});

export const openSignedIn = async (deps: StartupDeps): Promise<Startup> => {
  const ready = await deps.wait();

  if (!ready.ok) {
    deps.showError(
      CANT_START_TITLE,
      cantStartMessage(ready.logPath, ready.lastLines)
    );

    return { ok: false };
  }

  const window = deps.createWindow(localOrigin(ready.port));

  try {
    await window.loadURL(deps.mintLoginLink(ready.port));
  } catch (error) {
    deps.showError(
      CANT_START_TITLE,
      `The Lambda server is ready but its page didn't load: ${
        error instanceof Error ? error.message : String(error)
      }`
    );

    return { ok: false };
  }

  return { ok: true, port: ready.port, window };
};
