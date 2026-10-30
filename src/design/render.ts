import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { type Browser, type Page, chromium, errors } from 'playwright';

import {
  ARTBOARD_RUNTIME,
  type RuntimeManifest,
  assertRelease,
  newestManifest,
  readManifest,
  runtimeReleaseDir,
  runtimeStatus,
} from './runtime';

/**
 * Draw one Claude Design artboard to a PNG, offline: no browser signed in to
 * anyone, nothing fetched from claude.ai. The canvas folder's `project/` and
 * the cached runtime are laid out as the Artifact publishes them, served on
 * 127.0.0.1, and the artboard is opened in headless Chromium.
 *
 * What the first proof found (release 1792416507-85b2):
 *   - An artboard's `<script src="./support.js">` is the type's
 *     `artifact-type/dc-runtime.js` (React 18 plus the Design Component
 *     runtime). It is not one of the published files, so the layout puts a copy
 *     beside every artboard.
 *   - The runtime swaps `<x-dc>` for `#dc-root` and renders into it. Its only
 *     explicit signal, the `__dc_booted` message, goes to a parent frame and
 *     fires at mount, before the helmet's stylesheets load. So "ready" is
 *     READY_SIGNAL below.
 *   - A plain artboard requests nothing outside its own origin. An artboard
 *     with a Google Fonts `css2` link (the one outside request the type's
 *     format allows) requests the two hosts in ALLOWED_HOSTS.
 */

export const READY_SIGNAL =
  '#dc-root rendered, stylesheets loaded, document.fonts.ready, two animation frames';

export const ALLOWED_HOSTS = [
  // The Google Fonts `css2` stylesheet an artboard's <helmet> may link.
  'fonts.googleapis.com',
  // The font files that stylesheet points at.
  'fonts.gstatic.com',
];

const DEFAULT_READY_TIMEOUT_MS = 20_000;

/** The canvas is pinned to a release that is not cached `ready` (exit 3). */
export class RuntimeNotCachedError extends Error {
  readonly exitCode = 3;

  constructor(message: string) {
    super(message);
    // Kept so `instanceof` (how `lambda design render` picks exit 3) holds
    // even when this is compiled to ES5, where extending Error drops the
    // subclass prototype.
    Object.setPrototypeOf(this, RuntimeNotCachedError.prototype);
    this.name = 'RuntimeNotCachedError';
  }
}

export interface DesignJson {
  url: string;
  typeUrl: string;
  release: string;
}

export interface CanvasJson {
  boards: Record<string, { w: number; h: number; title?: string }>;
  /** The canvas's own title, when it has one. */
  title?: string;
  /** The boards in the canvas's order (`order`, else as listed). */
  order: string[];
}

export interface RenderOptions {
  /** The canvas folder: `design.json` plus `project/…`. */
  canvasDir: string;
  /** The artboard's file name, relative to `<canvasDir>/project/`. */
  artboard: string;
  out: string;
  scale?: number;
  readyTimeoutMs?: number;
  /** Where blocked requests are reported. Default: stderr. */
  log?: (line: string) => void;
}

export interface RenderResult {
  out: string;
  width: number;
  height: number;
  /** Requests to other origins, aborted. */
  blocked: string[];
}

const isInside = (dir: string, target: string): boolean => {
  const rel = path.relative(dir, target);

  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

const readJson = (file: string, label: string): unknown => {
  if (!fs.existsSync(file)) {
    throw new Error(`The canvas folder has no ${label} (${file}).`);
  }

  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));

  return parsed;
};

export const readDesignJson = (canvasDir: string): DesignJson => {
  const design = readJson(path.join(canvasDir, 'design.json'), 'design.json');

  if (
    typeof design !== 'object' ||
    design === null ||
    !('release' in design) ||
    typeof design.release !== 'string' ||
    !('url' in design) ||
    typeof design.url !== 'string'
  ) {
    throw new Error(
      `${path.join(
        canvasDir,
        'design.json'
      )} needs "url" and "release" (rewrite it from the canvas's latest publish or read result).`
    );
  }

  assertRelease(design.release);

  return {
    url: design.url,
    typeUrl:
      'typeUrl' in design && typeof design.typeUrl === 'string'
        ? design.typeUrl
        : '',
    release: design.release,
  };
};

