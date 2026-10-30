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
import { protoToken, sessionSecret } from '../../mothership/protoToken';
import * as context from '../../pod/context';
import type { Message } from '../../protocol';
import { servePodFile } from '../../runner/podFiles';
import { runScreenshot } from '../screenshots';
import { buildingPodStore } from './fakes';

// Wrapped, not replaced: every read still happens, and can be counted.
jest.mock('fs', () => {
  const actual: typeof import('fs') = jest.requireActual('fs');

  return {
    ...actual,
    readFileSync: jest.fn(actual.readFileSync),
    createReadStream: jest.fn(actual.createReadStream),
    openSync: jest.fn(actual.openSync),
  };
});

/** One tiny valid PNG (1×1). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const POD = 'pawnee-a1b2';
const FOLDER = '/home/leslie/pawnee-parks';

describe('the screenshot route', () => {
  describe("on the pod's runner", () => {
    const seed = (): string => {
      const root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-shots-'))
      );
      const attempt = path.join(root, POD, 'screenshots', '3', '1');
      fs.mkdirSync(attempt, { recursive: true });
      fs.writeFileSync(path.join(attempt, 'ramsett.png'), PNG);
      fs.writeFileSync(path.join(attempt, 'fake.png'), 'not a picture');
      fs.writeFileSync(path.join(attempt, 'manifest.json'), '[]');
      fs.writeFileSync(path.join(root, 'config.json'), '{"secret": 1}');
      fs.writeFileSync(path.join(root, 'outside.png'), PNG);
      fs.symlinkSync(
        path.join(root, 'outside.png'),
        path.join(attempt, 'escape.png')
      );
      const designs = path.join(root, POD, 'designs', 'home');
      fs.mkdirSync(designs, { recursive: true });
      fs.writeFileSync(path.join(designs, 'after.png'), PNG);
      const files = path.join(
        root,
        POD,
        'designs',
        'desk',
        'prototype',
        'v1',
        'files'
      );
      fs.mkdirSync(files, { recursive: true });
      fs.writeFileSync(path.join(files, 'Desk.dc.html'), '<html>desk</html>');
      fs.writeFileSync(path.join(files, 'run.exe'), 'MZ');

      return root;
    };

    const ask = (root: string, folder: string, rest: string) =>
      servePodFile(root, { podId: POD, folder, path: rest });

    it('serves a PNG and its manifest from the screenshots folder', () => {
      const root = seed();

      expect(ask(root, 'screenshots', '3/1/ramsett.png')).toEqual({
        base64: PNG.toString('base64'),
        headers: { 'content-type': 'image/png', 'cache-control': 'no-cache' },
      });
      expect(ask(root, 'screenshots', '3/1/manifest.json')).toEqual({
        base64: Buffer.from('[]').toString('base64'),
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-cache',
        },
      });
    });

    it.each([
      ['../../config.json'],
      ['3/1/../../../../config.json'],
      ['/etc/passwd'],
      [`${os.tmpdir()}/x.png`],
      ['3/1/escape.png'],
      ['3/1/fake.png'],
      ['3/1/missing.png'],
    ])('answers 404 (null) for %s, reading nothing outside', (rest) => {
      expect(ask(seed(), 'screenshots', rest)).toBeNull();
    });

    it('serves designs and shots by the same rules', () => {
      const root = seed();

      expect(ask(root, 'designs', 'home/after.png')?.base64).toBe(
        PNG.toString('base64')
      );
      expect(ask(root, 'shots', 'home/after.png')).toBeNull();
    });

    it('serves a prototype file of a known type, inside its files/ only', () => {
      const root = seed();

      expect(ask(root, 'prototype', 'desk/v1/Desk.dc.html')).toEqual({
        base64: Buffer.from('<html>desk</html>').toString('base64'),
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
      expect(ask(root, 'prototype', 'desk/v1/run.exe')).toBeNull();
      expect(ask(root, 'prototype', 'desk/v1/../../../../config.json')).toBe(
        null
      );
    });

    it('answers 404 (null) for a folder it was never given', () => {
      expect(ask(seed(), 'questions', 'q1.json')).toBeNull();
      expect(ask(seed(), '..', 'config.json')).toBeNull();
    });
  });

  describe('on the mothership', () => {
    const fixture: { harness?: Harness; runner?: FakeRunner } = {};
    const harness = (): Harness => required(fixture.harness, 'harness');
    const runner = (): FakeRunner => required(fixture.runner, 'runner');
    const asked: { files: Message[]; actions: string[] } = {
      files: [],
      actions: [],
    };

    beforeEach(async () => {
      asked.files = [];
      asked.actions = [];
      // A short wait for the runner, so the no-answer case is quick.
      fixture.harness = await startHarness({ timeoutMs: 1000 });
      fixture.runner = await connectRunner(harness(), {
        name: "Leslie's MacBook",
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
      runner().on('pod-file', (message) => {
        asked.files = [...asked.files, message];

        return String(message.path).endsWith('.html')
          ? {
              base64: Buffer.from('<html><body>desk</body></html>').toString(
                'base64'
              ),
              headers: { 'content-type': 'text/html; charset=utf-8' },
            }
          : {
              base64: PNG.toString('base64'),
              headers: { 'content-type': 'image/png' },
            };
      });
      runner().on('pod-action', (message) => {
        asked.actions = [...asked.actions, String(message.action)];

        return { prototypes: [], pictures: [] };
      });
    });

    afterEach(async () => {
      await runner().close();
      await harness().close();
    });

    const get = (urlPath: string) =>
      harness().request('GET', urlPath, { cookie: harness().signIn() });

    const readSpies = () => [
      jest.mocked(fs.readFileSync),
      jest.mocked(fs.createReadStream),
      jest.mocked(fs.openSync),
    ];

    /** Counting from now: reads of anything in the pod's folder. */
    const countPodReads = (): (() => number) => {
      readSpies().forEach((spy) => spy.mockClear());

      return () =>
        readSpies().reduce(
          (count, spy) =>
            count +
            spy.mock.calls.filter(([file]) => String(file).includes(POD))
              .length,
          0
        );
    };

    it("asks the pod's runner once and reads no file itself", async () => {
      const reads = [
        jest.mocked(fs.readFileSync),
        jest.mocked(fs.createReadStream),
        jest.mocked(fs.openSync),
      ];
      reads.forEach((spy) => spy.mockClear());
      const response = await get(
        `/api/pod-file/${POD}/screenshots/3/1/ramsett.png`
      );
      const readCount = reads.reduce(
        (count, spy) =>
          count +
          spy.mock.calls.filter(([file]) => String(file).includes(POD)).length,
        0
      );

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('image/png');
      expect(asked.files).toEqual([
        expect.objectContaining({
          type: 'pod-file',
          podId: POD,
          folder: 'screenshots',
          path: '3/1/ramsett.png',
        }),
      ]);
      expect(readCount).toBe(0);
    });

    it('sends designs, shots and prototype files over the same message', async () => {
      const token = protoToken(
        sessionSecret(harness().db),
        POD,
        'desk',
        'v1',
        harness().clock.now
      );

      const podReads = countPodReads();
      const statuses = await Promise.all(
        [
          `/api/pod-file/${POD}/designs/a.png`,
          `/api/pod-file/${POD}/shots/a.png`,
        ].map(async (urlPath) => (await get(urlPath)).status)
      );
      const proto = await harness().request(
        'GET',
        `/proto/${token}/${POD}/desk/v1/Desk.dc.html`
      );

      expect(statuses).toEqual([200, 200]);
      expect(proto.status).toBe(200);
      expect(proto.headers['content-security-policy']).toContain(
        'sandbox allow-scripts'
      );
      expect(proto.text).toContain('<script>');
      expect(
        asked.files.map((message) => [message.folder, message.path])
      ).toEqual([
        ['designs', 'a.png'],
        ['shots', 'a.png'],
        ['prototype', 'desk/v1/Desk.dc.html'],
      ]);
      expect(asked.actions).toEqual([]);
      // The runner answered every one: the mothership read no file itself.
      expect(podReads()).toBe(0);
    });

    it('refuses a prototype file, which only /proto/ serves, asking no runner', async () => {
      const response = await get(
        `/api/pod-file/${POD}/prototype/desk/v1/Desk.dc.html`
      );

      expect(response.status).toBe(404);
      expect(asked.files).toEqual([]);
    });

    it("types a file by its name, never by the runner's headers", async () => {
      runner().on('pod-file', () => ({
        base64: PNG.toString('base64'),
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }));

      const png = await get(`/api/pod-file/${POD}/screenshots/3/1/a.png`);
      const manifest = await get(
        `/api/pod-file/${POD}/screenshots/3/1/manifest.json`
      );

      expect(png.headers['content-type']).toBe('image/png');
      expect(manifest.headers['content-type']).toBe('application/json');
    });

    it('answers 404 when the runner has no such file', async () => {
      runner().on('pod-file', () => null);

      expect(
        (await get(`/api/pod-file/${POD}/screenshots/3/1/escape.png`)).status
      ).toBe(404);
    });

    it("asks the runner for /api/made, never reading the pod's folder", async () => {
      const response = await get(`/api/made/${POD}`);

      expect(response.status).toBe(200);
      expect(asked.actions).toEqual(['made']);
    });

    it('says the computer is offline when its socket is closed', async () => {
      await runner().close();
      const response = await get(
        `/api/pod-file/${POD}/screenshots/3/1/ramsett.png`
      );

      expect(response.status).toBe(409);
      expect(response.json().error).toBe("Leslie's MacBook is offline.");
    });

    it('answers 504 when the computer never answers', async () => {
      runner().on('pod-file', () => new Promise(() => undefined));
      const response = await get(
        `/api/pod-file/${POD}/screenshots/3/1/ramsett.png`
      );

      expect(response.status).toBe(504);
      expect(response.json().error).toBe(
        "Leslie's MacBook didn't answer. Try again."
      );
    });
  });
});

