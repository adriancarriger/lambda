import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { WebSocketServer } from 'ws';

import { required } from '../../__tests__/required';
import {
  eventually,
  startHarness,
  tempHome,
} from '../../mothership/__tests__/harness';
import { addRunner } from '../../mothership/registry';
import { createRunnerClient } from '../client';
import { generateRunnerKeys } from '../keys';
import { createOutbox } from '../outbox';

describe('the runner socket staying honest', () => {
  const homes: string[] = [];
  /** Stopped after each test, passed or not: a live socket keeps jest up. */
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }

    homes
      .splice(0)
      .forEach((home) => fs.rmSync(home, { recursive: true, force: true }));
  });

  const outbox = () => {
    const home = tempHome();
    homes.splice(homes.length, 0, home);

    return createOutbox(path.join(home, 'outbox.jsonl'));
  };

  it('drops a socket that stopped answering pings, and reconnects', async () => {
    // A mothership that went quiet (a half-open connection): no pongs.
    const server = new WebSocketServer({ port: 0, autoPong: false });
    cleanups.splice(
      cleanups.length,
      0,
      () =>
        new Promise<void>((resolve) => {
          server.clients.forEach((socket) => socket.terminate());
          server.close(() => resolve());
        })
    );
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    const port =
      typeof address === 'object' && address !== null ? address.port : 0;
    const scheduled: { delays: number[] } = { delays: [] };
    const client = createRunnerClient({
      url: `http://127.0.0.1:${port}`,
      runnerId: 'rnr_quiet',
      privateKey: generateRunnerKeys().privateKey,
      outbox: outbox(),
      handle: async () => null,
      log: () => undefined,
      pingEveryMs: 30,
      schedule: (_fn, ms) => {
        scheduled.delays = [...scheduled.delays, ms];
      },
    });

    cleanups.splice(cleanups.length, 0, () => client.stop());
    client.start();
    await eventually(() => scheduled.delays.length === 1);

    expect(scheduled.delays).toEqual([1000]);
  });

  it('drops a socket that never finishes connecting, without pinging it', async () => {
    // Takes the connection and never answers the upgrade: the socket stays
    // CONNECTING, where a ping throws.
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => {
      sockets.splice(sockets.length, 0, socket);
    });
    cleanups.splice(
      cleanups.length,
      0,
      () =>
        new Promise<void>((resolve) => {
          sockets.forEach((socket) => socket.destroy());
          server.close(() => resolve());
        })
    );
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    const port =
      typeof address === 'object' && address !== null ? address.port : 0;
    const scheduled: { delays: number[] } = { delays: [] };
    const client = createRunnerClient({
      url: `http://127.0.0.1:${port}`,
      runnerId: 'rnr_stuck',
      privateKey: generateRunnerKeys().privateKey,
      outbox: outbox(),
      handle: async () => null,
      log: () => undefined,
      pingEveryMs: 30,
      schedule: (_fn, ms) => {
        scheduled.delays = [...scheduled.delays, ms];
      },
    });

    cleanups.splice(cleanups.length, 0, () => client.stop());
    client.start();
    await eventually(() => scheduled.delays.length === 1);

    expect(scheduled.delays).toEqual([1000]);
  });

  it('reads its key again after Lambda refuses it, and says so', async () => {
    const harness = await startHarness();
    cleanups.splice(cleanups.length, 0, () => harness.close());
    const stale = generateRunnerKeys();
    const fresh = generateRunnerKeys();
    addRunner(
      harness.db,
      { id: 'rnr_fresh', name: "Leslie's MacBook", publicKey: fresh.publicKey },
      1
    );
    // The mothership was reset: `lambda start` wrote a new key and id.
    const config = { runnerId: 'rnr_stale', privateKey: stale.privateKey };
    const logs: string[] = [];
    const retries: (() => void)[] = [];
    const client = createRunnerClient({
      url: `http://127.0.0.1:${harness.port}`,
      runnerId: config.runnerId,
      privateKey: config.privateKey,
      credentials: () => config,
      outbox: outbox(),
      handle: async () => null,
      log: (line) => logs.splice(logs.length, 0, line),
      schedule: (fn) => {
        retries.splice(retries.length, 0, fn);
      },
    });

    cleanups.splice(cleanups.length, 0, () => client.stop());
    client.start();
    await eventually(() => retries.length === 1);
    config.runnerId = 'rnr_fresh';
    config.privateKey = fresh.privateKey;
    required(retries[0], 'retry')();
    await eventually(() => client.isConnected());

    expect(logs).toContain(
      "Lambda refused this computer's key. It's read again for the next try; if this keeps happening, run lambda leave, then lambda join."
    );
  });
});
