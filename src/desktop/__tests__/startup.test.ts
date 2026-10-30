import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { writeReadyFile } from '../../mothership/readyFile';
import {
  CANT_START_TITLE,
  createPendingSecondInstances,
  openSignedIn,
  waitForMothership,
  windowOptions,
} from '../startup';

describe("the app window's options", () => {
  it('opens hidden, so no blank window shows while the page loads', () => {
    expect(windowOptions('/app/preload.js').show).toBe(false);
  });

  it('keeps the renderer sandboxed and isolated, with only the preload', () => {
    expect(windowOptions('/app/preload.js').webPreferences).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: '/app/preload.js',
    });
  });
});

describe('opening the Mac app', () => {
  afterEach(() => jest.useRealTimers());

  const lambdaHome = () =>
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-start-'));

  it('gives up after 30 s with the log path and its last 20 lines, and opens no window', async () => {
    jest.useFakeTimers();
    const home = lambdaHome();
    fs.writeFileSync(
      path.join(home, 'mothership.log'),
      `${Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join(
        '\n'
      )}\n`
    );
    const createWindow = jest.fn();
    const showError = jest.fn((_title: string, _message: string) => undefined);

    const opening = openSignedIn({
      wait: () => waitForMothership({ lambdaHome: home }),
      mintLoginLink: () => 'http://127.0.0.1:1/auth/link?t=x',
      createWindow,
      showError,
    });
    await jest.advanceTimersByTimeAsync(29_750);

    expect(showError).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(500);

    expect(await opening).toEqual({ ok: false });
    expect(createWindow).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledTimes(1);

    const [title, message] = showError.mock.calls[0] ?? ['', ''];
    expect(title).toBe(CANT_START_TITLE);
    expect(message).toContain(path.join(home, 'mothership.log'));
    expect(message).toContain('line 6\nline 7');
    expect(message).toContain('line 25');
    expect(message).not.toContain('line 5\n');
  });

  it('opens the window on the minted login link once the ready file appears', async () => {
    jest.useFakeTimers();
    const home = lambdaHome();
    const loaded: string[] = [];
    const origins: string[] = [];

    const opening = openSignedIn({
      wait: () => waitForMothership({ lambdaHome: home }),
      mintLoginLink: (port) => `http://127.0.0.1:${port}/auth/link?t=one-time`,
      createWindow: (origin) => {
        origins.splice(origins.length, 0, origin);

        return {
          loadURL: async (url) => {
            loaded.splice(loaded.length, 0, url);
          },
        };
      },
      showError: () => undefined,
    });

    await jest.advanceTimersByTimeAsync(2000);
    // A live pid: a ready file only counts while its mothership is running.
    writeReadyFile(home, { pid: process.pid, port: 4581 });
    await jest.advanceTimersByTimeAsync(250);

    expect(await opening).toMatchObject({ ok: true, port: 4581 });
    expect(origins).toEqual(['http://127.0.0.1:4581']);
    expect(loaded).toEqual(['http://127.0.0.1:4581/auth/link?t=one-time']);
  });

  it("ignores a ready file left by a mothership that's gone (killed, power cut)", async () => {
    jest.useFakeTimers();
    const home = lambdaHome();
    const gone = spawnSync('true').pid;

    if (gone === undefined) {
      throw new Error('No pid for the finished process.');
    }

    writeReadyFile(home, { pid: gone, port: 4581 });

    const waiting = waitForMothership({ lambdaHome: home, timeoutMs: 1000 });
    await jest.advanceTimersByTimeAsync(1250);

    expect(await waiting).toMatchObject({ ok: false });
  });

  it("says Lambda couldn't start when the window can't load the page", async () => {
    const showError = jest.fn((_title: string, _message: string) => undefined);

    expect(
      await openSignedIn({
        wait: async () => ({ ok: true, port: 4581 }),
        mintLoginLink: (port) => `http://127.0.0.1:${port}/auth/link?t=x`,
        createWindow: () => ({
          loadURL: async () => {
            throw new Error(
              'ERR_CONNECTION_REFUSED (-102) loading http://127.0.0.1:4581/'
            );
          },
        }),
        showError,
      })
    ).toEqual({ ok: false });
    expect(showError.mock.calls[0]?.[0]).toBe(CANT_START_TITLE);
    expect(showError.mock.calls[0]?.[1]).toContain('ERR_CONNECTION_REFUSED');
  });
});

describe('a check for updates asked for before the updater exists', () => {
  it('waits, then runs once the updater is ready, and runs straight away after', () => {
    const later = createPendingSecondInstances();
    const seen: string[][] = [];

    later.arrived(['--check-for-updates']);
    expect(seen).toEqual([]);

    later.ready((argv) => seen.splice(seen.length, 0, argv));
    expect(seen).toEqual([['--check-for-updates']]);

    later.arrived(['--check-for-updates']);
    expect(seen).toHaveLength(2);
  });
});
