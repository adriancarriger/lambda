import * as fs from 'fs';

import { required } from '../../__tests__/required';
import { BRIDGE_SCRIPT } from '../../app/server/prototypes';
import { generateRunnerKeys } from '../../runner/keys';
import { GATED_PREFIXES, PUBLIC_ROUTES } from '../gate';
import { storeSnapshots } from '../pods';
import { protoToken, sessionSecret } from '../protoToken';
import {
  type FakeRunner,
  type Harness,
  connectRunner,
  eventually,
  holdProject,
  podSnapshot,
  startHarness,
} from './harness';

/** One tiny valid PNG (1×1). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const FOLDER = '/home/leslie/pawnee-parks';

/** Every path today's server answers inline, outside its POST table. */
const INLINE_PATHS: [string, string][] = [
  ['GET', '/api/events'],
  ['GET', '/api/state'],
  ['GET', '/api/audio/p1/0123456789abcdef01234567.mp3'],
  ['GET', '/api/tts/stream?podId=p1&msgId=m1'],
  ['GET', '/api/versions?podId=p1&qid=q1'],
  ['GET', '/api/pod/p1'],
  ['GET', '/api/term?podId=p1&window=dev'],
  ['POST', '/api/ui-log'],
  ['POST', '/api/upload-url'],
  ['POST', '/api/upload'],
  ['GET', '/api/uploads/img_a_b.png'],
  ['GET', '/api/pod-file/p1/designs/a.png'],
  ['GET', '/api/pod-file/p1/shots/a.png'],
  ['GET', '/api/made/p1'],
  // A prototype file with no session and no good token.
  ['GET', '/proto/-/p1/desk/v1/Desk.dc.html'],
  ['GET', '/proto/p1/desk/v1/Desk.dc.html'],
  ['POST', '/api/render-mode'],
  ['POST', '/api/term/keys'],
  ['GET', '/api/not-a-route'],
  ['POST', '/api/not-a-route'],
];

const seedPod = (harness: Harness, runnerId: string, podId: string): void => {
  holdProject(harness, runnerId, { folder: FOLDER });
  const snapshot = podSnapshot(podId);
  storeSnapshots(
    harness.db,
    runnerId,
    FOLDER,
    [snapshot],
    [],
    harness.clock.now
  );
};

describe('the session gate', () => {
  const fixture: { harness?: Harness; runner?: FakeRunner } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');
  const runner = (): FakeRunner => required(fixture.runner, 'runner');

  beforeEach(async () => {
    fixture.harness = await startHarness();
    fixture.runner = await connectRunner(harness());
    await runner().next('owner');
    seedPod(harness(), runner().runnerId, 'p1');
  });

  afterEach(async () => {
    await runner().close();
    await harness().close();
  });

  it('lists exactly four public routes, and gates /api/ and /proto/', () => {
    expect(PUBLIC_ROUTES).toEqual([
      { method: 'GET', path: '/auth/link' },
      { method: 'POST', path: '/api/auth/pair' },
      { method: 'POST', path: '/api/runners/join' },
      { method: 'GET', path: '/api/runner/socket' },
    ]);
    expect(GATED_PREFIXES).toEqual(['/api/', '/proto/']);
  });

  it('refuses every route, the SSE stream and every inline path without a cookie', async () => {
    const request = jest.spyOn(harness().mothership.relay, 'request');
    const push = jest.spyOn(harness().mothership.relay, 'push');
    const before = runner().received.length;
    const all: [string, string][] = [
      ...harness().mothership.routes.map((route): [string, string] => [
        route.method,
        route.sample,
      ]),
      ...INLINE_PATHS,
    ];

    const responses = await Promise.all(
      all.map(async ([method, urlPath]) => ({
        method,
        urlPath,
        response: await harness().request(method, urlPath),
      }))
    );

    responses.forEach(({ method, urlPath, response }) => {
      expect({ method, urlPath, status: response.status }).toEqual({
        method,
        urlPath,
        status: 401,
      });
    });
    // A GET /api/term with no cookie never reads the pane.
    expect(
      responses.find(({ urlPath }) => urlPath.startsWith('/api/term?'))
        ?.response.text
    ).not.toContain('screen');
    expect(request).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(runner().received.length).toBe(before);
  });

  it('refuses a session that isn’t one', async () => {
    const response = await harness().request('GET', '/api/state', {
      cookie: 'lambda_session=not-a-real-token',
    });

    expect(response.status).toBe(401);
  });
});

