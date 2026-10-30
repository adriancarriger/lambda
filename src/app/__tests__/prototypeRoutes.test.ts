import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { required } from '../../__tests__/required';
import {
  type FakeRunner,
  type Harness,
  connectRunner,
  holdProject,
  podSnapshot,
  startHarness,
} from '../../mothership/__tests__/harness';
import { storeSnapshots } from '../../mothership/pods';
import {
  PROTO_TOKEN_LIFETIME_MS,
  protoToken,
  sessionSecret,
} from '../../mothership/protoToken';
import { podFileRequestOf, servePodFile } from '../../runner/podFiles';
import { BRIDGE_SCRIPT, madeHere } from '../server/prototypes';

/**
 * The prototype routes end to end (the unit half is prototypes.test.ts):
 * `/api/made/<pod>` and `/proto/<token>/<pod>/<slug>/v<n>/<file>` through
 * the mothership's sign-in, forwarded to the runner that has the pod, which
 * serves only a version's own `files/`.
 */

// Spy-able: the mothership's file reads are counted.
jest.mock('fs', () => ({ ...jest.requireActual('fs') }));

const POD = 'pawnee-map-a1b2';
const FOLDER = '/home/leslie/pawnee-parks';

const manifest = (version: number) => ({
  slug: 'map',
  version,
  title: 'Trail map',
  createdAt: `2026-10-20T1${version}:00:00Z`,
  hash: `h${version}`,
  situations: [{ slug: 'trail-closed', title: 'Trail closed' }],
  boards: [
    {
      file: 'Prototype.dc.html',
      letter: 'A',
      title: 'Map',
      w: 1440,
      h: 900,
      stills: {
        'trail-closed': `designs/map/prototype/v${version}/stills/A/trail-closed.png`,
      },
    },
  ],
});

