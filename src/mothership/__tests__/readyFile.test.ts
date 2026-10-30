import { type ChildProcess, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  portArg,
  readReadyFile,
  readyFilePath,
  removeReadyFile,
  writeReadyFile,
} from '../readyFile';

const PACKAGE = path.resolve(__dirname, '..', '..', '..');
const JITI = path.join(PACKAGE, 'node_modules', '.bin', 'jiti');

const until = async (check: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  const attempt = async (): Promise<boolean> => {
    if (check()) {
      return true;
    }

    if (Date.now() > deadline) {
      return false;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));

    return attempt();
  };

  return attempt();
};

describe('the mothership ready file', () => {
  const children: ChildProcess[] = [];

  afterEach(() => {
    children.splice(0).forEach((child) => child.kill('SIGKILL'));
  });

  it('holds the pid and the bound port once listening, and is gone after SIGTERM', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-ready-'));
    const child = spawn(
      JITI,
      [path.join(PACKAGE, 'src', 'mothership', 'main.ts'), '--port', '0'],
      {
        env: { ...process.env, LAMBDA_HOME: home, HOME: home },
        stdio: 'ignore',
      }
    );
    children.splice(children.length, 0, child);

    expect(await until(() => readReadyFile(home) !== null, 20_000)).toBe(true);

    const ready = readReadyFile(home);
    expect(ready?.port).toBeGreaterThan(0);
    expect(ready?.pid).toBeGreaterThan(0);

    const response = await fetch(`http://127.0.0.1:${ready?.port}/api/session`);
    expect(response.headers.get('x-lambda')).toBe('mothership');

    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;

    expect(fs.existsSync(readyFilePath(home))).toBe(false);
  }, 30_000);

  describe('on disk', () => {
    const dirs: string[] = [];
    const home = (): string => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-ready-'));
      dirs.splice(dirs.length, 0, dir);

      return dir;
    };

    afterEach(() => {
      dirs
        .splice(0)
        .forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
    });

    it('is replaced whole, never rewritten in place where a reader could catch it half-written', () => {
      const dir = home();
      writeReadyFile(dir, { pid: process.pid, port: 4100 });
      const before = fs.statSync(readyFilePath(dir)).ino;

      writeReadyFile(dir, { pid: process.pid, port: 4200 });

      expect(fs.statSync(readyFilePath(dir)).ino).not.toBe(before);
      expect(readReadyFile(dir)).toEqual({ pid: process.pid, port: 4200 });
      expect(fs.readdirSync(dir)).toEqual(['mothership.ready']);
    });

    it('reads as none when the mothership that wrote it is gone', () => {
      const dir = home();
      const gone = spawnSync('true').pid;
      fs.writeFileSync(
        readyFilePath(dir),
        `${JSON.stringify({ pid: gone, port: 4100 })}\n`
      );

      expect(readReadyFile(dir)).toBeNull();
    });

    it("leaves another mothership's file alone", () => {
      const dir = home();
      fs.writeFileSync(
        readyFilePath(dir),
        `${JSON.stringify({ pid: process.ppid, port: 4100 })}\n`
      );

      removeReadyFile(dir);

      expect(readReadyFile(dir)).toEqual({ pid: process.ppid, port: 4100 });

      writeReadyFile(dir, { pid: process.pid, port: 4200 });
      removeReadyFile(dir);

      expect(fs.existsSync(readyFilePath(dir))).toBe(false);
    });
  });

  it('reads --port from argv', () => {
    expect(portArg(['node', 'main.js', '--port', '0'])).toBe(0);
    expect(portArg(['node', 'main.js'])).toBeUndefined();
    expect(() => portArg(['node', 'main.js', '--port', 'x'])).toThrow(
      "--port x isn't a port."
    );
  });
});
