import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { WebSocket } from 'ws';

import { required } from '../../__tests__/required';
import { generateRunnerKeys } from '../../runner/keys';
import { createCode } from '../pairing';
import { listRunners } from '../registry';
import {
  type Harness,
  connectRunner,
  eventually,
  holdProject,
  podSnapshot,
  startHarness,
  tempHome,
} from './harness';

/** One raw HTTP request over a socket: what a browser or a peer could send. */
const rawRequest = (port: number, text: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    const got: { text: string } = { text: '' };
    socket.on('data', (chunk) => {
      got.text += chunk.toString('utf8');
    });
    socket.on('end', () => resolve(got.text));
    socket.on('close', () => resolve(got.text));
    socket.on('error', reject);
  });

/**
 * Just enough WebSocket to announce one `total`-byte frame on the runner
 * endpoint and stream it without signing in. Answers how much of it the
 * mothership took before it hung up (all of it when it never does).
 */
const floodBeforeSignIn = (port: number, total: number): Promise<number> =>
  new Promise((resolve, reject) => {
    const MB = 1024 * 1024;
    const chunk = Buffer.alloc(MB);
    const state = { written: 0, upgraded: false, closed: false, reply: '' };
    const socket = net.connect(port, '127.0.0.1', () =>
      socket.write(
        [
          'GET /api/runner/socket HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${Buffer.alloc(16, 7).toString('base64')}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n')
      )
    );
    const pump = (): void => {
      while (!state.closed && state.written < total) {
        state.written += chunk.length;

        if (!socket.write(chunk)) {
          socket.once('drain', pump);

          return;
        }
      }
    };
    const hungUp = (): void => {
      if (!state.closed) {
        state.closed = true;
        socket.destroy();
        resolve(state.written);
      }
    };
    socket.on('data', (data) => {
      // After the upgrade the mothership only ever sends its close frame.
      if (state.upgraded) {
        hungUp();

        return;
      }

      state.reply += data.toString('latin1');

      if (!state.reply.includes('\r\n\r\n')) {
        return;
      }

      state.upgraded = true;
      // FIN + text, masked, 64-bit length, then a zero mask key.
      const header = Buffer.alloc(14);
      header[0] = 0x81;
      header[1] = 0xff;
      header.writeBigUInt64BE(BigInt(total), 2);
      socket.write(header);
      pump();
    });
    socket.on('error', () => undefined);
    socket.on('close', hungUp);
    setTimeout(() => {
      socket.destroy();
      reject(new Error('the mothership never hung up'));
    }, 8_000).unref();
  });

