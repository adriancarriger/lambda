/**
 * The Mac app's main process: thin wiring over `src/desktop/`, where the
 * logic lives (and is unit-tested without Electron).
 *
 * Opening the app runs `lambda start` through the app's `lambda` shim (a
 * child process, never inside this one), waits for the mothership's ready
 * file, then opens one window already signed in. The menu-bar icon stays
 * when the window closes, so this Mac's runner keeps working; only Quit
 * stops everything (`lambda stop --all`).
 *
 * First-run setup is web pages the mothership serves (`/setup`); the window
 * shows them and adds only the native folder picker, through the preload
 * bridge.
 */
import { execFile } from 'child_process';
import {
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  Notification,
  Tray,
  app,
  dialog,
  ipcMain,
  nativeImage,
  powerMonitor,
  shell,
  autoUpdater as squirrel,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { lambdaHome, loadMachineConfig } from '../src/config/machineConfig';
import {
  appLogDir,
  appStateFile,
  browsersDir,
  shimPath,
} from '../src/desktop/appPaths';
import { type AppLayout, appEnv, writeShim } from '../src/desktop/bundledTools';
import {
  decideNavigation,
  guardWindow,
  mayPickFolder,
} from '../src/desktop/navigation';
import { createQuitController } from '../src/desktop/quit';
import { remindSafely } from '../src/desktop/renewalReminder';
import {
  createPendingSecondInstances,
  openSignedIn,
  waitForMothership,
  windowOptions,
} from '../src/desktop/startup';
import {
  type AutoUpdaterLike,
  CHECK_ITEM,
  type UpdateMenu,
  type Updater,
  createUpdater,
  isDeveloperIdSigned,
} from '../src/desktop/updater';
import { mothershipDbPath } from '../src/mothership/db';
import { mintLoginLink } from '../src/mothership/loginLink';

/** The public repo the app updates from (its Releases). */
const RELEASES_REPO = 'adriancarriger/lambda';

/** How often the renewal reminder looks at the date. */
const REMINDER_CHECK_MS = 60 * 60 * 1000;

/** How long Quit waits for `lambda stop --all`. */
const STOP_TIMEOUT_MS = 20_000;

const home = os.homedir();

const layout: AppLayout = {
  // .../Lambda.app/Contents/MacOS/Lambda → .../Lambda.app
  bundle: path.resolve(process.execPath, '..', '..', '..'),
  resources: process.resourcesPath,
  electron: process.execPath,
  home,
};

const logFile = path.join(appLogDir(home), 'main.log');

const log = (line: string): void => {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // Nowhere else to say it.
  }
};

const env = appEnv(layout, process.env, browsersDir(home));

/** `lambda <args>` through the shim, from the home folder. */
const runLambda = (args: string[], timeoutMs?: number): Promise<number> =>
  new Promise((resolve) => {
    execFile(
      shimPath(home),
      args,
      { cwd: home, env, timeout: timeoutMs },
      (error, stdout, stderr) => {
        log(
          `lambda ${args.join(' ')}: ${error === null ? 'ok' : error.message}`
        );

        // `lambda open` can print a one-time login link: never into the log.
        const output = args[0] === 'open' ? stderr : `${stdout}${stderr}`;

        if (output.trim() !== '') {
          log(output.trim());
        }

        resolve(error === null ? 0 : 1);
      }
    );
  });

const state: {
  window: BrowserWindow | null;
  origin: string;
  tray: Tray | null;
  updater: Updater | null;
} = { window: null, origin: '', tray: null, updater: null };

const ending = createQuitController({
  stopLambda: async () => {
    await runLambda(['stop', '--all'], STOP_TIMEOUT_MS);
  },
  quit: () => app.quit(),
  install: () => autoUpdater.quitAndInstall(),
});

/** Any other https link opens in the default browser; nothing else ever opens. */
const openExternal = (url: string): void => {
  if (decideNavigation(url, state.origin) === 'external') {
    shell.openExternal(url).catch((error: unknown) => log(String(error)));
  }
};

const show = (): void => {
  state.window?.show();
  state.window?.focus();
};

const createWindow = (origin: string): BrowserWindow => {
  state.origin = origin;
  const window = new BrowserWindow(
    windowOptions(path.join(__dirname, 'preload.js'))
  );
  window.once('ready-to-show', () => window.show());
  guardWindow(window.webContents, () => state.origin, openExternal);
  // Closing hides: the icon stays and this Mac's runner keeps working.
  window.on('close', (event) => {
    if (ending.windowClose(event) === 'hide') {
      window.hide();
    }
  });
  state.window = window;

  return window;
};

const updateItem = (menu: UpdateMenu): MenuItemConstructorOptions => ({
  label: menu.label,
  click: () => state.updater?.click(),
});