/** `canvas.json`'s `boards`, narrowed: each board needs a numeric `w` and `h`. */
export const readCanvasJson = (file: string): CanvasJson => {
  const canvas = readJson(file, 'project/canvas.json');

  if (
    typeof canvas !== 'object' ||
    canvas === null ||
    !('boards' in canvas) ||
    typeof canvas.boards !== 'object' ||
    canvas.boards === null
  ) {
    throw new Error(`${file} has no "boards" object.`);
  }

  const boards = Object.fromEntries(
    Object.entries(canvas.boards).map(([name, board]: [string, unknown]) => {
      if (
        typeof board !== 'object' ||
        board === null ||
        !('w' in board) ||
        typeof board.w !== 'number' ||
        !('h' in board) ||
        typeof board.h !== 'number'
      ) {
        throw new Error(
          `${file} lists board ${name} without a numeric "w" and "h".`
        );
      }

      return [
        name,
        {
          w: board.w,
          h: board.h,
          ...('title' in board && typeof board.title === 'string'
            ? { title: board.title }
            : {}),
        },
      ];
    })
  );
  const listed =
    'order' in canvas && Array.isArray(canvas.order)
      ? canvas.order.filter(
          (name): name is string => typeof name === 'string' && name in boards
        )
      : [];

  return {
    boards,
    ...('title' in canvas && typeof canvas.title === 'string'
      ? { title: canvas.title }
      : {}),
    order: [
      ...listed,
      ...Object.keys(boards).filter((name) => !listed.includes(name)),
    ],
  };
};

const artboardSize = (
  projectDir: string,
  artboard: string
): { width: number; height: number } => {
  if (!isInside(projectDir, path.resolve(projectDir, artboard))) {
    throw new Error(
      `Artboard ${artboard} resolves outside the canvas's project/ folder.`
    );
  }

  const canvas = readCanvasJson(path.join(projectDir, 'canvas.json'));
  const board = canvas.boards[artboard];

  if (board === undefined) {
    throw new Error(
      `Artboard ${artboard} is not listed in project/canvas.json (boards: ${Object.keys(
        canvas.boards
      ).join(', ')}).`
    );
  }

  if (!fs.existsSync(path.join(projectDir, artboard))) {
    throw new Error(`Artboard ${artboard} is listed but its file is missing.`);
  }

  return { width: board.w, height: board.h };
};

const notCachedMessage = (design: DesignJson): string => {
  const newest = newestManifest();
  const files =
    newest === null
      ? '  (no release is cached yet; fetch every file of the Design type)'
      : newest.files.map((file) => `  ${file}`).join('\n');

  return [
    `Design runtime release ${design.release} is not cached ready.`,
    `Canvas: ${design.url}`,
    `Fetch its files with Artifact read (url: the canvas above), e.g. the files of the newest cached release${
      newest === null ? '' : ` (${newest.release})`
    }:`,
    files,
    `then run: lambda design runtime import <the folder they were saved to> --release ${design.release}`,
  ].join('\n');
};

/** The canvas's runtime release, cached ready; else RuntimeNotCachedError (exit 3). */
export const requireRuntime = (design: DesignJson): RuntimeManifest => {
  const manifest =
    runtimeStatus(design.release) === 'ready'
      ? readManifest(design.release)
      : null;

  if (manifest === null) {
    throw new RuntimeNotCachedError(notCachedMessage(design));
  }

  return manifest;
};

/** Every artboard loads `./support.js`, so each folder holding one gets a copy. */
export const copyArtboardRuntime = (
  projectDir: string,
  runtimeFile: string
): void => {
  const artboardDirs = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.dc.html')) {
        artboardDirs.add(dir);
      }
    }
  };
  walk(projectDir);
  artboardDirs.forEach((dir) =>
    fs.copyFileSync(runtimeFile, path.join(dir, 'support.js'))
  );
};

/** Lay out what the Artifact publishes: the runtime's files, plus the canvas's project/. */
const buildLayout = (canvasDir: string, manifest: RuntimeManifest): string => {
  const layout = fs.mkdtempSync(
    path.join(os.tmpdir(), 'lambda-design-layout-')
  );
  const runtimeDir = runtimeReleaseDir(manifest.release);

  try {
    for (const file of manifest.files) {
      const to = path.join(layout, file);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(runtimeDir, file), to);
    }

    fs.cpSync(path.join(canvasDir, 'project'), path.join(layout, 'project'), {
      recursive: true,
    });
    copyArtboardRuntime(
      path.join(layout, 'project'),
      path.join(runtimeDir, ARTBOARD_RUNTIME)
    );
  } catch (error) {
    fs.rmSync(layout, { recursive: true, force: true });

    throw error;
  }

  return layout;
};

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