describe('prototype links', () => {
  const fixture: { harness?: Harness; runner?: FakeRunner } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');
  const runner = (): FakeRunner => required(fixture.runner, 'runner');
  const sent: { asked: string[] } = { asked: [] };

  beforeEach(async () => {
    sent.asked = [];
    fixture.harness = await startHarness();
    fixture.runner = await connectRunner(harness());
    await runner().next('owner');
    seedPod(harness(), runner().runnerId, 'p1');
    seedPod(harness(), runner().runnerId, 'p2');
    runner().on('pod-action', (message) => {
      const action = String(message.action);
      sent.asked = [...sent.asked, action];

      if (action === 'made') {
        return {
          prototypes: [
            {
              slug: 'desk',
              versions: [{ slug: 'desk', version: 1, boards: [] }],
            },
          ],
          pictures: [],
        };
      }

      return null;
    });
    runner().on('pod-file', (message) => {
      sent.asked = [...sent.asked, `pod-file:${String(message.folder)}`];

      if (String(message.path).includes('Gone')) {
        throw new Error('No such file.');
      }

      return {
        base64: Buffer.from('<html>desk</html>').toString('base64'),
        headers: { 'content-type': 'text/html; charset=utf-8' },
      };
    });
  });

  afterEach(async () => {
    await runner().close();
    await harness().close();
  });

  const token = (pod: string, version: string, at = harness().clock.now) =>
    protoToken(sessionSecret(harness().db), pod, 'desk', version, at);

  it('serves a file to a good token with no cookie', async () => {
    const response = await harness().request(
      'GET',
      `/proto/${token('p1', 'v1')}/p1/desk/v1/Desk.dc.html`
    );

    expect(response.status).toBe(200);
    expect(response.text).toContain('<html>desk</html>');
    expect(response.text).toContain(`<script>${BRIDGE_SCRIPT}</script>`);
    expect(sent.asked).toEqual(['pod-file:prototype']);
  });

  it('keeps the token out of the log when a file fails', async () => {
    const good = token('p1', 'v1');
    const response = await harness().request(
      'GET',
      `/proto/${good}/p1/desk/v1/Gone.dc.html`
    );
    const logged = harness().logs.join('\n');

    expect(response.status).not.toBe(200);
    expect(logged).toMatch(/\/proto\/…\/p1\/desk\/v1\/Gone\.dc\.html failed/);
    expect(logged).not.toContain(good);
  });

  it('refuses no token, another version’s, another pod’s and an expired one', async () => {
    const paths = [
      '/proto/p1/desk/v1/Desk.dc.html',
      `/proto/${token('p1', 'v2')}/p1/desk/v1/Desk.dc.html`,
      `/proto/${token('p2', 'v1')}/p1/desk/v1/Desk.dc.html`,
    ];
    const expired = token(
      'p1',
      'v1',
      harness().clock.now - 13 * 60 * 60 * 1000
    );

    const statuses = await Promise.all(
      [...paths, `/proto/${expired}/p1/desk/v1/Desk.dc.html`].map(
        async (urlPath) => (await harness().request('GET', urlPath)).status
      )
    );

    expect(statuses).toEqual([401, 401, 401, 401]);
    expect(sent.asked).toEqual([]);
  });

  it('answers /api/made with links whose tokens pass', async () => {
    const made = await harness().request('GET', '/api/made/p1', {
      cookie: harness().signIn(),
    });
    const { bases } = made.json<{ bases: Record<string, string> }>();

    expect(made.status).toBe(200);
    expect(Object.keys(bases)).toEqual(['desk/v1']);
    expect(bases['desk/v1']).toMatch(/^\/proto\/[^/]+\/p1\/desk\/v1\/$/);

    const file = await harness().request(
      'GET',
      `${bases['desk/v1']}Desk.dc.html`
    );

    expect(file.status).toBe(200);
  });

  it('answers the same link a minute later, so an open frame never reloads', async () => {
    const bases = async (): Promise<Record<string, string>> =>
      (
        await harness().request('GET', '/api/made/p1', {
          cookie: harness().signIn(),
        })
      ).json<{ bases: Record<string, string> }>().bases;

    const first = await bases();
    harness().clock.now += 60 * 1000;
    const second = await bases();

    expect(second).toEqual(first);
  });

  it('keeps a link working at least 12 hours from when it was given', async () => {
    harness().clock.now = Date.UTC(2026, 9, 21, 12, 59, 59);
    const base = required(
      (
        await harness().request('GET', '/api/made/p1', {
          cookie: harness().signIn(),
        })
      ).json<{ bases: Record<string, string> }>().bases['desk/v1'],
      'base'
    );
    harness().clock.now += 12 * 60 * 60 * 1000;

    const file = await harness().request('GET', `${base}Desk.dc.html`);

    expect(file.status).toBe(200);
  });
});

