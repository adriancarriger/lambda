import * as fs from 'fs';
import * as path from 'path';
import { WebSocketServer } from 'ws';

import { eventually, tempHome } from '../../mothership/__tests__/harness';
import { createRunnerClient } from '../client';
import { generateRunnerKeys } from '../keys';
import { createOutbox } from '../outbox';

describe('the runner flushing its outbox on connect', () => {
  /** Stopped after each test, passed or not: a live socket keeps jest up. */
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });

  it('sends an item enqueued while connecting exactly once', async () => {
    const home = tempHome();
    cleanups.splice(cleanups.length, 0, () =>
      fs.rmSync(home, { recursive: true, force: true })
    );
    // A mothership that lets the runner straight in and records what arrives.
    const server = new WebSocketServer({ port: 0 });
    const received: string[] = [];
    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        received.splice(received.length, 0, data.toString());
      });
      socket.send(JSON.stringify({ type: 'owner', name: 'Ann Perkins' }));
    });
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
    const outbox = createOutbox(path.join(home, 'outbox.jsonl'));
    outbox.add({ id: 'evt_older', type: 'event' });
    const client = createRunnerClient({
      url: `http://127.0.0.1:${port}`,
      runnerId: 'rnr_pawnee',
      privateKey: generateRunnerKeys().privateKey,
      outbox,
      handle: async () => null,
      log: () => undefined,
      // The runtime reports its state the moment it is connected.
      onConnected: (connected) => {
        if (connected) {
          client.enqueue({ id: 'state_pawnee', type: 'runner-state' });
        }
      },
      schedule: () => undefined,
    });

    cleanups.splice(cleanups.length, 0, () => client.stop());
    client.start();
    await eventually(() => received.length >= 2);
    // Long enough for a duplicate to land, if one is coming.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received.map((raw) => JSON.parse(raw).id)).toEqual([
      'evt_older',
      'state_pawnee',
    ]);
  });
});