/** A socket to the runner endpoint that never signs in. Resolves its close code. */
const strangerSocket = (
  port: number
): { socket: WebSocket; closed: Promise<number> } => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/runner/socket`);
  const closed = new Promise<number>((resolve) => {
    socket.on('close', (code) => resolve(code));
    socket.on('error', () => undefined);
  });

  return { socket, closed };
};

const count = (harness: Harness, table: string): number => {
  const row = harness.db
    .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
    .get();

  return required(row, `count of ${table}`).n;
};

describe('lambda join checks its body before using the code', () => {
  const fixture: { harness?: Harness } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');

  beforeEach(async () => {
    fixture.harness = await startHarness();
  });

  afterEach(() => harness().close());

  const join = (body: Record<string, unknown>) =>
    harness().request('POST', '/api/runners/join', {
      origin: null,
      body: JSON.stringify(body),
    });

  it('keeps a good code when the name is missing', async () => {
    const { code } = createCode(harness().db, 'runner', harness().clock.now);
    const { publicKey } = generateRunnerKeys();

    const missing = await join({ code, publicKey });
    const joined = await join({ code, name: "Leslie's Mac mini", publicKey });

    expect(missing.status).toBe(400);
    expect(joined.status).toBe(200);
    expect(listRunners(harness().db)).toHaveLength(1);
  });

  it('refuses a name over 100 characters and keeps the code', async () => {
    const { code } = createCode(harness().db, 'runner', harness().clock.now);
    const { publicKey } = generateRunnerKeys();

    const long = await join({ code, name: 'L'.repeat(101), publicKey });
    const joined = await join({ code, name: "Leslie's Mac mini", publicKey });

    expect(long.status).toBe(400);
    expect(joined.status).toBe(200);
  });

  it("refuses a key that isn't an Ed25519 public key, storing no runner", async () => {
    const { code } = createCode(harness().db, 'runner', harness().clock.now);
    const rsa = (await import('crypto'))
      .generateKeyPairSync('rsa', { modulusLength: 1024 })
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();

    const junk = await join({
      code,
      name: "Leslie's Mac mini",
      publicKey: 'KEY',
    });
    const wrongKind = await join({
      code,
      name: "Leslie's Mac mini",
      publicKey: rsa,
    });

    expect(junk.status).toBe(400);
    expect(junk.json().error).toBe("That isn't a runner key.");
    expect(wrongKind.status).toBe(400);
    expect(listRunners(harness().db)).toEqual([]);

    const joined = await join({
      code,
      name: "Leslie's Mac mini",
      publicKey: generateRunnerKeys().publicKey,
    });

    expect(joined.status).toBe(200);
  });
});

describe('runner sockets that never sign in', () => {
  const fixture: { harness?: Harness } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');

  afterEach(() => harness().close());

  it('are closed once the sign-in time is up', async () => {
    fixture.harness = await startHarness({ authTimeoutMs: 100 });
    const { closed } = strangerSocket(harness().port);

    const code = await Promise.race([
      closed,
      new Promise<string>((resolve) => setTimeout(() => resolve('open'), 1500)),
    ]);

    expect(code).toBe(4408);
  });

  it('may not send a frame over 1 MiB', async () => {
    fixture.harness = await startHarness();
    const { socket, closed } = strangerSocket(harness().port);
    await new Promise((resolve) => socket.once('open', resolve));

    socket.send('x'.repeat(2 * 1024 * 1024));

    expect(await closed).toBe(1009);
  });

  it('are hung up on at 1 MiB, not after reading a bigger frame whole', async () => {
    fixture.harness = await startHarness();
    const total = 32 * 1024 * 1024;

    const taken = await floodBeforeSignIn(harness().port, total);

    expect(taken).toBeLessThan(total / 2);
  });

  it('may send a pod-state over 1 MiB once signed in', async () => {
    fixture.harness = await startHarness();
    const runner = await connectRunner(harness());
    await runner.next('owner');
    holdProject(harness(), runner.runnerId);
    const big = {
      ...podSnapshot('dog-park'),
      questions: [{ id: 'q1', note: 'x'.repeat(2 * 1024 * 1024) }],
    };

    runner.send({
      type: 'pod-state',
      id: 'state-big',
      folder: '/home/leslie/pawnee-parks',
      pods: [big],
      removed: [],
    });
    const result = await Promise.race([
      runner.next('result').then((message) => message.ok),
      new Promise<string>((resolve) =>
        runner.socket.once('close', (code) => resolve(`closed ${code}`))
      ),
    ]);

    expect(result).toBe(true);
    expect(runner.socket.readyState).toBe(WebSocket.OPEN);
    await runner.close();
  });

  it('still let a real runner sign in', async () => {
    fixture.harness = await startHarness({ authTimeoutMs: 100 });
    const runner = await connectRunner(harness());
    await runner.next('owner');
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(runner.socket.readyState).toBe(WebSocket.OPEN);
    await runner.close();
  });
});

describe('internal errors', () => {
  const fixture: { harness?: Harness } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');

  beforeEach(async () => {
    fixture.harness = await startHarness();
  });

  afterEach(() => harness().close());

  it('answer 500 in plain words, with the detail only in the log', async () => {
    const cookie = harness().signIn();
    harness().db.exec('DROP TABLE sessions');

    const response = await harness().request('GET', '/api/state', { cookie });

    expect(response.status).toBe(500);
    expect(response.json().error).toBe('Something went wrong.');
    expect(response.text).not.toMatch(/sessions/);
    expect(harness().logs.join('\n')).toMatch(/no such table: sessions/);
  });

  it('keep a refusal’s own status and words', async () => {
    const response = await harness().request('POST', '/api/auth/pair', {
      body: 'not json',
    });

    expect(response.status).toBe(400);
    expect(response.json().error).toBe("That body isn't JSON.");
  });

  it('answer 400, not 500, to a path part that isn’t percent-encoding', async () => {
    const response = await harness().request('GET', '/api/pod/%E0', {
      cookie: harness().signIn(),
    });

    expect(response.status).toBe(400);
    expect(response.json().error).toBe("That address isn't readable.");
  });
});

describe('a request-target that is not a URL', () => {
  const fixture: { harness?: Harness } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');

  beforeEach(async () => {
    fixture.harness = await startHarness();
  });

  afterEach(() => harness().close());

  it('gets 400, and the mothership keeps answering', async () => {
    const host = `127.0.0.1:${harness().port}`;
    const reply = await rawRequest(
      harness().port,
      `GET // HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`
    );
    const after = await harness().request('GET', '/api/state');

    expect(reply).toMatch(/^HTTP\/1\.1 400/);
    expect(after.status).toBe(401);
  });

  it('on the socket upgrade gets 400 too', async () => {
    const host = `127.0.0.1:${harness().port}`;
    const reply = await rawRequest(
      harness().port,
      `GET // HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`
    );
    const after = await harness().request('GET', '/api/state');

    expect(reply).toMatch(/^HTTP\/1\.1 400/);
    expect(after.status).toBe(401);
  });
});

