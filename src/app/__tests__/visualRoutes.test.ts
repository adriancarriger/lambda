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
import { podFileRequestOf, servePodFile } from '../../runner/podFiles';

/**
 * The visual check's pictures in the app: `/api/pod/<pod>/visual/…` sits
 * behind the sign-in, is forwarded to the runner that has the pod with one
 * `pod-file` message (the mothership reads none of a pod's files), and the
 * runner serves only PNGs and each round's manifest.json inside `visual/`.
 */

// Spy-able: the mothership's file reads are counted.
jest.mock('fs', () => ({ ...jest.requireActual('fs') }));

const POD = 'pawnee-map-a1b2';
const FOLDER = '/home/leslie/pawnee-parks';
/** One tiny valid PNG (1×1). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const ROUND = `/api/pod/${POD}/visual/PAWNEE-5/1`;

/** A pods root on "the runner": one recorded round and the pod's own files. */
const seedPodsRoot = (): string => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-visual-routes-'))
  );
  const round = path.join(root, POD, 'visual', 'PAWNEE-5', '1');
  fs.mkdirSync(round, { recursive: true });
  fs.writeFileSync(path.join(round, 'expected-trail-closed.png'), PNG);
  fs.writeFileSync(path.join(round, 'fake.png'), 'not a picture');
  fs.writeFileSync(path.join(round, 'manifest.json'), '[]\n');
  fs.writeFileSync(path.join(round, 'notes.json'), '{"secret":true}');
  fs.writeFileSync(path.join(root, POD, 'config.json'), '{"secret":true}');
  const outside = path.join(root, 'outside.png');
  fs.writeFileSync(outside, PNG);
  fs.symlinkSync(outside, path.join(round, 'link.png'));

  return root;
};

describe('the visual picture route', () => {
  const fixture: { harness?: Harness; runner?: FakeRunner; root?: string } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');
  const runner = (): FakeRunner => required(fixture.runner, 'runner');
  const asked: { files: unknown[] } = { files: [] };

  beforeEach(async () => {
    asked.files = [];
    fixture.root = seedPodsRoot();
    fixture.harness = await startHarness();
    fixture.runner = await connectRunner(harness(), {
      name: "Ann's MacBook",
    });
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
  });

  afterEach(async () => {
    await runner()
      .close()
      .catch(() => undefined);
    await harness().close();
    fs.rmSync(required(fixture.root, 'root'), { recursive: true, force: true });
  });

  it('is refused without a session, and the runner is never asked', async () => {
    runner().on('pod-file', (message) => {
      asked.files = [...asked.files, message];

      return null;
    });
    const response = await harness().request(
      'GET',
      `${ROUND}/expected-trail-closed.png`
    );

    expect(response.status).toBe(401);
    expect(asked.files).toEqual([]);
  });

  it('is in the route table the sign-in check walks', () => {
    expect(
      harness().mothership.routes.some((route) =>
        route.sample.startsWith(`/api/pod/p1/visual/`)
      )
    ).toBe(true);
  });

  it("sends one pod-file message to the pod's runner, and the mothership reads no file", async () => {
    runner().on('pod-file', (message) => {
      asked.files = [...asked.files, message];

      return { base64: PNG.toString('base64'), headers: {} };
    });
    const cookie = harness().signIn();
    const realFs = jest.requireMock<typeof fs>('fs');
    const reads = [
      jest.spyOn(realFs, 'readFileSync'),
      jest.spyOn(realFs, 'createReadStream'),
      jest.spyOn(realFs, 'openSync'),
      jest.spyOn(realFs.promises, 'readFile'),
    ];

    try {
      const response = await harness().request(
        'GET',
        `${ROUND}/expected-trail-closed.png`,
        { cookie }
      );

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('image/png');
      reads.forEach((read) => expect(read).toHaveBeenCalledTimes(0));
    } finally {
      reads.forEach((read) => read.mockRestore());
    }

    expect(asked.files).toEqual([
      expect.objectContaining({
        type: 'pod-file',
        podId: POD,
        folder: 'visual',
        path: 'PAWNEE-5/1/expected-trail-closed.png',
      }),
    ]);
  });

  it("serves the round's PNGs and manifest through the runner's checks, and nothing else", async () => {
    const root = required(fixture.root, 'root');
    runner().on('pod-file', (message) =>
      servePodFile(root, podFileRequestOf(message))
    );
    const cookie = harness().signIn();
    const get = (urlPath: string) =>
      harness().request('GET', urlPath, { cookie });

    const picture = await get(`${ROUND}/expected-trail-closed.png`);
    expect(picture.status).toBe(200);
    expect(picture.headers['content-type']).toBe('image/png');

    const manifest = await get(`${ROUND}/manifest.json`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers['content-type']).toBe('application/json');

    const statuses = await Promise.all(
      [
        `/api/pod/${POD}/visual/../../config.json`,
        `/api/pod/${POD}/visual/%2e%2e/%2e%2e/config.json`,
        `/api/pod/${POD}/visual/${encodeURIComponent('/etc/passwd')}`,
        `${ROUND}/notes.json`,
        `${ROUND}/link.png`,
        `${ROUND}/fake.png`,
        `${ROUND}/missing.png`,
      ].map(async (urlPath) => (await get(urlPath)).status)
    );

    expect(statuses).toEqual([404, 404, 404, 404, 404, 404, 404]);
  });

  it('answers 409 "<computer name> is offline." when the pod\'s runner is disconnected', async () => {
    const cookie = harness().signIn();
    await runner().close();
    // The mothership notices the socket closing.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const response = await harness().request(
      'GET',
      `${ROUND}/expected-trail-closed.png`,
      { cookie }
    );

    expect(response.status).toBe(409);
    expect(response.text).toContain("Ann's MacBook is offline.");
  });
});
