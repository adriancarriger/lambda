import { upgradeCommand } from '../../commands/upgrade';
import {
  type AutoUpdaterLike,
  CHECK_EVERY_MS,
  type UpdateMenu,
  createUpdater,
  isDeveloperIdSigned,
} from '../updater';

const fakeAutoUpdater = (check: () => Promise<unknown> = async () => null) => {
  const listeners = new Map<string, ((arg: unknown) => void)[]>();
  const updater: AutoUpdaterLike & {
    emit: (event: string, arg?: unknown) => void;
    checks: number;
    installs: number;
  } = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    checks: 0,
    installs: 0,
    checkForUpdates: () => {
      updater.checks += 1;

      return check();
    },
    quitAndInstall: () => {
      updater.installs += 1;
    },
    on: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    emit: (event, arg) =>
      (listeners.get(event) ?? []).forEach((listener) => listener(arg)),
  };

  return updater;
};

const setup = (signed: boolean, check?: () => Promise<unknown>) => {
  const autoUpdater = fakeAutoUpdater(check);
  const menus: UpdateMenu[] = [];
  const logged: string[] = [];
  const opened: string[] = [];
  const intervals: [() => void, number][] = [];
  const restarts: string[] = [];
  const updater = createUpdater({
    autoUpdater,
    signed,
    log: (line) => logged.splice(logged.length, 0, line),
    setMenu: (menu) => menus.splice(menus.length, 0, menu),
    openExternal: (url) => opened.splice(opened.length, 0, url),
    setInterval: (run, ms) => intervals.splice(intervals.length, 0, [run, ms]),
    restart: () => restarts.splice(restarts.length, 0, 'restart'),
  });

  return { autoUpdater, updater, menus, logged, opened, intervals, restarts };
};

describe('updates', () => {
  it('checks at launch and every 6 hours', () => {
    const { autoUpdater, updater, intervals } = setup(true);

    updater.start();

    expect(autoUpdater.checks).toBe(1);
    expect(intervals.map(([, ms]) => ms)).toEqual([CHECK_EVERY_MS]);
    intervals[0]?.[0]();
    expect(autoUpdater.checks).toBe(2);
  });

  it('signed: downloads in the background and installs only on Quit or the button', () => {
    const { autoUpdater, updater, menus, restarts } = setup(true);

    expect(autoUpdater.autoDownload).toBe(true);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);

    updater.start();
    autoUpdater.emit('update-available', { version: '0.4.0' });
    autoUpdater.emit('update-downloaded', { version: '0.4.0' });

    expect(autoUpdater.installs).toBe(0);
    expect(menus.at(-1)).toEqual({
      kind: 'restart',
      label: 'Restart to update',
    });

    // The button stops Lambda and installs (src/desktop/quit.ts), never the updater alone.
    updater.click();
    expect(restarts).toEqual(['restart']);
    expect(autoUpdater.installs).toBe(0);
  });

  it('unsigned: only offers Download version X.Y.Z, which opens that Release', () => {
    const { autoUpdater, updater, menus, opened } = setup(false);

    expect(autoUpdater.autoDownload).toBe(false);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);

    updater.start();
    autoUpdater.emit('update-available', { version: '0.4.0' });
    autoUpdater.emit('update-downloaded', { version: '0.4.0' });

    expect(menus).toEqual([
      {
        kind: 'download',
        label: 'Download version 0.4.0',
        url: 'https://github.com/adriancarriger/lambda/releases/tag/v0.4.0',
      },
    ]);

    updater.click();

    expect(opened).toEqual([
      'https://github.com/adriancarriger/lambda/releases/tag/v0.4.0',
    ]);
    expect(autoUpdater.installs).toBe(0);
  });

  it('treats an ad-hoc signature as unsigned', () => {
    expect(
      isDeveloperIdSigned(
        [
          'Executable=/Applications/Lambda.app/Contents/MacOS/Lambda',
          'Identifier=Lambda',
          'CodeDirectory v=20400 size=500 flags=0x20002(adhoc,linker-signed)',
          'Signature=adhoc',
          'TeamIdentifier=not set',
        ].join('\n')
      )
    ).toBe(false);
    expect(
      isDeveloperIdSigned(
        'Authority=Developer ID Application: Pawnee Parks (AB12CD34EF)\nAuthority=Developer ID Certification Authority\n'
      )
    ).toBe(true);
  });

  it('logs a failed check, shows no dialog and leaves the menu as it was', async () => {
    const { autoUpdater, updater, menus, logged } = setup(true, async () => {
      throw new Error('getaddrinfo ENOTFOUND github.com');
    });

    updater.start();
    autoUpdater.emit('error', new Error('download failed'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(logged).toEqual([
      'Update check failed: download failed',
      'Update check failed: getaddrinfo ENOTFOUND github.com',
    ]);
    expect(menus).toEqual([]);
    expect(updater.menu()).toEqual({
      kind: 'check',
      label: 'Check for updates',
    });
  });

  it('runs one check when a second launch asks for it', () => {
    const { autoUpdater, updater } = setup(true);

    updater.secondInstance(['/Applications/Lambda.app/Contents/MacOS/Lambda']);
    expect(autoUpdater.checks).toBe(0);

    updater.secondInstance([
      '/Applications/Lambda.app/Contents/MacOS/Lambda',
      '--check-for-updates',
    ]);
    expect(autoUpdater.checks).toBe(1);
  });

  /**
   * What macOS's `open` does with a running app (`man open`): without `-n`
   * it brings that copy to the front and passes no arguments; with `-n` it
   * starts another copy with them, which Electron's single-instance lock
   * turns into the first copy's `second-instance` event.
   */
  const openWhileRunning = (
    args: string[],
    secondInstance: (argv: string[]) => void
  ): void => {
    if (args.includes('-n')) {
      secondInstance([
        '/Applications/Lambda.app/Contents/MacOS/Lambda',
        ...args.slice(args.indexOf('--args') + 1),
      ]);
    }
  };

  it('checks when lambda upgrade runs while the app is open', () => {
    const { autoUpdater, updater } = setup(true);
    const [command, args] = upgradeCommand({
      LAMBDA_APP_BUNDLE: '/Applications/Lambda.app',
    });

    expect(command).toBe('open');
    openWhileRunning(args, updater.secondInstance);
    expect(autoUpdater.checks).toBe(1);
  });
});