describe('what a runner sends is checked', () => {
  const fixture: { harness?: Harness } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');

  beforeEach(async () => {
    fixture.harness = await startHarness();
  });

  afterEach(() => harness().close());

  const event = {
    type: 'metric',
    name: 'bundle',
    value: 412,
    unit: 'KB',
    at: '2026-10-21T12:00:00.000Z',
  };

  it('stores no event without an id, and says so in the log', async () => {
    const runner = await connectRunner(harness());
    await runner.next('owner');
    holdProject(harness(), runner.runnerId, { folder: '/x' });

    runner.send({ type: 'event', folder: '/x', event });
    runner.socket.send(
      JSON.stringify({ type: 'event', folder: '/x', event, id: 42 })
    );
    runner.send({ type: 'event', folder: '/x', event, id: 'rnr:abc:0' });
    await eventually(() => count(harness(), 'events') === 1);
    await eventually(
      () =>
        harness().logs.filter((line) => /event with no id/.test(line))
          .length === 2
    );

    expect(
      harness()
        .db.prepare<[], { id: string }>('SELECT id FROM events')
        .all()
        .map((row) => row.id)
    ).toEqual(['rnr:abc:0']);
    await runner.close();
  });

  it("stores a rewritten file's event under the same id in its own generation, once", async () => {
    const runner = await connectRunner(harness());
    await runner.next('owner');
    holdProject(harness(), runner.runnerId, { folder: '/x' });
    const id = 'rnr:abc:0';

    runner.send({ type: 'event', folder: '/x', event, id });
    runner.send({
      type: 'event',
      folder: '/x',
      event,
      id: `${id}#1`,
      eventId: id,
      generation: 1,
    });
    runner.send({
      type: 'event',
      folder: '/x',
      event,
      id: `${id}#1`,
      eventId: id,
      generation: 1,
    });
    runner.send({
      type: 'event',
      folder: '/x',
      event,
      id: 'x#2',
      generation: 2,
    });
    await eventually(() =>
      harness().logs.some((line) => /generation 2 with no eventId/.test(line))
    );
    await eventually(() => count(harness(), 'events') === 2);

    expect(
      harness()
        .db.prepare<[], { id: string; generation: number }>(
          'SELECT id, generation FROM events ORDER BY generation'
        )
        .all()
    ).toEqual([
      { id, generation: 0 },
      { id, generation: 1 },
    ]);
    await runner.close();
  });

  it('refuses an event from a folder with no project, so it stays in the outbox', async () => {
    const runner = await connectRunner(harness());
    await runner.next('owner');

    runner.send({ type: 'event', folder: '/x', event, id: 'rnr:abc:0' });
    const result = await runner.next('result');

    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/\/x/);
    expect(count(harness(), 'events')).toBe(0);
    await runner.close();
  });

  it('refuses a pod-state whose pods are not pods, and /api/state still answers', async () => {
    const runner = await connectRunner(harness());
    await runner.next('owner');

    runner.send({
      type: 'pod-state',
      id: 'state-1',
      folder: '/home/leslie/pawnee-parks',
      pods: [{ podId: 'dog-park', bogus: true }],
      removed: [],
    });
    const result = await runner.next('result');

    expect(result.ok).toBe(false);
    expect(count(harness(), 'pods')).toBe(0);
    expect(harness().logs.join('\n')).toMatch(/pod-state/);

    runner.send({
      type: 'pod-state',
      id: 'state-2',
      folder: '/home/leslie/pawnee-parks',
      pods: [podSnapshot('dog-park')],
      removed: [],
    });
    await eventually(() => count(harness(), 'pods') === 1);

    const state = await harness().request('GET', '/api/state', {
      cookie: harness().signIn(),
    });

    expect(state.status).toBe(200);
    await runner.close();
  });
});

