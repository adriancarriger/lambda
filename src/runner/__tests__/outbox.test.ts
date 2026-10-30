import * as fs from 'fs';
import * as path from 'path';
import { WebSocketServer } from 'ws';

import { required } from '../../__tests__/required';
import {
  type Harness,
  eventually,
  holdProject,
  startHarness,
  tempHome,
} from '../../mothership/__tests__/harness';
import { addRunner, newRunnerId } from '../../mothership/registry';
import { type RunnerClient, createRunnerClient } from '../client';
import { generateRunnerKeys } from '../keys';
import { createOutbox } from '../outbox';

const FOLDER = '/home/leslie/mac-mini/pawnee-parks';

describe('the outbox', () => {
  const fixture: {
    harness?: Harness;
    home?: string;
    client?: RunnerClient | null;
  } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');
  const home = (): string => required(fixture.home, 'home');
  const client = (): RunnerClient | null => required(fixture.client, 'client');

  beforeEach(async () => {
    fixture.harness = await startHarness();
    fixture.home = tempHome();
    fixture.client = null;
  });

  afterEach(async () => {
    client()?.stop();
    await harness().close();
    fs.rmSync(home(), { recursive: true, force: true });
  });

  const event = (id: string, name: string) => ({
    type: 'event',
    id,
    folder: FOLDER,
    event: {
      type: 'metric',
      name,
      value: 412,
      unit: 'KB',
      at: '2026-10-21T12:00:00.000Z',
    },
  });

  it('keeps what was sent offline and delivers it in order, once each', async () => {
    const keys = generateRunnerKeys();
    const runnerId = newRunnerId();
    addRunner(
      harness().db,
      { id: runnerId, name: "Leslie's Mac mini", publicKey: keys.publicKey },
      1
    );
    holdProject(harness(), runnerId, { folder: FOLDER });
    const file = path.join(home(), 'outbox.jsonl');
    const outbox = createOutbox(file);
    const connected: { values: boolean[] } = { values: [] };
    const started = createRunnerClient({
      url: `http://127.0.0.1:${harness().port}`,
      runnerId,
      privateKey: keys.privateKey,
      outbox,
      handle: async () => null,
      onConnected: (value) => {
        connected.values = [...connected.values, value];
      },
      log: () => undefined,
    });
    fixture.client = started;

    // Disconnected: three updates go to the file.
    started.enqueue(event('e1', 'bundle'));
    started.enqueue(event('e2', 'tests'));
    started.enqueue(event('e3', 'lighthouse'));

    expect(outbox.pending().map((item) => item.id)).toEqual(['e1', 'e2', 'e3']);

    started.start();
    await eventually(() => outbox.pending().length === 0);

    const stored = () =>
      harness()
        .db.prepare<
          [],
          {
            id: string;
            name: string;
          }
        >('SELECT id, name FROM events ORDER BY rowid')
        .all();

    expect(stored()).toEqual([
      { id: 'e1', name: 'bundle' },
      { id: 'e2', name: 'tests' },
      { id: 'e3', name: 'lighthouse' },
    ]);

    // The same one again (a resend after a crash): acknowledged, not stored twice.
    started.enqueue(event('e2', 'tests'));
    await eventually(() => outbox.pending().length === 0);

    expect(stored()).toHaveLength(3);
    expect(connected.values).toEqual([true]);
  });

  it('drops a still-unsent state that a newer one replaces', () => {
    const outbox = createOutbox(path.join(home(), 'outbox.jsonl'));
    const sameFolder = (other: { type: string; folder?: unknown }) =>
      other.type === 'pod-state' && other.folder === FOLDER;

    outbox.add({ type: 'pod-state', id: 's1', folder: FOLDER }, sameFolder);
    outbox.add({ type: 'event', id: 'e1', folder: FOLDER });
    outbox.add({ type: 'pod-state', id: 's2', folder: FOLDER }, sameFolder);

    expect(outbox.pending().map((item) => item.id)).toEqual(['e1', 's2']);

    outbox.ack('e1');

    expect(outbox.pending().map((item) => item.id)).toEqual(['s2']);
  });

  it('keeps an item the mothership failed to store, to send again', async () => {
    // A mothership whose store throws: every item is answered ok: false.
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    const port =
      typeof address === 'object' && address !== null ? address.port : 0;
    const answered: { ids: string[] } = { ids: [] };
    server.on('connection', (socket) => {
      socket.send(JSON.stringify({ type: 'challenge', challenge: 'AA==' }));
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString());

        if (message.type === 'auth') {
          socket.send(JSON.stringify({ type: 'owner', name: 'Leslie Knope' }));

          return;
        }

        answered.ids = [...answered.ids, message.id];
        socket.send(
          JSON.stringify({
            type: 'result',
            id: message.id,
            ok: false,
            error: 'database is locked',
          })
        );
      });
    });
    const logged: { lines: string[] } = { lines: [] };
    const outbox = createOutbox(path.join(home(), 'outbox.jsonl'));
    const started = createRunnerClient({
      url: `http://127.0.0.1:${port}`,
      runnerId: 'rnr_1',
      privateKey: generateRunnerKeys().privateKey,
      outbox,
      handle: async () => null,
      log: (line) => {
        logged.lines = [...logged.lines, line];
      },
    });
    fixture.client = started;
    started.enqueue(event('e1', 'bundle'));

    try {
      started.start();
      await eventually(() => answered.ids.includes('e1'));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(outbox.pending().map((item) => item.id)).toEqual(['e1']);
      expect(logged.lines).toContain(
        "Lambda didn't store e1: database is locked. It's sent again on the next connect."
      );
    } finally {
      started.stop();
      fixture.client = null;
      server.clients.forEach((socket) => socket.terminate());
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("doesn't rewrite the whole file for each newer state, and keeps it across a restart", () => {
    const file = path.join(home(), 'outbox.jsonl');
    const outbox = createOutbox(file);
    const sameFolder = (other: { type: string; folder?: unknown }) =>
      other.type === 'pod-state' && other.folder === FOLDER;
    outbox.add({ type: 'event', id: 'e1', folder: FOLDER });
    const inode = fs.statSync(file).ino;

    Array.from({ length: 20 }, (_, index) =>
      outbox.add(
        { type: 'pod-state', id: `s${index}`, folder: FOLDER },
        sameFolder
      )
    );
    outbox.ack('e1');

    expect(fs.statSync(file).ino).toBe(inode);

    // Many more: it compacts now and then, and never loses the newest.
    Array.from({ length: 100 }, (_, index) =>
      outbox.add(
        { type: 'pod-state', id: `t${index}`, folder: FOLDER },
        sameFolder
      )
    );
    expect(
      createOutbox(file)
        .pending()
        .map((item) => item.id)
    ).toEqual(['t99']);
    outbox.add({ type: 'pod-state', id: 's19', folder: FOLDER }, sameFolder);
    expect(outbox.pending().map((item) => item.id)).toEqual(['s19']);
    expect(
      createOutbox(file)
        .pending()
        .map((item) => item.id)
    ).toEqual(['s19']);
  });

  it('says so when a line is damaged, and starts the next one on its own line', () => {
    const file = path.join(home(), 'outbox.jsonl');
    // A crash mid-append: half a line, no newline.
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        type: 'event',
        id: 'e1',
        folder: FOLDER,
      })}\n{"type":"ev`
    );
    const logged: { lines: string[] } = { lines: [] };
    const outbox = createOutbox(file, (line) => {
      logged.lines = [...logged.lines, line];
    });

    outbox.add({ type: 'event', id: 'e2', folder: FOLDER });

    expect(outbox.pending().map((item) => item.id)).toEqual(['e1', 'e2']);
    expect(
      createOutbox(file, () => undefined)
        .pending()
        .map((item) => item.id)
    ).toEqual(['e1', 'e2']);
    expect(logged.lines).toEqual([
      `Skipping a damaged line in ${file}: {"type":"ev`,
    ]);
  });

  it("fails loudly when the file can't be read, rather than starting empty", () => {
    const file = path.join(home(), 'outbox.jsonl');
    fs.mkdirSync(file);

    expect(() => createOutbox(file).pending()).toThrow(/EISDIR/);
  });
});
