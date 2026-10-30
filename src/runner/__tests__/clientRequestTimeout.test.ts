import * as fs from 'fs';
import * as path from 'path';
import { WebSocketServer } from 'ws';

import { eventually, tempHome } from '../../mothership/__tests__/harness';
import { createRunnerClient } from '../client';
import { generateRunnerKeys } from '../keys';
import { createOutbox } from '../outbox';

/**
 * A request the mothership never answers (an older one that doesn't know
 * the message) must not hang its caller: the building tick waits on it.
 */
describe('a runner request with no answer', () => {
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });

  it('fails as unreachable once the timeout passes, socket still up', async () => {
    const home = tempHome();
    cleanups.splice(cleanups.length, 0, () =>
      fs.rmSync(home, { recursive: true, force: true })
    );
    // Lets the runner in, then ignores everything it sends.
    const server = new WebSocketServer({ port: 0 });
    server.on('connection', (socket) => {
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
    const client = createRunnerClient({
      url: `http://127.0.0.1:${port}`,
      runnerId: 'rnr_pawnee',
      privateKey: generateRunnerKeys().privateKey,
      outbox: createOutbox(path.join(home, 'outbox.jsonl')),
      handle: async () => null,
      log: () => undefined,
      schedule: () => undefined,
      requestTimeoutMs: 50,
    });

    cleanups.splice(cleanups.length, 0, () => client.stop());
    client.start();
    await eventually(() => client.isConnected());

    await expect(
      client.request({ id: 'req_claim', type: 'ticket-claim' })
    ).rejects.toThrow(/reach Lambda/);
    expect(client.isConnected()).toBe(true);
  });
});
