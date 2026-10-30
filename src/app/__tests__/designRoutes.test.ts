import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

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
import { FULL_UNAVAILABLE, RenderSwitch } from '../client/WorkflowPanel';

/**
 * The UX review's pictures in Lambda: `/api/pod-file/` sits behind the
 * sign-in, is forwarded to the runner that has the pod (the mothership reads
 * none of a pod's files), and the workflow panel greys out Full when that
 * runner can't use Claude Design.
 */

// Spy-able: the mothership's file reads are counted.
jest.mock('fs', () => ({ ...jest.requireActual('fs') }));
jest.mock('../client/Tip', () => ({
  Tip: ({ children }: { children: unknown }) => children,
}));

const POD = 'pawnee-map-a1b2';
const FOLDER = '/home/leslie/pawnee-parks';
/** One tiny valid PNG (1×1). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** A pods root on "the runner": one design picture and the pod's own files. */
const seedPodsRoot = (): string => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-design-routes-'))
  );
  const designs = path.join(root, POD, 'designs', 'trail-map');
  fs.mkdirSync(designs, { recursive: true });
  fs.writeFileSync(path.join(designs, 'trail-closed.png'), PNG);
  fs.writeFileSync(path.join(root, POD, 'pod.json'), '{"secret":true}');

  return root;
};

describe('the pod-file route', () => {
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
      `/api/pod-file/${POD}/designs/trail-map/trail-closed.png`
    );

    expect(response.status).toBe(401);
    expect(asked.files).toEqual([]);
  });

  it("forwards the request to the pod's runner, and the mothership reads no file", async () => {
    runner().on('pod-file', (message) => {
      asked.files = [...asked.files, message];

      return { base64: PNG.toString('base64'), headers: {} };
    });
    const cookie = harness().signIn();
    // The module object itself: every `import * as fs` reads through it.
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
        `/api/pod-file/${POD}/designs/trail-map/trail-closed.png`,
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
        folder: 'designs',
        path: 'trail-map/trail-closed.png',
      }),
    ]);
  });

  it("serves the runner's own picture through the runner's checks, and never the pod's other files", async () => {
    const root = required(fixture.root, 'root');
    runner().on('pod-file', (message) =>
      servePodFile(root, podFileRequestOf(message))
    );
    const cookie = harness().signIn();
    const get = (urlPath: string) =>
      harness().request('GET', urlPath, { cookie });

    const picture = await get(
      `/api/pod-file/${POD}/designs/trail-map/trail-closed.png`
    );

    expect(picture.status).toBe(200);
    expect(picture.headers['cache-control']).toBe('no-cache');

    const statuses = await Promise.all(
      [
        `/api/pod-file/${POD}/designs/../pod.json`,
        `/api/pod-file/${POD}/designs/%2e%2e/pod.json`,
        `/api/pod-file/${POD}/designs/trail-map/missing.png`,
      ].map(async (urlPath) => (await get(urlPath)).status)
    );

    expect(statuses).toEqual([404, 404, 404]);
  });

  it('answers 409 "<computer name> is offline." when the pod\'s runner is disconnected', async () => {
    const cookie = harness().signIn();
    await runner().close();
    // The mothership notices the socket closing.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const response = await harness().request(
      'GET',
      `/api/pod-file/${POD}/designs/trail-map/trail-closed.png`,
      { cookie }
    );

    expect(response.status).toBe(409);
    expect(response.text).toContain("Ann's MacBook is offline.");
  });
});

describe("the workflow panel's Render switch", () => {
  const render = (designAvailable: boolean | undefined): string =>
    renderToStaticMarkup(
      createElement(RenderSwitch, {
        mode: 'ascii',
        designAvailable,
        onChange: () => undefined,
      })
    );

  it("greys out Full, saying why, when the pod's runner reports design.available false", () => {
    const html = render(false);

    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Full<\/button>/);
    expect(html).toContain(
      'Full needs Claude Design, which isn&#x27;t available with this Claude account.'
    );
    expect(FULL_UNAVAILABLE).toBe(
      "Full needs Claude Design, which isn't available with this Claude account."
    );
  });

  it.each([true, undefined])(
    'offers Full when the runner reports %s',
    (available) => {
      const html = render(available);

      expect(html).not.toContain('disabled');
      expect(html).not.toContain('Full needs Claude Design');
    }
  );
});
