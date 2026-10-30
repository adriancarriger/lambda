import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { chromium } from 'playwright';

import {
  READY_SIGNAL,
  RuntimeNotCachedError,
  renderArtboard,
  serveLayout,
  withArtboard,
} from '../render';
import {
  artboardHtml,
  makeCanvas,
  pngSize,
  quiet,
  rejection,
  tmp,
  useFixtureRuntime,
  writeFile,
} from './canvasFixture';

// Real Chromium: a cold launch is slower than Jest's 5 s default.
jest.setTimeout(60_000);

// A temp folder of this file's own: the layout tests count the
// `lambda-design-layout-*` folders in it, and other suites rendering in
// parallel make their own in the shared one. (Setting TMPDIR would not do:
// jest gives each file its own copy of process.env, which os never reads.)
jest.mock('os', () => {
  const actual: typeof import('os') = jest.requireActual('os');
  const { mkdtempSync }: typeof import('fs') = jest.requireActual('fs');
  const { join }: typeof import('path') = jest.requireActual('path');
  const own = mkdtempSync(join(actual.tmpdir(), 'render-test-'));

  return { ...actual, tmpdir: () => own };
});

// That folder, kept here so only it is ever deleted: never the shared temp
// folder, even if the mock above stopped applying.
const ownTmpDir = os.tmpdir();

if (!path.basename(ownTmpDir).startsWith('render-test-')) {
  throw new Error(
    `render.test.ts expected its own temp folder, got ${ownTmpDir}.`
  );
}

// It goes with the file, once every suite in it has finished.
afterAll(() => {
  fs.rmSync(ownTmpDir, { recursive: true, force: true });
});

