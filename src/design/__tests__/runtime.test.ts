import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { writeMachineConfig } from '../../config/machineConfig';
import {
  importRuntime,
  parseManifest,
  readManifest,
  runtimeReleaseDir,
  runtimeStatus,
} from '../runtime';
import { TYPE_URL } from './canvasFixture';
import { runDesign } from './runDesign';

const tmp = (prefix: string): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// What an agent's Artifact read leaves in its scratchpad: the type's files at
// their published paths.
const fetchedRuntime = (): string => {
  const dir = tmp('lambda-design-fetched-');
  const write = (rel: string, body: string): void => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  write('index.html', '<!doctype html><title>Design</title>');
  write('artifact-type/dc-runtime.js', 'window.__dcRuntime = true;');
  write('artifact-type/fonts/anthropicons.woff2', 'font');

  return dir;
};

describe('design runtime cache', () => {
  const saved = process.env.LAMBDA_PODS_ROOT;
  const paths: { podsRoot: string } = { podsRoot: '' };

  beforeEach(() => {
    paths.podsRoot = tmp('lambda-design-pods-');
    process.env.LAMBDA_PODS_ROOT = paths.podsRoot;
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.LAMBDA_PODS_ROOT;
    } else {
      process.env.LAMBDA_PODS_ROOT = saved;
    }
  });

  it('imports the fetched files under the pods root with a manifest, and goes missing → ready', () => {
    const release = '1792416507-85b2';
    expect(runtimeStatus(release)).toBe('missing');

    importRuntime(fetchedRuntime(), release, TYPE_URL);

    const dir = path.join(paths.podsRoot, '_design-runtime', release);
    expect(runtimeReleaseDir(release)).toBe(dir);
    expect(
      fs.readFileSync(path.join(dir, 'artifact-type/dc-runtime.js'), 'utf8')
    ).toBe('window.__dcRuntime = true;');

    const manifestFile = path.join(dir, 'manifest.json');
    const manifest = parseManifest(
      fs.readFileSync(manifestFile, 'utf8'),
      manifestFile
    );
    expect(manifest.release).toBe(release);
    expect(manifest.typeUrl).toBe(TYPE_URL);
    expect([...manifest.files].sort()).toEqual([
      'artifact-type/dc-runtime.js',
      'artifact-type/fonts/anthropicons.woff2',
      'index.html',
    ]);
    expect(Number.isNaN(Date.parse(manifest.importedAt))).toBe(false);
    expect(runtimeStatus(release)).toBe('ready');
  });

  it('is incomplete when a file the manifest lists is gone', () => {
    importRuntime(fetchedRuntime(), 'r1', TYPE_URL);
    fs.rmSync(path.join(runtimeReleaseDir('r1'), 'index.html'));

    expect(runtimeStatus('r1')).toBe('incomplete');
  });

  it.each(['../x', 'a/b', 'a b', '..', ''])(
    'refuses release %p and writes nothing',
    (release) => {
      expect(() => importRuntime(fetchedRuntime(), release, TYPE_URL)).toThrow(
        /release/i
      );
      expect(() => runtimeStatus(release)).toThrow(/release/i);
      expect(fs.readdirSync(paths.podsRoot)).toEqual([]);
    }
  );

  it('refuses a folder without the artboard runtime, and writes nothing', () => {
    const dir = fetchedRuntime();
    fs.rmSync(path.join(dir, 'artifact-type/dc-runtime.js'));

    expect(() => importRuntime(dir, 'r2', TYPE_URL)).toThrow(/dc-runtime\.js/);
    expect(fs.readdirSync(paths.podsRoot)).toEqual([]);
  });

  describe('lambda design runtime import', () => {
    const home = { saved: process.env.LAMBDA_HOME, dir: '' };

    beforeEach(() => {
      home.dir = tmp('lambda-design-home-');
      process.env.LAMBDA_HOME = home.dir;
    });

    afterEach(() => {
      if (home.saved === undefined) {
        delete process.env.LAMBDA_HOME;
      } else {
        process.env.LAMBDA_HOME = home.saved;
      }
    });

    it('refuses with no --type-url and no recorded type, caching nothing', async () => {
      const result = await runDesign([
        'runtime',
        'import',
        fetchedRuntime(),
        '--release',
        'r3',
      ]);

      expect(result.code).toBe(1);
      expect(result.err).toContain(
        'No Claude Design type recorded: run the capability check first.'
      );
      expect(fs.readdirSync(paths.podsRoot)).toEqual([]);
    });

    it("records the machine config's design.typeUrl by default", async () => {
      writeMachineConfig({
        design: {
          available: true,
          typeUrl: TYPE_URL,
          checkedAt: '2026-10-20T09:00:00.000Z',
        },
      });
      const result = await runDesign([
        'runtime',
        'import',
        fetchedRuntime(),
        '--release',
        'r4',
      ]);

      expect(result.code).toBe(0);
      expect(readManifest('r4')?.typeUrl).toBe(TYPE_URL);
    });

    it('takes --type-url over the recorded one', async () => {
      const other = 'https://claude.ai/artifact/TestDesignType2';
      const result = await runDesign([
        'runtime',
        'import',
        fetchedRuntime(),
        '--release',
        'r5',
        '--type-url',
        other,
      ]);

      expect(result.code).toBe(0);
      expect(readManifest('r5')?.typeUrl).toBe(other);
    });
  });
});
