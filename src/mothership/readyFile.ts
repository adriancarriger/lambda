import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

/**
 * `~/.lambda/mothership.ready`: `{ pid, port }`, written once the mothership
 * is listening and deleted when it stops. The Mac app waits for it before it
 * opens its window, so it never shows a page that isn't there yet.
 */

export const READY_FILE = 'mothership.ready';

export interface Ready {
  pid: number;
  port: number;
}

export const readyFilePath = (home: string): string =>
  path.join(home, READY_FILE);

/** Written beside it, then renamed over it: a reader never sees half of it. */
export const writeReadyFile = (home: string, ready: Ready): void => {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = readyFilePath(home);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(ready)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
};

/** Only this process's file: a second mothership's stays where it is. */
export const removeReadyFile = (home: string): void => {
  if (readReadyFile(home)?.pid !== process.pid) {
    return;
  }

  fs.rmSync(readyFilePath(home), { force: true });
};

/** Is that process running? (EPERM: running, as someone else.) */
const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EPERM'
    );
  }
};

/**
 * The ready file, or null while there is none, it's half-written, or its
 * mothership is gone: a SIGKILL or a power cut leaves the file behind.
 */
export const readReadyFile = (home: string): Ready | null => {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(readyFilePath(home), 'utf8')
    );

    return typeof parsed === 'object' &&
      parsed !== null &&
      'pid' in parsed &&
      'port' in parsed &&
      typeof parsed.pid === 'number' &&
      typeof parsed.port === 'number' &&
      isRunning(parsed.pid)
      ? { pid: parsed.pid, port: parsed.port }
      : null;
  } catch {
    return null;
  }
};

/** `--port <n>` from argv, or undefined. */
export const portArg = (argv: string[]): number | undefined => {
  const index = argv.indexOf('--port');
  const value = index === -1 ? undefined : argv[index + 1];

  if (value === undefined) {
    return undefined;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`--port ${value} isn't a port.`);
  }

  return port;
};

/** A port free on 127.0.0.1 right now (for `--port 0`). */
export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