describe('the built client’s pages', () => {
  const fixture: { harness?: Harness; clientDir?: string } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');

  beforeEach(async () => {
    const clientDir = path.join(tempHome(), 'app');
    fs.mkdirSync(clientDir, { recursive: true });
    fs.writeFileSync(path.join(clientDir, 'index.html'), '<!doctype html>');
    fs.writeFileSync(path.join(clientDir, 'main.js'), '');
    fixture.clientDir = clientDir;
    fixture.harness = await startHarness({ clientDir });
  });

  afterEach(async () => {
    await harness().close();
    fs.rmSync(path.dirname(required(fixture.clientDir, 'clientDir')), {
      recursive: true,
      force: true,
    });
  });

  it('may only be framed by Lambda itself, and are never sniffed', async () => {
    const page = await harness().request('GET', '/');
    const script = await harness().request('GET', '/main.js');

    [page, script].forEach((response) => {
      expect(response.status).toBe(200);
      expect(response.headers['content-security-policy']).toBe(
        "frame-ancestors 'self'"
      );
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    });
  });
});

describe('the config the gate reads', () => {
  it('is read at most once a second, not on every request', async () => {
    const calls = { n: 0 };
    const harness = await startHarness({
      config: () => {
        calls.n += 1;

        return { owner: { name: 'Leslie Knope' } };
      },
    });

    calls.n = 0;
    await harness.request('GET', '/api/state');
    await harness.request('GET', '/api/state');
    await harness.request('GET', '/api/state');

    expect(calls.n).toBe(1);

    harness.clock.now += 1001;
    await harness.request('GET', '/api/state');

    expect(calls.n).toBe(2);
    await harness.close();
  });
});

describe('the tables that only ever grow', () => {
  const fixture: { harness?: Harness } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(async () => {
    fixture.harness = await startHarness();
  });

  afterEach(() => harness().close());

  it('lose old receipts and spent codes and links on each tick, and keep live ones', async () => {
    const { db } = harness();
    const at = harness().clock.now;
    db.prepare('INSERT INTO received (id, at) VALUES (?, ?)').run(
      'ps_old',
      at - 8 * DAY
    );
    db.prepare('INSERT INTO received (id, at) VALUES (?, ?)').run(
      'ps_new',
      at - DAY
    );
    const code = db.prepare(
      'INSERT INTO pairing_codes (code_hash, kind, expires_at, used_at) VALUES (?, ?, ?, ?)'
    );
    code.run('expired', 'device', at - 1, null);
    code.run('used', 'runner', at + 60_000, at - 1);
    code.run('live', 'device', at + 60_000, null);
    const link = db.prepare(
      'INSERT INTO login_links (token_hash, expires_at, used_at) VALUES (?, ?, ?)'
    );
    link.run('expired', at - 1, null);
    link.run('used', at + 60_000, at - 1);
    link.run('live', at + 60_000, null);

    await harness().mothership.tick();

    const ids = (sql: string): string[] =>
      db
        .prepare<[], { id: string }>(sql)
        .all()
        .map((row) => row.id);
    expect(ids('SELECT id FROM received')).toEqual(['ps_new']);
    expect(ids('SELECT code_hash AS id FROM pairing_codes')).toEqual(['live']);
    expect(ids('SELECT token_hash AS id FROM login_links')).toEqual(['live']);
  });
});