const buildMenu = (): void => {
  const menu = Menu.buildFromTemplate([
    { label: 'Open Lambda', click: show },
    { label: 'Open in browser', click: () => void runLambda(['open']) },
    updateItem(state.updater?.menu() ?? CHECK_ITEM),
    {
      label: 'Run setup again…',
      click: () => {
        if (state.window !== null && state.origin !== '') {
          void state.window.loadURL(`${state.origin}/setup`);
          show();
        }
      },
    },
    { type: 'separator' },
    { label: 'Quit Lambda', click: () => void ending.quit() },
  ]);
  state.tray?.setContextMenu(menu);
};

/** electron-updater, as the tested updater sees it. */
const adapted: AutoUpdaterLike = {
  get autoDownload() {
    return autoUpdater.autoDownload;
  },
  set autoDownload(value) {
    autoUpdater.autoDownload = value;
  },
  get autoInstallOnAppQuit() {
    return autoUpdater.autoInstallOnAppQuit;
  },
  set autoInstallOnAppQuit(value) {
    autoUpdater.autoInstallOnAppQuit = value;
  },
  checkForUpdates: () => autoUpdater.checkForUpdates(),
  quitAndInstall: () => autoUpdater.quitAndInstall(),
  on: (event, listener) => {
    switch (event) {
      case 'error':
        return autoUpdater.on('error', listener);
      case 'update-available':
        return autoUpdater.on('update-available', listener);
      case 'update-downloaded':
        return autoUpdater.on('update-downloaded', listener);
    }
  },
};

/** Developer ID signed? Unsigned builds only offer a download. */
const checkSigned = (): Promise<boolean> =>
  new Promise((resolve) => {
    execFile(
      'codesign',
      ['-dv', '--verbose=2', layout.bundle],
      (_error, stdout, stderr) =>
        resolve(isDeveloperIdSigned(`${stdout}${stderr}`))
    );
  });

const remind = (): void => {
  remindSafely({
    now: Date.now(),
    readCreatedAt: () => loadMachineConfig(env)?.tokens?.claude?.createdAt,
    stateFile: appStateFile(home),
    notify: (title, body) => new Notification({ title, body }).show(),
    log,
  });
};

/** Second launches that arrive before the updater exists wait for it. */
const secondInstances = createPendingSecondInstances();

const start = async (): Promise<void> => {
  // powerMonitor works only once the app is ready.
  powerMonitor.on('shutdown', ending.shutdown);
  writeShim(layout);
  state.tray = new Tray(nativeImage.createEmpty());
  state.tray.setTitle('λ');
  state.tray.setToolTip('Lambda');
  buildMenu();

  ipcMain.handle('lambda:pick-folder', async (event) => {
    if (!mayPickFolder(event.senderFrame?.origin, state.origin)) {
      return null;
    }

    const options = {
      defaultPath: home,
      properties: ['openDirectory' as const, 'createDirectory' as const],
    };
    const picked =
      state.window === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(state.window, options);

    return picked.canceled ? null : picked.filePaths[0] ?? null;
  });

  // Not awaited: `lambda start` returns once things are up, and the ready
  // file is what this waits for.
  void runLambda(['start']);

  const opened = await openSignedIn({
    wait: () => waitForMothership({ lambdaHome: lambdaHome(env) }),
    mintLoginLink: (port) => mintLoginLink(mothershipDbPath(env), { port }),
    createWindow,
    showError: (title, message) => {
      dialog.showErrorBox(title, message);
    },
  });

  // The dialog has said why; with no mothership the menu would do nothing,
  // so the app stops (and stops whatever did start) rather than linger.
  if (!opened.ok) {
    await ending.quit();

    return;
  }

  const [owner = '', repo = ''] = RELEASES_REPO.split('/');
  const signed = await checkSigned();
  autoUpdater.setFeedURL({ provider: 'github', owner, repo });
  const updater = createUpdater({
    autoUpdater: adapted,
    signed,
    log,
    setMenu: () => buildMenu(),
    openExternal,
    setInterval: (run, ms) => setInterval(run, ms),
    restart: () => void ending.restartToUpdate(),
  });
  state.updater = updater;
  // Electron's own updater (Squirrel, which electron-updater drives on macOS)
  // says when it is about to quit to install.
  squirrel.on('before-quit-for-update', ending.quittingForUpdate);
  updater.start();
  secondInstances.ready((argv) => updater.secondInstance(argv));
  buildMenu();

  remind();
  setInterval(remind, REMINDER_CHECK_MS);
};

if (!app.requestSingleInstanceLock()) {
  // Opened a second time: the first one focuses its window instead.
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    secondInstances.arrived(argv);
    show();
  });
  // Keep running with no window: the menu-bar icon is the app.
  app.on('window-all-closed', () => undefined);
  app.on('activate', show);
  app.on('before-quit', ending.beforeQuit);
  app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      log(`start failed: ${String(error)}`);
      dialog.showErrorBox(
        "Lambda couldn't start",
        error instanceof Error ? error.message : String(error)
      );
    });
}