describe('lambda pod screenshot', () => {
  const setUp = (testStarts: number) => {
    const made = buildingPodStore();
    made.store.writeBuilding(made.podId, {
      runs: [
        {
          id: '3',
          title: 'Trail markers',
          step: testStarts === 0 ? 'check-ticket' : 'test',
          attempt: Math.max(testStarts, 1),
          startedAt: '2026-10-23T10:00:00.000Z',
          claim: 'claimed',
        },
      ],
      upNext: [],
    });
    Array.from({ length: testStarts }, (_, n) =>
      made.store.appendStep(made.podId, {
        at: new Date(Date.UTC(2026, 9, 23, 10, n)).toISOString(),
        step: 'test',
        event: 'start',
        by: 'engineering-manager',
        pass: n + 1,
        ticket: '3',
      })
    );
    process.env.LAMBDA_PODS_ROOT = made.store.root;
    const shots = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-shots-'));
    fs.writeFileSync(path.join(shots, 'ramsett.png'), PNG);
    fs.writeFileSync(path.join(shots, 'notes.png'), 'just text, named .png');

    return { ...made, shots };
  };

  const shoot = (
    podId: string,
    file: string,
    extra: Record<string, unknown> = {}
  ) =>
    runScreenshot(podId, file, {
      url: 'http://localhost:3000/parks/ramsett',
      console: ['TypeError: pin is undefined'],
      conclusion: 'The Ramsett Park pin never appeared.',
      failed: true,
      ...extra,
    });

  afterEach(() => {
    delete process.env.LAMBDA_PODS_ROOT;
  });

  it('copies and records under the manifest lock, so two at once keep both entries', () => {
    const { store, podId, shots } = setUp(1);
    const lock = path.join(
      store.screenshotDir(podId, '3', 1),
      'manifest.json.lock'
    );
    const locked: { atWrite: boolean[] } = { atWrite: [] };
    const spy = jest.spyOn(context, 'openStore').mockReturnValue({
      ...store,
      writeScreenshots: (...args) => {
        locked.atWrite = [...locked.atWrite, fs.existsSync(lock)];
        store.writeScreenshots(...args);
      },
    });

    try {
      shoot(podId, path.join(shots, 'ramsett.png'));
    } finally {
      spy.mockRestore();
    }

    expect(locked.atWrite).toEqual([true]);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('copies the PNG under the ticket and test attempt, with a manifest entry', () => {
    const { store, podId, shots } = setUp(2);

    shoot(podId, path.join(shots, 'ramsett.png'));

    const dir = store.screenshotDir(podId, '3', 2);
    expect(fs.readFileSync(path.join(dir, 'ramsett.png'))).toEqual(PNG);
    expect(store.readScreenshots(podId, '3', 2)).toEqual([
      {
        file: 'ramsett.png',
        ticketId: '3',
        attempt: 2,
        url: 'http://localhost:3000/parks/ramsett',
        consoleErrors: ['TypeError: pin is undefined'],
        conclusion: 'The Ramsett Park pin never appeared.',
        passed: false,
        at: expect.any(String),
      },
    ]);
  });

  it("counts only this run's test starts, so a re-run ticket starts again at attempt 1", () => {
    const { store, podId, shots } = setUp(1);
    // The ticket's earlier run, before it was blocked and set back to Ready.
    store.appendStep(podId, {
      at: '2026-10-22T09:00:00.000Z',
      step: 'test',
      event: 'start',
      by: 'engineering-manager',
      pass: 1,
      ticket: '3',
    });

    shoot(podId, path.join(shots, 'ramsett.png'));

    expect(
      store.readScreenshots(podId, '3', 1).map((shot) => shot.file)
    ).toEqual(['ramsett.png']);
    expect(store.readScreenshots(podId, '3', 2)).toEqual([]);
  });

  it('stores a name the runner serves, whatever qa called the file', () => {
    const { store, podId, shots } = setUp(1);
    [
      'Screen Shot 2026-10-23 at 1.02 PM.png',
      'Screen Shot 2026-10-23 at 1.02 PM.png',
      ' (pin).PNG',
    ].forEach((name) => {
      fs.writeFileSync(path.join(shots, name), PNG);
      shoot(podId, path.join(shots, name));
    });

    const names = store.readScreenshots(podId, '3', 1).map((shot) => shot.file);
    expect(names).toEqual([
      'Screen-Shot-2026-10-23-at-1.02-PM.png',
      'Screen-Shot-2026-10-23-at-1.02-PM-2.png',
      'pin.png',
    ]);
    names.forEach((name) => {
      expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
      expect(
        fs.readFileSync(path.join(store.screenshotDir(podId, '3', 1), name))
      ).toEqual(PNG);
    });
  });

  it('refuses a missing file and a PNG-named text file, writing nothing', () => {
    const { store, podId, shots } = setUp(1);

    expect(() => shoot(podId, path.join(shots, 'gone.png'))).toThrow(
      /isn't there/
    );
    expect(() => shoot(podId, path.join(shots, 'notes.png'))).toThrow(
      /isn't a PNG/
    );
    expect(fs.existsSync(store.screenshotDir(podId, '3', 1))).toBe(false);
  });

  it('refuses with no test step started for the current ticket', () => {
    const { store, podId, shots } = setUp(0);

    expect(() => shoot(podId, path.join(shots, 'ramsett.png'))).toThrow(
      "No ticket is being tested, so there's nothing to attach this screenshot to."
    );
    expect(fs.existsSync(store.file(podId, 'screenshots'))).toBe(false);
  });

  it('needs exactly one of --passed and --failed', () => {
    const { podId, shots } = setUp(1);

    expect(() =>
      shoot(podId, path.join(shots, 'ramsett.png'), { passed: true })
    ).toThrow('Say whether it passed: exactly one of --passed or --failed.');
    expect(() =>
      shoot(podId, path.join(shots, 'ramsett.png'), { failed: undefined })
    ).toThrow('Say whether it passed: exactly one of --passed or --failed.');
  });
});