describe('renderArtboard', () => {
  const fixture: { restore: () => void } = { restore: () => {} };
  const paths: { out: string } = { out: '' };

  beforeAll(() => {
    fixture.restore = useFixtureRuntime().restore;
  });

  afterAll(() => {
    fixture.restore();
  });

  beforeEach(() => {
    paths.out = path.join(tmp('lambda-design-out-'), 'shots', 'card.png');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('draws a 320×200 artboard, and a different colour draws different bytes', async () => {
    await renderArtboard({
      canvasDir: makeCanvas({ colour: '#1d4ed8' }),
      artboard: 'Main.dc.html',
      out: paths.out,
      log: quiet,
    });
    expect(pngSize(paths.out)).toEqual({ width: 320, height: 200 });

    const recoloured = path.join(path.dirname(paths.out), 'recoloured.png');
    await renderArtboard({
      canvasDir: makeCanvas({ colour: '#f97316' }),
      artboard: 'Main.dc.html',
      out: recoloured,
      log: quiet,
    });
    expect(pngSize(recoloured)).toEqual({ width: 320, height: 200 });
    expect(fs.readFileSync(recoloured).equals(fs.readFileSync(paths.out))).toBe(
      false
    );
  });

  it('rejects with the error the runtime throws', async () => {
    await expect(
      renderArtboard({
        canvasDir: makeCanvas({ mode: 'throw' }),
        artboard: 'Main.dc.html',
        out: paths.out,
        log: quiet,
      })
    ).rejects.toThrow('fixture runtime exploded');
    expect(fs.existsSync(paths.out)).toBe(false);
  });

  it.each([
    [
      'stylesheet',
      '<link rel="stylesheet" href="ds/pawnee/components/bundle.css">',
    ],
    ['script', '<script src="ds/pawnee/components/bundle.js"></script>'],
  ])(
    'rejects naming a %s missing from the canvas (a design system never installed)',
    async (_kind, tag) => {
      await expect(
        renderArtboard({
          canvasDir: makeCanvas({ extra: tag }),
          artboard: 'Main.dc.html',
          out: paths.out,
          log: quiet,
        })
      ).rejects.toThrow(/ds\/pawnee\/components\/bundle\.(css|js) \(404\)/);
      expect(fs.existsSync(paths.out)).toBe(false);
    }
  );

  it('aborts and reports a request to another origin, and still renders', async () => {
    const logs: { logged: string[] } = { logged: [] };
    const result = await renderArtboard({
      canvasDir: makeCanvas({
        extra: '<img src="https://example.com/x.png" alt="">',
      }),
      artboard: 'Main.dc.html',
      out: paths.out,
      log: (line) => {
        logs.logged = [...logs.logged, line];
      },
    });

    expect(result.blocked).toContain('https://example.com/x.png');
    expect(logs.logged.join('\n')).toContain('https://example.com/x.png');
    expect(pngSize(paths.out)).toEqual({ width: 320, height: 200 });
  });

  it('rejects naming the ready signal and the timeout when the artboard never paints', async () => {
    const error = await rejection(
      renderArtboard({
        canvasDir: makeCanvas({ mode: 'silent' }),
        artboard: 'Main.dc.html',
        out: paths.out,
        readyTimeoutMs: 500,
        log: quiet,
      })
    );

    expect(error.message).toContain(READY_SIGNAL);
    expect(error.message).toContain('500');
    expect(fs.existsSync(paths.out)).toBe(false);
  });

  it("counts the page's load against the ready timeout", async () => {
    // Blocks the page for 5 s before `load`; the 500 ms budget must cover it.
    const started = Date.now();
    const error = await rejection(
      renderArtboard({
        canvasDir: makeCanvas({
          extra:
            '<script>var end = Date.now() + 5000; while (Date.now() < end) {}</script>',
        }),
        artboard: 'Main.dc.html',
        out: paths.out,
        readyTimeoutMs: 500,
        log: quiet,
      })
    );

    expect(error.message).toContain(READY_SIGNAL);
    expect(error.message).toContain('500');
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(fs.existsSync(paths.out)).toBe(false);
  });

  it('rejects a settle that never ends instead of hanging (a stylesheet link with no href)', async () => {
    const guard: { timer?: NodeJS.Timeout } = {};
    const error = await rejection(
      withArtboard(
        {
          canvasDir: makeCanvas({}),
          artboard: 'Main.dc.html',
          readyTimeoutMs: 1_000,
          log: quiet,
        },
        async ({ open }) => {
          const { page, settle } = await open();
          // A link with no href never loads, never errors and keeps a null
          // sheet: what an action that adds a half-written stylesheet leaves.
          // (Chromium gives a failed load an empty sheet, so that can't hang.)
          await page.evaluate(`(() => {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            document.head.appendChild(link);
          })()`);
          const hung = new Promise<never>((_, reject) => {
            guard.timer = setTimeout(
              () => reject(new Error('settle() hung')),
              10_000
            );
          });

          return Promise.race([settle(), hung]);
        }
      ).finally(() => clearTimeout(guard.timer))
    );

    expect(error.message).toMatch(/did not settle within 1000 ms/);
  });

  it('throws RuntimeNotCachedError (exit code 3) for a release that is not cached', async () => {
    const launch = jest.spyOn(chromium, 'launch');
    const error = await rejection(
      renderArtboard({
        canvasDir: makeCanvas({ release: '1792416507-85b2' }),
        artboard: 'Main.dc.html',
        out: paths.out,
        log: quiet,
      })
    );

    expect(error).toBeInstanceOf(RuntimeNotCachedError);

    if (!(error instanceof RuntimeNotCachedError)) {
      throw new Error('Expected a RuntimeNotCachedError.');
    }

    expect(error.exitCode).toBe(3);
    expect(error.message).toContain('1792416507-85b2');
    expect(error.message).toContain('lambda design runtime import');
    expect(error.message).toContain(
      'https://claude.ai/artifact/PawneeParksDesign'
    );
    // The newest cached manifest's file list, so the agent knows what to fetch.
    expect(error.message).toContain('artifact-type/dc-runtime.js');
    expect(launch).not.toHaveBeenCalled();
  });

  it('closes its server and removes its layout when the browser fails to launch', async () => {
    const layouts = (): string[] =>
      fs
        .readdirSync(os.tmpdir())
        .filter((name) => name.startsWith('lambda-design-layout-'));
    const before = layouts();
    // Passes through to the real listen, remembering each server.
    const listen = jest.spyOn(http.Server.prototype, 'listen');
    jest
      .spyOn(chromium, 'launch')
      .mockRejectedValue(new Error("Executable doesn't exist"));

    await expect(
      renderArtboard({
        canvasDir: makeCanvas({}),
        artboard: 'Main.dc.html',
        out: paths.out,
        log: quiet,
      })
    ).rejects.toThrow("Executable doesn't exist");

    expect(layouts().filter((name) => !before.includes(name))).toEqual([]);
    expect(listen.mock.contexts.map((server) => server.listening)).toEqual([
      false,
    ]);
  });

  it('removes its layout when copying the canvas into it fails', async () => {
    const layouts = (): string[] =>
      fs
        .readdirSync(os.tmpdir())
        .filter((name) => name.startsWith('lambda-design-layout-'));
    const before = layouts();
    const canvasDir = makeCanvas({});
    // A file the copy can't read.
    const locked = path.join(canvasDir, 'project', 'locked.png');
    fs.writeFileSync(locked, '');
    fs.chmodSync(locked, 0o000);

    try {
      await expect(
        renderArtboard({
          canvasDir,
          artboard: 'Main.dc.html',
          out: paths.out,
          log: quiet,
        })
      ).rejects.toThrow(/EACCES/);
    } finally {
      fs.chmodSync(locked, 0o644);
    }

    expect(layouts().filter((name) => !before.includes(name))).toEqual([]);
  });

  it('reports a failed navigation as itself, not as a timeout', async () => {
    // A real browser whose pages fail to navigate straight away.
    const launch = chromium.launch.bind(chromium);
    jest.spyOn(chromium, 'launch').mockImplementation(async (options) => {
      const browser = await launch(options);
      const newContext = browser.newContext.bind(browser);
      jest.spyOn(browser, 'newContext').mockImplementation(async (opts) => {
        const context = await newContext(opts);
        const newPage = context.newPage.bind(context);
        jest.spyOn(context, 'newPage').mockImplementation(async () => {
          const page = await newPage();
          jest
            .spyOn(page, 'goto')
            .mockRejectedValue(
              new Error('net::ERR_CONNECTION_REFUSED at /project')
            );

          return page;
        });

        return context;
      });

      return browser;
    });

    const error = await rejection(
      renderArtboard({
        canvasDir: makeCanvas({}),
        artboard: 'Main.dc.html',
        out: paths.out,
        log: quiet,
      })
    );

    expect(error.message).toContain('ERR_CONNECTION_REFUSED');
    expect(error.message).not.toContain(READY_SIGNAL);
  });

  it('refuses an artboard outside the canvas before launching a browser', async () => {
    const launch = jest.spyOn(chromium, 'launch');
    const canvasDir = makeCanvas({});
    writeFile(path.join(canvasDir, 'evil.dc.html'), artboardHtml({}));

    await expect(
      renderArtboard({
        canvasDir,
        artboard: '../evil.dc.html',
        out: paths.out,
        log: quiet,
      })
    ).rejects.toThrow(/outside/);
    expect(launch).not.toHaveBeenCalled();
  });

  it('refuses an artboard canvas.json does not list, before launching a browser', async () => {
    const launch = jest.spyOn(chromium, 'launch');
    const canvasDir = makeCanvas({});
    writeFile(
      path.join(canvasDir, 'project', 'Other.dc.html'),
      artboardHtml({})
    );

    await expect(
      renderArtboard({
        canvasDir,
        artboard: 'Other.dc.html',
        out: paths.out,
        log: quiet,
      })
    ).rejects.toThrow(/Other\.dc\.html.*canvas\.json/);
    expect(launch).not.toHaveBeenCalled();
  });

  it('refuses a canvas.json with no "boards" object, before launching a browser', async () => {
    const launch = jest.spyOn(chromium, 'launch');
    const canvasDir = makeCanvas({});
    writeFile(
      path.join(canvasDir, 'project', 'canvas.json'),
      JSON.stringify({ v: 3, title: 'Pawnee Parks' })
    );

    await expect(
      renderArtboard({
        canvasDir,
        artboard: 'Main.dc.html',
        out: paths.out,
        log: quiet,
      })
    ).rejects.toThrow(/canvas\.json has no "boards" object\./);
    expect(launch).not.toHaveBeenCalled();
  });

  it.each(['project/canvas.json', 'design.json'])(
    'refuses a canvas with no %s, before launching a browser',
    async (missing) => {
      const launch = jest.spyOn(chromium, 'launch');
      const canvasDir = makeCanvas({});
      fs.rmSync(path.join(canvasDir, missing));

      await expect(
        renderArtboard({
          canvasDir,
          artboard: 'Main.dc.html',
          out: paths.out,
          log: quiet,
        })
      ).rejects.toThrow(path.basename(missing));
      expect(launch).not.toHaveBeenCalled();
    }
  );
});

describe('serveLayout', () => {
  const get = (
    port: number,
    rawPath: string
  ): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      // `path` is sent verbatim, so Node does not normalise the `..` away.
      const req = http.request(
        { host: '127.0.0.1', port, path: rawPath, method: 'GET' },
        (res) => {
          const received: { body: string } = { body: '' };
          res.on('data', (chunk) => (received.body += chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: received.body })
          );
        }
      );
      req.on('error', reject);
      req.end();
    });

  it('serves only files inside the layout dir', async () => {
    const base = tmp('lambda-design-serve-');
    const layout = path.join(base, 'layout');
    writeFile(path.join(layout, 'project', 'canvas.json'), '{"v":3}');
    writeFile(path.join(base, 'secret.txt'), 'ron-swanson-gold-location');

    const server = await serveLayout(layout);

    try {
      for (const escape of ['/%2e%2e/secret.txt', '/../secret.txt']) {
        const res = await get(server.port, escape);
        expect(res.status).toBe(404);
        expect(res.body).not.toContain('ron-swanson-gold-location');
      }

      const ok = await get(server.port, '/project/canvas.json');
      expect(ok.status).toBe(200);
      expect(ok.body).toBe('{"v":3}');
    } finally {
      await server.close();
    }
  });
});