/** The runner's pods root: two versions of the trail map's prototype. */
const seedPodsRoot = (): string => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-proto-routes-'))
  );
  const write = (rel: string, body: string): void => {
    const file = path.join(root, POD, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  [1, 2].forEach((version) => {
    const dir = `designs/map/prototype/v${version}`;
    write(
      `${dir}/files/Prototype.dc.html`,
      '<html><body><x-dc>Ann Perkins · Trail map</x-dc></body></html>'
    );
    write(`${dir}/files/support.js`, '// runtime');
    write(`${dir}/stills/A/trail-closed.png`, 'png');
    write(`${dir}/prototype.json`, JSON.stringify(manifest(version)));
  });
  write('designs/map/prototype/v1/files/notes.xyz', 'not served');
  write('thread.jsonl', '{}');
  fs.writeFileSync(path.join(root, 'outside.js'), '// outside');
  fs.symlinkSync(
    path.join(root, 'outside.js'),
    path.join(root, POD, 'designs/map/prototype/v1/files/escape.js')
  );

  return root;
};

describe('the prototype routes', () => {
  const fixture: { harness?: Harness; runner?: FakeRunner; root?: string } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');
  const runner = (): FakeRunner => required(fixture.runner, 'runner');
  const root = (): string => required(fixture.root, 'root');
  const asked: { files: string[] } = { files: [] };

  beforeEach(async () => {
    asked.files = [];
    fixture.root = seedPodsRoot();
    fixture.harness = await startHarness();
    fixture.runner = await connectRunner(harness());
    await runner().next('owner');
    holdProject(harness(), runner().runnerId, { folder: FOLDER });
    storeSnapshots(
      harness().db,
      runner().runnerId,
      FOLDER,
      [podSnapshot(POD)],
      [],
      harness().clock.now
    );
    // The runner's real answers, from its own pods root.
    runner().on('pod-action', (message) =>
      message.action === 'made' ? madeHere(root(), POD) : null
    );
    runner().on('pod-file', (message) => {
      asked.files = [
        ...asked.files,
        `${String(message.folder)}:${String(message.path)}`,
      ];

      return servePodFile(root(), podFileRequestOf(message));
    });
  });

  afterEach(async () => {
    await runner().close();
    await harness().close();
    fs.rmSync(root(), { recursive: true, force: true });
  });

  const token = (version: string) =>
    protoToken(
      sessionSecret(harness().db),
      POD,
      'map',
      version,
      harness().clock.now
    );
  const proto = (version: string, file: string, tokenFor = version) =>
    `/proto/${token(tokenFor)}/${POD}/map/${version}/${file}`;

  it('serves Prototype.dc.html with the bridge and the CSP', async () => {
    const response = await harness().request(
      'GET',
      proto('v1', 'Prototype.dc.html')
    );
    const csp = String(response.headers['content-security-policy']);

    expect(response.status).toBe(200);
    expect(response.text).toContain('Ann Perkins · Trail map');
    expect(response.text).toContain(`<script>${BRIDGE_SCRIPT}</script>`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`/proto/${token('v1')}/${POD}/map/v1/`);
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).toContain('frame-ancestors');
    expect(asked.files).toEqual(['prototype:map/v1/Prototype.dc.html']);
  });

  it('serves the runtime support.js beside the board', async () => {
    const response = await harness().request('GET', proto('v1', 'support.js'));

    expect(response.status).toBe(200);
    expect(response.text).toBe('// runtime');
  });

  it.each([
    ['v0', 'Prototype.dc.html'],
    ['v1', '..%2F..%2F..%2Fthread.jsonl'],
    ['v1', 'notes.xyz'],
    ['v1', 'escape.js'],
  ])('answers 404 for %s/%s', async (version, file) => {
    const response = await harness().request('GET', proto(version, file));

    expect(response.status).toBe(404);
  });

  it('never serves a path that climbs out of the version folder', async () => {
    // The URL is normalised first: what's left has no version, so no link.
    const response = await harness().request(
      'GET',
      proto('v1', '%2e%2e/prototype.json')
    );

    expect(response.status).toBe(401);
    expect(asked.files).toEqual([]);
  });

  // Signed in, "Sign in first." would mislead: the path is what's wrong.
  it('answers 404 to a signed-in session for a path that is not a prototype file', async () => {
    const cookie = harness().signIn();
    const statuses = await Promise.all(
      [
        `/proto/${POD}/map/prototype.json`,
        proto('v1', '%2e%2e/prototype.json'),
      ].map(
        async (urlPath) =>
          (
            await harness().request('GET', urlPath, { cookie })
          ).status
      )
    );

    expect(statuses).toEqual([404, 404]);
    expect(asked.files).toEqual([]);
  });

  it('answers 401 with no session and no token, and with a token for another version', async () => {
    const statuses = await Promise.all(
      [
        `/proto/${POD}/map/v1/Prototype.dc.html`,
        `/proto/-/${POD}/map/v1/Prototype.dc.html`,
        proto('v2', 'Prototype.dc.html', 'v1'),
        `/api/made/${POD}`,
      ].map(async (urlPath) => (await harness().request('GET', urlPath)).status)
    );

    expect(statuses).toEqual([401, 401, 401, 401]);
    expect(asked.files).toEqual([]);
  });

  it('answers only GET and HEAD, even with a good token', async () => {
    const statuses = await Promise.all(
      ['PUT', 'DELETE', 'POST', 'HEAD'].map(
        async (method) =>
          (
            await harness().request(method, proto('v1', 'support.js'))
          ).status
      )
    );

    expect(statuses).toEqual([405, 405, 405, 200]);
  });

  it('opens any version for a signed-in session, with or without a token', async () => {
    const cookie = harness().signIn();
    const responses = await Promise.all(
      [
        `/proto/${POD}/map/v1/Prototype.dc.html`,
        `/proto/${POD}/map/v2/Prototype.dc.html`,
        proto('v2', 'Prototype.dc.html', 'v1'),
      ].map((urlPath) => harness().request('GET', urlPath, { cookie }))
    );

    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200,
    ]);
    // A tokenless page may fetch only its own version's folder.
    expect(String(responses[0]?.headers['content-security-policy'])).toContain(
      `/proto/${POD}/map/v1/`
    );
  });

  it('opens with a token only the version it was made for', async () => {
    const statuses = await Promise.all(
      [
        proto('v1', 'Prototype.dc.html'),
        proto('v2', 'Prototype.dc.html'),
        proto('v2', 'Prototype.dc.html', 'v1'),
        proto('v1', 'Prototype.dc.html', 'v2'),
      ].map(async (urlPath) => (await harness().request('GET', urlPath)).status)
    );

    expect(statuses).toEqual([200, 200, 401, 401]);
  });

  it('answers 401 to a wrong or expired token with no session', async () => {
    const good = token('v1');
    const expired = protoToken(
      sessionSecret(harness().db),
      POD,
      'map',
      'v1',
      harness().clock.now - 2 * PROTO_TOKEN_LIFETIME_MS
    );
    const statuses = await Promise.all(
      [
        `/proto/zz.${good.split('.')[1]}/${POD}/map/v1/Prototype.dc.html`,
        `/proto/${good.split('.')[0]}.forged/${POD}/map/v1/Prototype.dc.html`,
        `/proto/${expired}/${POD}/map/v1/Prototype.dc.html`,
      ].map(async (urlPath) => (await harness().request('GET', urlPath)).status)
    );

    expect(statuses).toEqual([401, 401, 401]);
    expect(asked.files).toEqual([]);
  });

  it("lists the pod's versions on /api/made with a token per version, and the mothership reads no file", async () => {
    const cookie = harness().signIn();
    const realFs = jest.requireMock<typeof fs>('fs');
    const reads = [
      jest.spyOn(realFs, 'readFileSync'),
      jest.spyOn(realFs, 'createReadStream'),
      jest.spyOn(realFs.promises, 'readFile'),
    ];
    // Answered by a runner that sends canned bytes, so any read is the
    // mothership's own.
    runner().on('pod-file', () => ({
      base64: Buffer.from('<html><body></body></html>').toString('base64'),
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }));
    runner().on('pod-action', () => ({
      prototypes: [
        {
          slug: 'map',
          versions: [manifest(2), manifest(1)],
        },
      ],
      pictures: [],
    }));

    try {
      const made = await harness().request('GET', `/api/made/${POD}`, {
        cookie,
      });
      const { bases } = made.json<{ bases: Record<string, string> }>();

      expect(made.status).toBe(200);
      expect(Object.keys(bases).sort()).toEqual(['map/v1', 'map/v2']);

      const file = await harness().request(
        'GET',
        `${required(bases['map/v2'], 'base')}Prototype.dc.html`
      );

      expect(file.status).toBe(200);
      reads.forEach((read) => expect(read).toHaveBeenCalledTimes(0));
    } finally {
      reads.forEach((read) => read.mockRestore());
    }
  });
});
