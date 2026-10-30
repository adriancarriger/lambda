import * as fs from 'fs';
import * as path from 'path';

import { lambdaHome, loadMachineConfig } from '../config/machineConfig';
import { checkTailscale, saveListenFields } from '../runner/tailscale';
import { mothershipDbPath, openDb } from './db';
import { type Listeners, startListeners } from './listen';
import { liveConfig } from './liveConfig';
import { mothershipPort } from './loginLink';
import {
  freePort,
  portArg,
  removeReadyFile,
  writeReadyFile,
} from './readyFile';
import { createMothership } from './server';

/**
 * The mothership process: `node dist/mothership.js`, started by
 * `lambda start` on the computer running Lambda. One SQLite file, the app,
 * and the runners' sockets.
 */

const PID_FILE = 'mothership.pid';

/**
 * Print the line, keep it in `~/.lambda/mothership.log` (where `lambda
 * start` reads why it didn't come up) and exit 1.
 */
const fatal = (home: string, line: string): never => {
  console.error(line);

  try {
    fs.mkdirSync(home, { recursive: true });
    fs.appendFileSync(path.join(home, 'mothership.log'), `${line}\n`);
  } catch {
    // The line is on screen anyway.
  }

  process.exit(1);
};

const main = async (): Promise<void> => {
  const config = loadMachineConfig();
  // `--port` (tests), else mothership.port; 0 picks a free one.
  const asked =
    portArg(process.argv) ?? mothershipPort(config?.mothership?.port);
  const port = asked === 0 ? await freePort() : asked;
  const home = lambdaHome();
  const db = openDb(mothershipDbPath());
  const log = (line: string) =>
    console.error(`[${new Date().toISOString()}] ${line}`);
  // The listeners take the mothership's handlers, so they come after it.
  const started: { listeners: Listeners | null } = { listeners: null };
  const mothership = createMothership({
    db,
    // Re-read: a name or alias changed while it runs is picked up.
    config: liveConfig({ load: loadMachineConfig, fallback: config, log }),
    port,
    clientDir: path.resolve(__dirname, 'app'),
    home,
    log,
    network: {
      tailscale: () => checkTailscale(),
      listenOn: async (address) => {
        if (started.listeners === null) {
          throw new Error('Lambda is still starting. Try again in a moment.');
        }

        await started.listeners.listenOn(address);
      },
      save: (fields) => saveListenFields(fields),
    },
  });

  const listeners = await startListeners({
    handle: mothership.handle,
    upgrade: mothership.upgrade,
    port,
    listen: config?.mothership?.listen,
    log,
    onFatal: (line) => {
      fatal(home, line);
    },
  });
  started.listeners = listeners;

  fs.writeFileSync(path.join(home, PID_FILE), String(process.pid), {
    mode: 0o600,
  });
  // Listening now: the Mac app opens its window once this appears.
  writeReadyFile(home, { pid: process.pid, port });
  process.on('exit', () => removeReadyFile(home));
  const ticker = setInterval(() => {
    mothership
      .tick()
      .catch((error: unknown) => log(`tick failed: ${String(error)}`));
  }, 15_000);
  // Belt and braces: pages refresh even when nothing pushes.
  const heartbeat = setInterval(mothership.broadcast, 5000);
  console.log(`Lambda server http://127.0.0.1:${port}`);

  const stop = () => {
    clearInterval(ticker);
    clearInterval(heartbeat);
    mothership.close();
    fs.rmSync(path.join(home, PID_FILE), { force: true });
    removeReadyFile(home);
    listeners.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
};

main().catch((error: unknown) => {
  fatal(lambdaHome(), error instanceof Error ? error.message : String(error));
});