const resolveRequest = (root: string, url: string): string | null => {
  try {
    const pathname = decodeURIComponent(
      new URL(url, 'http://127.0.0.1').pathname
    );
    // `new URL` collapses `..`; a raw request line may still carry one, so the
    // raw pathname is checked as well as the parsed one.
    const raw = decodeURIComponent(url.split('?')[0] ?? '');

    if (pathname.includes('\0') || raw.split('/').includes('..')) {
      return null;
    }

    const file = path.resolve(root, `.${pathname}`);

    if (!isInside(root, file) || !fs.existsSync(file)) {
      return null;
    }

    const real = fs.realpathSync(file);

    return isInside(fs.realpathSync(root), real) && fs.statSync(real).isFile()
      ? real
      : null;
  } catch {
    return null;
  }
};

/** Serve `dir` on 127.0.0.1 (random port). A path outside it is a 404, never a file. */
export const serveLayout = (
  dir: string
): Promise<{ port: number; close: () => Promise<void> }> => {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    const file = resolveRequest(root, req.url ?? '/');

    if (file === null) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');

      return;
    }

    res.writeHead(200, {
      'content-type':
        CONTENT_TYPES[path.extname(file).toLowerCase()] ??
        'application/octet-stream',
    });
    fs.createReadStream(file).pipe(res);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (address === null || typeof address === 'string') {
        reject(new Error('The layout server did not get a TCP port.'));

        return;
      }

      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
};

const ROOT_RENDERED = `(document.getElementById('dc-root')?.childElementCount ?? 0) > 0`;

// Waits for the <helmet> stylesheets the runtime adds after mount, forces a
// layout so the fonts they name start loading, then fonts and two frames.
const SETTLED = `(async () => {
  const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
  await Promise.all(links.map((link) => link.sheet !== null ? null : new Promise((done) => {
    link.addEventListener('load', done);
    link.addEventListener('error', done);
  })));
  void document.body.offsetHeight;
  await document.fonts.ready;
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
})()`;

/** A promise that rejects with `error` after `ms`, unless cancelled first. */
const rejectAfter = (
  error: Error,
  ms: number
): { promise: Promise<never>; cancel: () => void } => {
  const holder: { timer?: NodeJS.Timeout } = {};
  const promise = new Promise<never>((_, reject) => {
    holder.timer = setTimeout(() => reject(error), ms);
  });

  return { promise, cancel: () => clearTimeout(holder.timer) };
};

/**
 * Load the artboard and wait for READY_SIGNAL, all within `timeoutMs`: the
 * deadline starts before `goto`, so a slow allowed host holding the page's
 * `load` cannot stretch the wait past it.
 */
