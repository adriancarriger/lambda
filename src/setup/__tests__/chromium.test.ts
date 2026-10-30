import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';

import { browsersDir } from '../../desktop/appPaths';
import { type ChildLike, createChromiumInstaller } from '../chromium';

const fakeChild = () => {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child: ChildLike = {
    stdout,
    stderr,
    on: (event, listener) => events.on(event, listener),
  };

  return {
    child,
    print: (text: string) => stdout.write(text),
    close: (code: number) => events.emit('close', code),
    fail: (error: Error) => events.emit('error', error),
  };
};

/** A Chromium build in the folder; `complete` writes Playwright's marker. */
const chromiumIn = (home: string, complete: boolean): void => {
  const build = path.join(browsersDir(home), 'chromium-1187');
  fs.mkdirSync(build, { recursive: true });

  if (complete) {
    fs.writeFileSync(path.join(build, 'INSTALLATION_COMPLETE'), '');
  }
};

const IN_APP = { LAMBDA_APP_BUNDLE: '/Applications/Lambda.app' };

describe('the browser agents test with', () => {
  const tempHome = () =>
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-chromium-'));

  it('shows the last lines and offers a retry when the download fails', async () => {
    const fake = fakeChild();
    const spawnInstaller = jest.fn(() => fake.child);
    const installer = createChromiumInstaller({
      env: IN_APP,
      home: tempHome(),
      spawnInstaller,
    });

    installer.start();
    fake.print(
      'Downloading Chromium 140 - 172 MiB [====    ] 43%\nError: ECONNRESET\n'
    );
    await new Promise((resolve) => setImmediate(resolve));
    fake.close(1);

    expect(installer.state()).toEqual({
      phase: 'failed',
      lines: [
        'Downloading Chromium 140 - 172 MiB [====    ] 43%',
        'Error: ECONNRESET',
      ],
    });

    // Reading the state again doesn't retry; Retry does.
    installer.start();
    expect(spawnInstaller).toHaveBeenCalledTimes(1);
    installer.retry();
    expect(spawnInstaller).toHaveBeenCalledTimes(2);
  });

  it('reports the percentage and points PLAYWRIGHT_BROWSERS_PATH at the app folder', async () => {
    const home = tempHome();
    const fake = fakeChild();
    const spawnInstaller = jest.fn(() => fake.child);
    const installer = createChromiumInstaller({
      env: IN_APP,
      home,
      spawnInstaller,
    });

    installer.start();
    fake.print('|■■■■■■■■■        |  52% of 172 MiB');
    await new Promise((resolve) => setImmediate(resolve));

    expect(installer.state()).toEqual({ phase: 'installing', percent: 52 });
    expect(spawnInstaller.mock.calls[0]).toEqual([
      expect.objectContaining({ PLAYWRIGHT_BROWSERS_PATH: browsersDir(home) }),
    ]);

    fake.close(0);
    expect(installer.state()).toEqual({ phase: 'done' });
  });

  it('downloads again over a half-finished one (no INSTALLATION_COMPLETE)', () => {
    const home = tempHome();
    chromiumIn(home, false);
    const spawnInstaller = jest.fn(() => fakeChild().child);
    const installer = createChromiumInstaller({
      env: IN_APP,
      home,
      spawnInstaller,
    });

    installer.start();

    expect(spawnInstaller).toHaveBeenCalledTimes(1);
  });

  it('fails the step, with Retry, when the installer cannot start', () => {
    const spawnInstaller = jest.fn(
      (): ReturnType<typeof fakeChild>['child'] => {
        throw new Error("Cannot find module 'playwright/cli'");
      }
    );
    const installer = createChromiumInstaller({
      env: IN_APP,
      home: tempHome(),
      spawnInstaller,
    });

    expect(() => installer.start()).not.toThrow();
    expect(installer.state()).toEqual({
      phase: 'failed',
      lines: [
        "Couldn't start Playwright's installer: Cannot find module 'playwright/cli'",
      ],
    });
    installer.retry();
    expect(spawnInstaller).toHaveBeenCalledTimes(2);
  });

  it("fails the step on the child's error event, never leaving it unhandled", () => {
    const fake = fakeChild();
    const installer = createChromiumInstaller({
      env: IN_APP,
      home: tempHome(),
      spawnInstaller: () => fake.child,
    });

    installer.start();

    expect(() => fake.fail(new Error('spawn ENOENT'))).not.toThrow();
    expect(installer.state()).toEqual({
      phase: 'failed',
      lines: ["Couldn't start Playwright's installer: spawn ENOENT"],
    });
  });

  it("keeps the spawn error's reason when close follows it, as Node sends", () => {
    const fake = fakeChild();
    const installer = createChromiumInstaller({
      env: IN_APP,
      home: tempHome(),
      spawnInstaller: () => fake.child,
    });

    installer.start();
    fake.fail(new Error('spawn ENOENT'));
    fake.close(-2);

    expect(installer.state()).toEqual({
      phase: 'failed',
      lines: ["Couldn't start Playwright's installer: spawn ENOENT"],
    });
  });

  it('tells the pages only when the percentage moves', async () => {
    const fake = fakeChild();
    const onChange = jest.fn();
    const installer = createChromiumInstaller({
      env: IN_APP,
      home: tempHome(),
      spawnInstaller: () => fake.child,
      onChange,
    });

    installer.start();
    const atStart = onChange.mock.calls.length;

    // One chunk at a time, so each is its own `data` event.
    for (const text of [
      '  52% of 172 MiB',
      '\r  52% of 172 MiB',
      '\r  52% of 172 MiB',
      '\r  53% of 172 MiB',
    ]) {
      fake.print(text);
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(installer.state()).toEqual({ phase: 'installing', percent: 53 });
    expect(onChange.mock.calls.length - atStart).toBe(2);
  });

  it("doesn't spawn when Chromium is already in the folder", () => {
    const home = tempHome();
    chromiumIn(home, true);
    const spawnInstaller = jest.fn(() => fakeChild().child);
    const installer = createChromiumInstaller({
      env: IN_APP,
      home,
      spawnInstaller,
    });

    installer.start();

    expect(spawnInstaller).not.toHaveBeenCalled();
    expect(installer.state()).toEqual({ phase: 'done' });
  });

  it("doesn't spawn outside the Mac app", () => {
    const spawnInstaller = jest.fn(() => fakeChild().child);
    const installer = createChromiumInstaller({
      env: {},
      home: tempHome(),
      spawnInstaller,
    });

    installer.start();

    expect(spawnInstaller).not.toHaveBeenCalled();
    expect(installer.state()).toEqual({ phase: 'not-app' });
  });
});
