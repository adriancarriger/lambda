import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { importRuntime } from '../runtime';

/**
 * A canvas folder and a cached fixture runtime for the real-Chromium design
 * tests (render.test.ts, walk.test.ts). Not a test file: jest only runs
 * `*.test.ts`.
 */

export const RELEASE = 'test-release';

/** A made-up Design type: no real type's id appears in the package. */
export const TYPE_URL = 'https://claude.ai/artifact/TestDesignType1';

/**
 * Stands in for the Design type's `artifact-type/dc-runtime.js` (served to the
 * artboard as `support.js`). Like the real runtime it swaps `<x-dc>` for a
 * painted `#dc-root` — the ready signal `renderArtboard` waits for. It is not
 * Anthropic's runtime. `data-fixture` on `<x-dc>` makes it throw or never paint.
 */
const FIXTURE_SUPPORT_JS = `document.addEventListener('DOMContentLoaded', function () {
  var source = document.querySelector('x-dc');
  var mode = source.getAttribute('data-fixture');
  if (mode === 'throw') throw new Error('fixture runtime exploded');
  if (mode === 'silent') return;
  var root = document.createElement('div');
  root.id = 'dc-root';
  root.innerHTML = source.innerHTML;
  source.replaceWith(root);
});
`;

export const tmp = (prefix: string): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), prefix));

export const writeFile = (file: string, body: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};

export interface ArtboardFixture {
  colour?: string;
  mode?: 'throw' | 'silent';
  extra?: string;
  /** Replaces the default 320×200 coloured block (and `extra`). */
  body?: string;
}

export const artboardHtml = (opts: ArtboardFixture): string =>
  [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<title>Leslie Knope trail map</title>',
    '<script src="./support.js"></script></head><body>',
    `<x-dc data-fixture="${opts.mode ?? 'paint'}">`,
    opts.body ??
      `<div style="width: 320px; height: 200px; background: ${
        opts.colour ?? '#1d4ed8'
      }"></div>${opts.extra ?? ''}`,
    '</x-dc></body></html>',
  ].join('');

export const makeCanvas = (
  opts: ArtboardFixture & {
    release?: string;
    artboard?: string;
    board?: { w: number; h: number };
  }
): string => {
  const dir = tmp('lambda-design-canvas-');
  const artboard = opts.artboard ?? 'Main.dc.html';
  writeFile(
    path.join(dir, 'design.json'),
    JSON.stringify({
      url: 'https://claude.ai/artifact/PawneeParksDesign',
      typeUrl: TYPE_URL,
      release: opts.release ?? RELEASE,
    })
  );
  writeFile(
    path.join(dir, 'project', 'canvas.json'),
    JSON.stringify({
      v: 3,
      title: 'Pawnee Parks',
      boards: {
        [artboard]: { x: 0, y: 0, ...(opts.board ?? { w: 320, h: 200 }) },
      },
      order: [artboard],
    })
  );
  writeFile(path.join(dir, 'project', artboard), artboardHtml(opts));

  return dir;
};

export const pngSize = (file: string): { width: number; height: number } => {
  const bytes = fs.readFileSync(file);

  if (bytes.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error(`${file} is not a PNG.`);
  }

  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

export const quiet = (): void => {};

/** The Error a promise rejects with; fails the test if it resolves or rejects with a non-Error. */
export const rejection = async (promise: Promise<unknown>): Promise<Error> => {
  const outcome = await promise.then(
    () => undefined,
    (e: unknown) => e
  );

  if (!(outcome instanceof Error)) {
    throw new Error(
      `Expected the promise to reject with an Error, got ${String(outcome)}.`
    );
  }

  return outcome;
};

/**
 * Point LAMBDA_PODS_ROOT at a fresh tmp dir and cache the fixture runtime
 * under RELEASE there. Returns the pods root and a restore for afterAll.
 */
export const useFixtureRuntime = (): {
  podsRoot: string;
  restore: () => void;
} => {
  const saved = process.env.LAMBDA_PODS_ROOT;
  const podsRoot = tmp('lambda-design-pods-');
  process.env.LAMBDA_PODS_ROOT = podsRoot;
  const runtime = tmp('lambda-design-runtime-');
  writeFile(
    path.join(runtime, 'artifact-type', 'dc-runtime.js'),
    FIXTURE_SUPPORT_JS
  );
  writeFile(path.join(runtime, 'index.html'), '<!doctype html>');
  importRuntime(runtime, RELEASE, TYPE_URL);

  return {
    podsRoot,
    restore: () => {
      if (saved === undefined) {
        delete process.env.LAMBDA_PODS_ROOT;
      } else {
        process.env.LAMBDA_PODS_ROOT = saved;
      }
    },
  };
};