describe('cross-site requests', () => {
  const fixture: { harness?: Harness; runner?: FakeRunner; cookie?: string } =
    {};
  const harness = (): Harness => required(fixture.harness, 'harness');
  const runner = (): FakeRunner => required(fixture.runner, 'runner');
  const cookie = (): string => required(fixture.cookie, 'cookie');
  const sent: { keys: unknown[] } = { keys: [] };

  beforeEach(async () => {
    sent.keys = [];
    fixture.harness = await startHarness({
      config: {
        owner: { name: 'Leslie Knope' },
        mothership: { host: 'leslies-macbook' },
      },
    });
    fixture.runner = await connectRunner(harness());
    await runner().next('owner');
    seedPod(harness(), runner().runnerId, 'x');
    runner().on('term-keys', (message) => {
      sent.keys = [...sent.keys, message.hex];

      return 'ok';
    });
    fixture.cookie = harness().signIn();
  });

  afterEach(async () => {
    await runner().close();
    await harness().close();
  });

  const keysBody = JSON.stringify({
    podId: 'x',
    window: 'dev',
    hex: ['6c', '73'],
  });

  it('refuses a text/plain POST to the terminal (415) and sends no keys', async () => {
    const response = await harness().request('POST', '/api/term/keys', {
      cookie: cookie(),
      contentType: 'text/plain',
      body: keysBody,
    });

    expect(response.status).toBe(415);
    expect(sent.keys).toEqual([]);
  });

  it('refuses a foreign Origin (403) and sends no keys', async () => {
    const response = await harness().request('POST', '/api/term/keys', {
      cookie: cookie(),
      origin: 'http://evil.example',
      body: keysBody,
    });

    expect(response.status).toBe(403);
    expect(response.json().error).toBe('Request refused.');
    expect(sent.keys).toEqual([]);
  });

  it('refuses a POST with no Origin to the terminal', async () => {
    const response = await harness().request('POST', '/api/term/keys', {
      cookie: cookie(),
      origin: null,
      body: keysBody,
    });

    expect(response.status).toBe(403);
    expect(sent.keys).toEqual([]);
  });

  it('sends keys for a same-origin JSON POST', async () => {
    const response = await harness().request('POST', '/api/term/keys', {
      cookie: cookie(),
      body: keysBody,
    });

    expect(response.status).toBe(200);
    await eventually(() => sent.keys.length === 1);
    expect(sent.keys).toEqual([['6c', '73']]);
  });

  it('refuses a Host that isn’t the mothership’s, even with its own Origin', async () => {
    const response = await harness().request('POST', '/api/term/keys', {
      cookie: cookie(),
      host: 'evil.example',
      origin: 'http://evil.example',
      body: keysBody,
    });

    expect(response.status).toBe(403);
    expect(response.json().error).toBe('Request refused.');
  });

  it('accepts mothership.host with the port, not without it', async () => {
    const withPort = await harness().request('POST', '/api/term/keys', {
      cookie: cookie(),
      host: `leslies-macbook:${harness().port}`,
      body: keysBody,
    });
    const withoutPort = await harness().request('POST', '/api/term/keys', {
      cookie: cookie(),
      host: 'leslies-macbook',
      body: keysBody,
    });

    expect(withPort.status).toBe(200);
    expect(withoutPort.status).toBe(403);
  });

  it('stores an uploaded image, and one named by x-file-name; refuses text', async () => {
    const png = await harness().request('POST', '/api/upload', {
      cookie: cookie(),
      contentType: 'image/png',
      body: PNG,
    });
    const heic = await harness().request('POST', '/api/upload', {
      cookie: cookie(),
      contentType: 'application/octet-stream',
      headers: { 'x-file-name': 'photo.heic' },
      body: PNG,
    });
    const text = await harness().request('POST', '/api/upload', {
      cookie: cookie(),
      contentType: 'text/plain',
      body: 'hello',
    });

    expect(png.status).toBe(200);
    expect(fs.existsSync(String(png.json().result))).toBe(true);
    expect(heic.status).toBe(200);
    expect(String(heic.json().result)).toMatch(/\.jpg$/);
    expect(text.status).toBe(415);
  });

  it('lets lambda join post with no Origin, but not a foreign one', async () => {
    const { createCode } = await import('../pairing');
    const good = createCode(harness().db, 'runner', harness().clock.now).code;
    const other = createCode(harness().db, 'runner', harness().clock.now).code;
    const { publicKey } = generateRunnerKeys();
    const body = (code: string) =>
      JSON.stringify({ code, name: "Leslie's laptop", publicKey });

    const joined = await harness().request('POST', '/api/runners/join', {
      origin: null,
      body: body(good),
    });
    const foreign = await harness().request('POST', '/api/runners/join', {
      origin: 'http://evil.example',
      body: body(other),
    });

    expect(joined.status).toBe(200);
    expect(
      joined.json<{ result: { runnerId: string } }>().result.runnerId
    ).toMatch(/^rnr_/);
    expect(foreign.status).toBe(403);
  });
});
