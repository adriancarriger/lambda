/**
 * The Mac app's updates, from GitHub Releases on the public repo.
 *
 * Signed (Developer ID): electron-updater checks at launch and every 6 hours,
 * downloads in the background, and installs on Quit or from "Restart to
 * update". It never restarts the app by itself.
 *
 * Unsigned (the first releases): macOS can't install an update into an app
 * without a Developer ID signature, so it only checks, and offers "Download
 * version X.Y.Z", which opens that Release in the browser.
 *
 * Either way, a failed check or download is logged, the menu stays as it
 * was, and the next 6-hour check tries again. No error dialog.
 */

export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export const RELEASES_URL = 'https://github.com/adriancarriger/lambda/releases';

export const CHECK_FOR_UPDATES_ARG = '--check-for-updates';

export type UpdateMenu =
  | { kind: 'check'; label: 'Check for updates' }
  | { kind: 'restart'; label: 'Restart to update' }
  | { kind: 'download'; label: string; url: string };

export const CHECK_ITEM: UpdateMenu = {
  kind: 'check',
  label: 'Check for updates',
};

/** The parts of electron-updater's autoUpdater this uses. */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates: () => Promise<unknown>;
  quitAndInstall: () => void;
  on: (event: UpdaterEvent, listener: (arg: unknown) => void) => unknown;
}

export type UpdaterEvent = 'error' | 'update-available' | 'update-downloaded';

/**
 * Signed with a Developer ID, by `codesign -dv --verbose=2`'s output (it
 * prints to stderr). `codesign --verify` alone isn't enough: arm64 builds
 * are always ad-hoc signed, and an ad-hoc signature verifies.
 */
export const isDeveloperIdSigned = (codesignOutput: string): boolean =>
  /^Authority=Developer ID Application:/m.test(codesignOutput);

const versionOf = (info: unknown): string | null =>
  typeof info === 'object' &&
  info !== null &&
  'version' in info &&
  typeof info.version === 'string'
    ? info.version
    : null;

export interface UpdaterDeps {
  autoUpdater: AutoUpdaterLike;
  signed: boolean;
  log: (line: string) => void;
  /** The menu item changed: rebuild the tray menu. */
  setMenu: (item: UpdateMenu) => void;
  openExternal: (url: string) => void;
  setInterval: (run: () => void, ms: number) => unknown;
  /** Restart to update: stop Lambda, then electron-updater's quitAndInstall. */
  restart: () => void;
}

export interface Updater {
  /** At launch: check now and every 6 hours after. */
  start: () => void;
  check: () => void;
  /** The update menu item was clicked. */
  click: () => void;
  /** A second launch's argv (`lambda upgrade` sends `--check-for-updates`). */
  secondInstance: (argv: string[]) => void;
  menu: () => UpdateMenu;
}

export const createUpdater = (deps: UpdaterDeps): Updater => {
  const { autoUpdater } = deps;
  const state: { menu: UpdateMenu } = { menu: CHECK_ITEM };
  const setMenu = (menu: UpdateMenu) => {
    state.menu = menu;
    deps.setMenu(menu);
  };

  autoUpdater.autoDownload = deps.signed;
  // Signed: a downloaded update goes in when the person quits.
  autoUpdater.autoInstallOnAppQuit = deps.signed;

  autoUpdater.on('error', (error) => {
    deps.log(
      `Update check failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  });

  if (deps.signed) {
    autoUpdater.on('update-downloaded', () =>
      setMenu({ kind: 'restart', label: 'Restart to update' })
    );
  } else {
    autoUpdater.on('update-available', (info) => {
      const version = versionOf(info);

      if (version !== null) {
        setMenu({
          kind: 'download',
          label: `Download version ${version}`,
          url: `${RELEASES_URL}/tag/v${version}`,
        });
      }
    });
  }

  const check = () => {
    autoUpdater.checkForUpdates().catch((error: unknown) => {
      deps.log(
        `Update check failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  };

  return {
    start: () => {
      check();
      deps.setInterval(check, CHECK_EVERY_MS);
    },
    check,
    click: () => {
      const { menu } = state;

      switch (menu.kind) {
        case 'check':
          check();

          return;
        case 'restart':
          deps.restart();

          return;
        case 'download':
          deps.openExternal(menu.url);
      }
    },
    secondInstance: (argv) => {
      if (argv.includes(CHECK_FOR_UPDATES_ARG)) {
        check();
      }
    },
    menu: () => state.menu,
  };
};
