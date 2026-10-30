import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const PACKAGE = path.resolve(__dirname, '..', '..', '..');

/**
 * Each top-level screen loads as its own chunk, so the first page load
 * (the sign-in screen, or the shell) doesn't ship them all: the pod screen
 * (PodScreen.tsx), Time, Analytics, Computers and Settings. The signed-in
 * shell around them (App.tsx) is a chunk of its own too.
 */
const SCREENS = [
  'PodScreen.tsx',
  'TimePage.tsx',
  'AnalyticsPage.tsx',
  'ComputersPage.tsx',
  'SettingsPage.tsx',
];

/**
 * Text only the pod screen's code carries: xterm (the terminal), a class
 * only its cards use, and the prototype viewer's own words (Prototypes.tsx:
 * the shell holds only its small context). None may be in the shell's
 * JavaScript.
 */
const POD_ONLY_MARKERS = [
  'xterm-helper-textarea',
  'today-after',
  'As it opens',
];

interface Chunk {
  file: string;
  name?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
}

interface Built {
  manifest: Record<string, Chunk>;
  /** The JavaScript of a chunk and every chunk it imports statically. */
  code: (key: string) => string;
}

jest.setTimeout(120_000);

/** Every module key reached by static imports from a chunk. */
const staticallyReached = (
  manifest: Record<string, Chunk>,
  key: string,
  seen: Set<string> = new Set()
): Set<string> => {
  if (seen.has(key)) {
    return seen;
  }

  seen.add(key);
  (manifest[key]?.imports ?? []).forEach((next) =>
    staticallyReached(manifest, next, seen)
  );

  return seen;
};

/** The package's own vite.config.mts (manifest on), as `pnpm build` runs it. */
const buildClient = (outDir: string): Built => {
  // A child process: Vite's API is ESM, which jest's module sandbox can't load.
  execFileSync(
    process.execPath,
    [
      // Vite's package exports don't list its bin; the CLI's own path.
      path.join(PACKAGE, 'node_modules', 'vite', 'bin', 'vite.js'),
      'build',
      '--config',
      path.join(PACKAGE, 'vite.config.mts'),
      '--outDir',
      outDir,
      '--emptyOutDir',
      '--logLevel',
      'error',
    ],
    { cwd: PACKAGE, stdio: 'pipe' }
  );
  const manifest: Record<string, Chunk> = JSON.parse(
    fs.readFileSync(path.join(outDir, '.vite', 'manifest.json'), 'utf8')
  );

  return {
    manifest,
    code: (key) =>
      [...staticallyReached(manifest, key)]
        .map((reached) => manifest[reached]?.file ?? '')
        .filter((file) => file.endsWith('.js'))
        .map((file) => fs.readFileSync(path.join(outDir, file), 'utf8'))
        .join('\n'),
  };
};

/** A module's chunk: keyed by its source, or by its name when it's shared. */
const chunkOf = (
  manifest: Record<string, Chunk>,
  screen: string
): [string, Chunk] | [] =>
  Object.entries(manifest).find(
    ([key, chunk]) =>
      key === screen || chunk.name === screen.replace(/\.tsx$/, '')
  ) ?? [];

describe('the built client', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-client-'));
  // Built in beforeAll, not at collection: a filtered run (`-t`) skips the
  // build, and a failed build is a failed test rather than a collection error.
  const state: { built?: Built } = {};
  const built = (): Built => {
    if (state.built === undefined) {
      throw new Error('The client was not built.');
    }

    return state.built;
  };
  const keys = () => {
    const { manifest } = built();
    const [entryKey] =
      Object.entries(manifest).find(([, chunk]) => chunk.isEntry === true) ??
      [];
    const [shellKey] = chunkOf(manifest, 'App.tsx');
    const [podKey] = chunkOf(manifest, 'PodScreen.tsx');

    return { manifest, entryKey, shellKey, podKey };
  };

  beforeAll(() => {
    state.built = buildClient(outDir);
  });

  afterAll(() => fs.rmSync(outDir, { recursive: true, force: true }));

  it('splits every screen into its own chunk, none reached from the entry', () => {
    const { manifest, entryKey } = keys();
    expect(entryKey).toBe('index.html');
    const fromEntry = staticallyReached(manifest, entryKey ?? '');

    SCREENS.forEach((screen) => {
      const [key, chunk] = chunkOf(manifest, screen);

      expect({ screen, dynamic: chunk?.isDynamicEntry }).toEqual({
        screen,
        dynamic: true,
      });
      expect({ screen, fromEntry: fromEntry.has(key ?? '') }).toEqual({
        screen,
        fromEntry: false,
      });
    });
  });

  it('keeps the pod screen out of the signed-in shell’s chunk', () => {
    const { manifest, shellKey, podKey } = keys();
    expect(shellKey).toBeDefined();
    expect(podKey).toBeDefined();
    expect(manifest[shellKey ?? '']?.isDynamicEntry).toBe(true);
    expect(manifest[shellKey ?? '']?.dynamicImports ?? []).toContain(podKey);
    expect(staticallyReached(manifest, shellKey ?? '').has(podKey ?? '')).toBe(
      false
    );

    const shell = built().code(shellKey ?? '');
    const pod = built().code(podKey ?? '');

    POD_ONLY_MARKERS.forEach((marker) => {
      expect({ marker, inPodScreen: pod.includes(marker) }).toEqual({
        marker,
        inPodScreen: true,
      });
      expect({ marker, inShell: shell.includes(marker) }).toEqual({
        marker,
        inShell: false,
      });
    });
  });
});