const loadUntilReady = async (
  page: Page,
  url: string,
  timeoutMs: number
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  const remaining = (): number => Math.max(0, deadline - Date.now());
  const timedOut = new Error(
    `The artboard was not ready within ${timeoutMs} ms (waiting for: ${READY_SIGNAL}).`
  );

  await page.goto(url, { timeout: timeoutMs }).catch((error: unknown) => {
    if (error instanceof errors.TimeoutError) {
      throw timedOut;
    }

    throw new Error(
      `Loading the artboard failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  });

  // Browser-side code is passed as strings, so it never needs the DOM lib.
  await page
    .waitForFunction(ROOT_RENDERED, null, { timeout: Math.max(1, remaining()) })
    .catch(() => {
      throw timedOut;
    });

  const settled = page.evaluate(SETTLED);

  // If the timeout wins, `settled` rejects later when the browser closes.
  settled.catch(() => {});
  const timeout = rejectAfter(timedOut, remaining());

  try {
    await Promise.race([settled, timeout.promise]);
  } finally {
    timeout.cancel();
  }
};

/** One loaded page of an artboard (see ArtboardSession.open). */
export interface OpenArtboard {
  page: Page;
  /** Throws the first page error seen so far, if any. */
  check: () => void;
  /** Wait for stylesheets, fonts and two frames after an action, then check(). */
  settle: () => Promise<void>;
}

export interface ArtboardSession {
  /** The artboard's size from `canvas.json`: the viewport. */
  width: number;
  height: number;
  /** A fresh page on the artboard, past READY_SIGNAL; rejects on a page error. */
  open: () => Promise<OpenArtboard>;
  /** Requests to other origins, aborted so far. */
  blocked: () => string[];
}

export type ArtboardOptions = Omit<RenderOptions, 'out'>;

/**
 * Serve a canvas folder's artboard and hand `use` a session that opens it in
 * headless Chromium, as many times as it likes; everything is torn down after.
 * Every path and file check runs before a browser launches. Throws
 * RuntimeNotCachedError (exit 3) when the canvas's release is not cached.
 */
export const withArtboard = async <T>(
  options: ArtboardOptions,
  use: (session: ArtboardSession) => Promise<T>
): Promise<T> => {
  const canvasDir = path.resolve(options.canvasDir);
  const projectDir = path.join(canvasDir, 'project');
  const log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const scale = options.scale ?? 1;

  const design = readDesignJson(canvasDir);
  const { width, height } = artboardSize(projectDir, options.artboard);
  const manifest = requireRuntime(design);
  const layout = buildLayout(canvasDir, manifest);
  // Torn down however far setup got: a listening server keeps the CLI alive.
  const started: {
    server?: { close: () => Promise<void> };
    browser?: Browser;
  } = {};

  try {
    const server = await serveLayout(layout);
    started.server = server;
    const origin = `http://127.0.0.1:${server.port}`;
    // Appended to from the route handler below.
    const requests: { blocked: string[] } = { blocked: [] };
    const browser = await chromium.launch();
    started.browser = browser;

    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: scale,
    });
    await context.route('**/*', (route) => {
      const url = route.request().url();

      if (
        url.startsWith(`${origin}/`) ||
        ALLOWED_HOSTS.includes(new URL(url).hostname)
      ) {
        return route.continue();
      }

      requests.blocked = [...requests.blocked, url];
      log(`Blocked a request outside the local server: ${url}`);

      return route.abort();
    });

    const artboardPath = options.artboard
      .split('/')
      .map(encodeURIComponent)
      .join('/');

    const open = async (): Promise<OpenArtboard> => {
      const page = await context.newPage();
      const errors: { first: Error | null; reject: (error: Error) => void } = {
        first: null,
        reject: () => {},
      };
      const report = (error: Error): void => {
        errors.first = errors.first ?? error;
        errors.reject(error);
      };
      const pageError = new Promise<never>((_, reject) => {
        errors.reject = reject;
      });
      // Rejections that lose a race below must not surface as unhandled.
      pageError.catch(() => {});

      page.on('pageerror', (error) =>
        report(new Error(`The artboard threw: ${error.message}`))
      );
      // The runtime catches a broken component and logs it instead of throwing.
      page.on('console', (message) => {
        if (
          message.type() === 'error' &&
          /^\[dc(-runtime)?\]/.test(message.text())
        ) {
          report(new Error(`The artboard runtime reported: ${message.text()}`));
        }
      });
      // A script or stylesheet missing from the canvas (a design system that
      // was never installed) leaves its components unmounted without any
      // page error, so a failed load is one. (Not the favicon Chromium asks for.)
      page.on('response', (response) => {
        const request = response.request();

        if (
          response.status() >= 400 &&
          response.url().startsWith(`${origin}/`) &&
          ['script', 'stylesheet'].includes(request.resourceType())
        ) {
          report(
            new Error(
              `The artboard could not load ${
                new URL(response.url()).pathname
              } (${response.status()}): is it on the canvas?`
            )
          );
        }
      });

      const load = loadUntilReady(
        page,
        `${origin}/project/${artboardPath}`,
        readyTimeoutMs
      );
      load.catch(() => {});

      await Promise.race([load, pageError]);

      const check = (): void => {
        if (errors.first !== null) {
          throw errors.first;
        }
      };

      return {
        page,
        check,
        // Bounded like the first load: a stylesheet link that never loads or
        // errors (one with no href) would otherwise hold SETTLED forever.
        settle: async () => {
          const settled = page.evaluate(SETTLED);
          settled.catch(() => {});
          const timeout = rejectAfter(
            new Error(
              `The artboard did not settle within ${readyTimeoutMs} ms after an action.`
            ),
            readyTimeoutMs
          );

          try {
            await Promise.race([settled, pageError, timeout.promise]);
          } finally {
            timeout.cancel();
          }

          check();
        },
      };
    };

    return await use({
      width,
      height,
      open,
      blocked: () => requests.blocked,
    });
  } finally {
    await started.browser?.close();
    await started.server?.close();
    fs.rmSync(layout, { recursive: true, force: true });
  }
};

/**
 * Render one artboard of a canvas folder to `out`. Every path and file check
 * runs before a browser launches. Throws RuntimeNotCachedError (exit 3) when
 * the canvas's release is not cached; any other failure is a plain Error.
 */
export const renderArtboard = (options: RenderOptions): Promise<RenderResult> =>
  withArtboard(options, async ({ width, height, open, blocked }) => {
    const { page } = await open();
    const png = await page.screenshot({
      clip: { x: 0, y: 0, width, height },
      scale: 'device',
    });
    fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    fs.writeFileSync(options.out, png);

    return { out: options.out, width, height, blocked: blocked() };
  });
