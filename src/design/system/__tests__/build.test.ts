import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { registerSystemCommands } from '../../../commands/design/system';
import { resolvePodsRoot } from '../../../config/projectConfig';
import { BUNDLE_JS, INDEX, README } from '../assemble';
import {
  NoDesignSystemError,
  RUNTIME_NOT_CHECKED,
  TAILWIND_NO_CLI,
  TAILWIND_NO_ENTRY,
  buildSystem,
  noComponentsMessage,
  noDesignSystemMessage,
  notInstalledMessage,
  outOverlapsMessage,
  uncommittedMessage,
} from '../build';
import { bundleEntry, noStandInMessage } from '../bundle';
import { buildFromRef, cacheDirOf } from '../cache';
import { loadProjectModule } from '../loadModule';
import {
  PROJECT_ID_FILE,
  notLinkedMessage,
  recordProjectId,
} from '../projectId';
import {
  ANALYTICS,
  DIR,
  type Files,
  INSTALLED,
  MANIFEST,
  NAMESPACE,
  PROJECT_NAME,
  type Repo,
  TAILWIND_CLI,
  catalogText,
  fixtureProjectId,
  indexText,
  listTree,
  makeRepo,
  manifestText,
  parksApp,
  projectAt,
  quiet,
  read,
  rejection,
  repoAt,
  runGit,
  screenFiles,
  sourcesText,
  tmp,
  treeHash,
  useHome,
  useReactRuntime,
  writeFiles,
} from './buildFixture';

// os.homedir() reads the real environment, never jest's copy of process.env:
// make it follow the copy's HOME, as the real one follows the real HOME.
jest.mock('os', () => ({
  ...jest.requireActual<object>('os'),
  homedir: () => process.env.HOME ?? '/',
}));

// Real esbuild, and real Chromium for the screens and the draw check.
jest.setTimeout(120_000);

const outDir = (): string => path.join(tmp('lambda-ds-out-'), 'system');

/**
 * `files` as one package of a workspace: everything under apps/parks, the
 * design system too, so nothing is installed in the root node_modules.
 */
const inWorkspace = (files: Files): Files => ({
  '.gitignore': 'node_modules/\n',
  'package.json': `${JSON.stringify({
    name: 'pawnee',
    private: true,
    workspaces: ['apps/*'],
    dependencies: { react: '18.2.0', 'react-dom': '18.2.0' },
    devDependencies: { tailwindcss: '3.4.0' },
  })}\n`,
  'lambda.json': `${JSON.stringify({
    name: PROJECT_NAME,
    design: { system: { dir: `apps/parks/${DIR}` } },
  })}\n`,
  ...Object.fromEntries(
    Object.entries(files)
      .filter(([rel]) => rel !== '.gitignore' && rel !== 'lambda.json')
      .map(([rel, body]) => [
        `apps/parks/${rel}`,
        // sources.json names files from the checkout: from the root now.
        rel === `${DIR}/sources.json`
          ? body.replace(
              /"((?:\.lambda|src|tailwind)[^"]*)"/g,
              '"apps/parks/$1"'
            )
          : body,
      ])
  ),
});

const build = (
  repo: Repo,
  options: { out?: string; workingTree?: boolean; check?: boolean } = {}
) =>
  buildSystem({
    project: repo.project(),
    projectName: PROJECT_NAME,
    checkout: repo.root,
    out: options.out ?? outDir(),
    workingTree: options.workingTree,
    check: options.check,
    log: quiet,
  });

const indexJson = (out: string): Record<string, unknown> =>
  JSON.parse(read(out, INDEX));

const bundleNames = (out: string): unknown => {
  const header = /^\/\* @ds-bundle: (\{.*\}) \*\/$/.exec(
    read(out, BUNDLE_JS).split('\n', 1)[0] ?? ''
  );

  return header === null ? null : JSON.parse(header[1] ?? '{}').components;
};

const MAP_VIEW = {
  'src/components/MapView.tsx': [
    "import { init } from 'mixpanel-browser/lib';",
    '',
    'export const MapView = ({ name }: { name: string }) => {',
    '  const app = init();',
    '',
    '  return <div className="map-view">{name} on the {app.name} map</div>;',
    '};',
    '',
  ].join('\n'),
};

const runtime = { restore: () => {} };

beforeAll(() => {
  runtime.restore = useReactRuntime().restore;
});

afterAll(() => {
  runtime.restore();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('a deterministic build', () => {
  it('gives byte-identical files for one commit, whatever the zone, home or clock', async () => {
    const repo = makeRepo({
      ...parksApp(),
      ...screenFiles([
        { file: 'ParkMap.dc.html', title: 'Park map', clicks: ['open-park'] },
      ]),
    });
    repo.commit('Pawnee parks map design system', '2026-09-01T09:00:00-05:00');
    repo.write({
      'src/components/ParkCard.css':
        '.park-card { padding: 16px; border-radius: 8px; background: #2f855a; color: #ffffff; }\n',
    });
    const sha = repo.commit('Roomier park cards', '2026-10-01T09:00:00-05:00');

    const first = outDir();
    await build(repo, { out: first });

    const saved = { tz: process.env.TZ };
    const home = useHome();
    // TZ reaches the git and esbuild child processes (jest's process.env is
    // what they are spawned with). Fake timers move Node's own Date a day on;
    // they can't reach child processes, but git's dates come from the commit
    // anyway. Every timer stays real, for Chromium.
    process.env.TZ = 'Pacific/Auckland';
    const tomorrow = Date.now() + 24 * 60 * 60 * 1000;
    jest.useFakeTimers({
      now: tomorrow,
      advanceTimers: true,
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    const second = outDir();

    try {
      expect(new Date().getTime()).toBeGreaterThanOrEqual(tomorrow);
      await build(repo, { out: second });
    } finally {
      jest.useRealTimers();
      home.restore();

      if (saved.tz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = saved.tz;
      }
    }

    const files = listTree(first);
    expect(listTree(second)).toEqual(files);
    expect(files).toEqual(
      expect.arrayContaining([
        'project/README.md',
        'project/tokens.json',
        'project/sample-data.js',
        'project/Screens.md',
        'project/screens/ParkMap.dc.html',
        'project/components/bundle.js',
        'project/components/bundle.css',
        'project/components/index.d.ts',
        'project/components/ParkCard/README.md',
        'project/components/ParkCard/preview.html',
        'project/components/Cover/preview.html',
        'project/design-system.json',
      ])
    );
    files
      .filter((file) => file !== 'project/Screens.md')
      .forEach((file) =>
        expect([file, fs.readFileSync(path.join(second, file))]).toEqual([
          file,
          fs.readFileSync(path.join(first, file)),
        ])
      );

    const unwanted = [
      repo.root,
      repo.root.replace(/^\/private/, ''),
      os.hostname(),
    ];
    [first, second].forEach((out) =>
      files.forEach((file) => {
        const body = read(out, file);
        unwanted.forEach((text) =>
          expect([file, body.includes(text)]).toEqual([file, false])
        );
      })
    );

    const index = indexJson(first);
    expect(index).toMatchObject({
      lastChange: {
        by: 'lambda',
        at: runGit(repo.root, ['show', '-s', '--format=%cI', sha]),
        via: `lambda design system · v3 · ${sha.slice(0, 7)}`,
      },
      createdOnFiles: { at: '2026-09-01T09:00:00-05:00' },
    });
    expect(index.lastChange).toMatchObject({ at: '2026-10-01T09:00:00-05:00' });
    expect(JSON.parse(read(first, 'project/tokens.json'))).toMatchObject({
      meta: { ref: sha.slice(0, 7), source: 'tailwind' },
    });
  });
});

describe('build refusals and modes', () => {
  const fixture: { repo?: Repo; source?: string } = {};

  beforeAll(() => {
    const repo = makeRepo(parksApp());
    repo.commit('Pawnee parks map design system');
    fixture.repo = repo;
    fixture.source = treeHash(path.join(repo.root, DIR));
  });

  const repoOf = (): Repo => {
    if (fixture.repo === undefined) {
      throw new Error('The fixture repo was not made.');
    }

    return fixture.repo;
  };

  afterAll(() => {
    // No build wrote inside the design system's folder.
    const repo = repoOf();
    repo.git(['checkout', '--', DIR]);
    expect(treeHash(path.join(repo.root, DIR))).toBe(fixture.source);
    expect(fs.existsSync(path.join(repo.root, DIR, 'tokens.json'))).toBe(false);
  });

  it.each([
    ['the design system folder itself', DIR],
    ['a folder inside it', `${DIR}/built`],
    ['a folder holding it', '.lambda'],
    ['the checkout', '.'],
  ])('refuses --out at %s, deleting nothing', async (_label, rel) => {
    const repo = repoOf();
    const out = path.join(repo.root, rel);
    const before = treeHash(repo.root);

    const error = await rejection(build(repo, { out }));

    expect(error.message).toBe(outOverlapsMessage(out, DIR));
    expect(treeHash(repo.root)).toBe(before);
  });

  it('builds the committed design system into the default gitignored folder', async () => {
    const repo = repoOf();
    const out = path.join(repo.root, '.lambda', 'design', 'system');
    const result = await build(repo, { out });

    expect(result.problems).toEqual([]);
    expect(fs.existsSync(path.join(out, BUNDLE_JS))).toBe(true);
    expect(repo.git(['status', '--porcelain'])).toBe('');
  });

  describe('with an uncommitted edit to catalog.ts', () => {
    beforeAll(() => {
      repoOf().write({
        [`${DIR}/catalog.ts`]: catalogText([
          {
            name: 'ParkCard',
            summary: 'One park, as Ron Swanson would have it.',
          },
        ]),
      });
    });

    afterAll(() => {
      repoOf().git(['checkout', '--', DIR]);
    });

    it('refuses a plain build, writing nothing', async () => {
      const out = outDir();
      const error = await rejection(build(repoOf(), { out }));

      expect(error.message).toBe(
        'The design system in .lambda/design-system has uncommitted changes. Designs use it as committed; commit or drop them first.'
      );
      expect(error.message).toBe(uncommittedMessage(DIR));
      expect(fs.existsSync(out)).toBe(false);
    });

    it('builds the working tree with --working-tree, the edit included', async () => {
      const out = outDir();
      await build(repoOf(), { out, workingTree: true });

      expect(read(out, 'project/components/ParkCard/README.md')).toContain(
        'One park, as Ron Swanson would have it.'
      );
    });

    it('builds the working tree with --check too, and the checks pass', async () => {
      const out = outDir();
      const result = await build(repoOf(), { out, check: true });

      expect(result.problems).toEqual([]);
      expect(read(out, 'project/components/ParkCard/README.md')).toContain(
        'One park, as Ron Swanson would have it.'
      );
      expect(
        listTree(
          path.join(
            repoOf().root,
            '.lambda',
            'design',
            '_system-check',
            'canvas'
          )
        )
      ).toContain(path.join('project', '_draw-ParkCard.dc.html'));
    });
  });

  it('refuses a project with no manifest', async () => {
    const repo = makeRepo(parksApp());
    repo.remove(MANIFEST);
    repo.commit('An app with no design system yet');
    const error = await rejection(build(repo));

    expect(error).toBeInstanceOf(NoDesignSystemError);
    expect(error.message).toBe(
      'This project has no design system yet (.lambda/design-system/design-system.json).'
    );
    expect(error.message).toBe(noDesignSystemMessage(MANIFEST));
  });

  // The setup ticket builds before its manifest exists: step 7 writes it.
  it("builds the working tree with no manifest yet, under the project name's namespace", async () => {
    const repo = makeRepo(parksApp());
    repo.remove(MANIFEST);
    repo.commit('An app with no design system yet');
    const out = outDir();

    const result = await build(repo, { out, workingTree: true });

    expect(result.problems).toEqual([]);
    expect(indexJson(out)).toMatchObject({ namespace: NAMESPACE });
    expect(bundleNames(out)).toEqual([{ name: 'ParkCard' }]);
  });

  it('refuses a component importing next/head, naming the file', async () => {
    const repo = makeRepo({
      ...parksApp(),
      'src/components/ParkHead.tsx': [
        "import Head from 'next/head';",
        '',
        'export const ParkHead = ({ name }: { name: string }) => <Head><title>{name}</title></Head>;',
        '',
      ].join('\n'),
      [`${DIR}/index.tsx`]: indexText({
        ParkCard: '../../src/components/ParkCard',
        ParkHead: '../../src/components/ParkHead',
      }),
    });
    repo.commit('A park page head');
    const out = outDir();
    const error = await rejection(build(repo, { out }));

    expect(error.message).toBe(
      'src/components/ParkHead.tsx imports next/head, which the design system has no stand-in for. Copy the piece as a pattern, or leave it out with design.systemBuild.exclude.'
    );
    expect(error.message).toBe(
      noStandInMessage('src/components/ParkHead.tsx', 'next/head')
    );
    expect(fs.existsSync(out)).toBe(false);
  });

  it('uses the next/link, next/image, next/navigation and next/router stand-ins', async () => {
    const repo = makeRepo({
      ...parksApp(),
      'src/components/ParkLink.tsx': [
        "import Link from 'next/link';",
        "import Image from 'next/image';",
        "import { usePathname } from 'next/navigation';",
        "import { useRouter } from 'next/router';",
        '',
        'export const ParkLink = ({ name }: { name: string }) => {',
        '  const path = usePathname();',
        '  const router = useRouter();',
        '',
        '  return <Link href={`${path}/${router.route}`}><Image src="/bench.png" alt={name} />{name}</Link>;',
        '};',
        '',
      ].join('\n'),
      [`${DIR}/index.tsx`]: indexText({
        ParkCard: '../../src/components/ParkCard',
        ParkLink: '../../src/components/ParkLink',
      }),
    });
    repo.commit('Park links');
    const out = outDir();
    await build(repo, { out });

    expect(read(out, BUNDLE_JS)).not.toContain('next/');
  });
});

describe("the Tailwind compile, with the project's own CLI", () => {
  // Stands in for the project's installed Tailwind CLI: it records how it
  // was called (and its --input's text), and writes a known stylesheet.
  const FAKE_CLI = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const at = (flag) => args[args.indexOf(flag) + 1];
const record = path.join(process.cwd(), 'tailwind-calls.json');
const calls = fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf8')) : [];
calls.push({ args, input: fs.readFileSync(at('--input'), 'utf8') });
fs.writeFileSync(record, JSON.stringify(calls));
fs.writeFileSync(at('--output'), '.park-green{color:#2f6b3a}');
`;

  const withCli = (version: string, files: Files = {}): Repo => {
    const repo = makeRepo({
      ...parksApp(),
      'node_modules/.bin/tailwindcss': FAKE_CLI,
      'node_modules/tailwindcss/package.json': JSON.stringify({
        name: 'tailwindcss',
        version,
      }),
      ...files,
    });
    fs.chmodSync(path.join(repo.root, 'node_modules/.bin/tailwindcss'), 0o755);
    repo.commit('Pawnee parks map design system');

    return repo;
  };

  const calls = (repo: Repo): { args: string[]; input: string }[] =>
    JSON.parse(read(repo.root, 'tailwind-calls.json'));

  it('v3: compiles bundle.css with every bundle input in one --content', async () => {
    const repo = withCli('3.4.17');
    const out = outDir();

    await build(repo, { out });

    const [call] = calls(repo);
    const flags = call?.args.filter((arg) => arg === '--content') ?? [];
    const content =
      call?.args[call.args.indexOf('--content') + 1]?.split(',') ?? [];

    expect(flags).toHaveLength(1);
    expect(
      content.some((file) => file.endsWith('src/components/ParkCard.tsx'))
    ).toBe(true);
    expect(content.some((file) => file.endsWith(`${DIR}/index.tsx`))).toBe(
      true
    );
    expect(content.some((file) => file.includes('node_modules'))).toBe(false);
    expect(call?.input).toContain('@tailwind');
    expect(read(out, 'project/components/bundle.css')).toBe(
      '.park-green{color:#2f6b3a}'
    );
  });

  it('v4: has no --content; the entry is imported and every input is an @source', async () => {
    const repo = withCli('4.1.11');
    const out = outDir();

    await build(repo, { out });

    const [call] = calls(repo);

    expect(call?.args).not.toContain('--content');
    expect(call?.input).toContain(
      `@import "${path.join(repo.root, 'src/app/globals.css')}";`
    );
    expect(call?.input).toContain(
      `@source "${path.join(repo.root, 'src/components/ParkCard.tsx')}";`
    );
    expect(read(out, 'project/components/bundle.css')).toBe(
      '.park-green{color:#2f6b3a}'
    );
  });

  it("finds the CLI in the CSS entry's workspace package", async () => {
    const repo = makeRepo({
      ...inWorkspace({
        ...parksApp(),
        'node_modules/.bin/tailwindcss': FAKE_CLI,
        'node_modules/tailwindcss/package.json': JSON.stringify({
          name: 'tailwindcss',
          version: '3.4.17',
        }),
      }),
      // React at the root too: only the CLI's place is under test.
      ...INSTALLED,
    });
    fs.chmodSync(
      path.join(repo.root, 'apps/parks/node_modules/.bin/tailwindcss'),
      0o755
    );
    repo.commit('Pawnee parks map design system, in a workspace');
    const out = outDir();

    await build(repo, { out });

    expect(read(out, 'project/components/bundle.css')).toBe(
      '.park-green{color:#2f6b3a}'
    );
  });

  it('refuses to guess when no theme file is the CSS entry, writing nothing', async () => {
    const repo = withCli('3.4.17', {
      'src/app/globals.css': 'body { margin: 0; }\n',
    });
    const out = outDir();

    const error = await rejection(build(repo, { out }));

    expect(error.message).toBe(TAILWIND_NO_ENTRY);
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe('the source map check in --check', () => {
  it('names a pattern copy the source map has no entry for', async () => {
    const repo = makeRepo({
      ...parksApp(),
      [`${DIR}/patterns/BenchRow.tsx`]:
        '// A copy of the bench rows on the park page.\nexport const BenchRow = () => null;\n',
    });
    repo.commit('Pawnee parks map design system, a bench row copy');

    const result = await build(repo, { out: outDir(), check: true });

    expect(result.problems).toContain(
      'patterns/BenchRow.tsx has no entry in sources.json patterns.'
    );
  });
});

describe('no components', () => {
  it('builds the look only when the catalog lists no components, though index.tsx is there', async () => {
    const repo = makeRepo({
      ...parksApp(),
      [`${DIR}/catalog.ts`]: catalogText([]),
    });
    repo.commit('Pawnee parks map design system');
    const out = outDir();
    const result = await build(repo, { out });

    expect(fs.existsSync(path.join(repo.root, DIR, 'index.tsx'))).toBe(true);
    expect(result.notes).toEqual([noComponentsMessage(DIR)]);
    expect(read(out, README)).toContain(
      `## Components\n\n${noComponentsMessage(DIR)}\n`
    );
    expect(fs.existsSync(path.join(out, 'project', 'components'))).toBe(false);
  });

  it('refuses a catalog of components with no index.tsx, writing nothing', async () => {
    const repo = makeRepo(parksApp());
    repo.remove(`${DIR}/index.tsx`);
    repo.commit('Pawnee parks map design system, no entry');
    const out = outDir();

    const error = await rejection(build(repo, { out }));

    expect(error.message).toMatch(
      /^\.lambda\/design-system\/index\.tsx doesn't exist, but \.lambda\/design-system\/catalog\.ts lists \d+ components?: the bundle has no entry\.$/
    );
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe('look only', () => {
  it("bundles when react is installed only in the design system's workspace package", async () => {
    const repo = makeRepo({ ...inWorkspace(parksApp()), ...TAILWIND_CLI });
    repo.commit('Pawnee parks map design system, in a workspace');
    const out = outDir();
    const result = await build(repo, { out });

    expect(result.notes).toEqual([]);
    expect(bundleNames(out)).toEqual([{ name: 'ParkCard' }]);
  });

  describe("a workspace package's own tsconfig paths", () => {
    /** A root tsconfig with no paths; apps/parks maps `@/*` to its src. */
    const withPaths = (): Repo => {
      const repo = makeRepo({
        ...inWorkspace({
          ...parksApp(),
          'tsconfig.json': `${JSON.stringify({
            compilerOptions: { jsx: 'preserve', paths: { '@/*': ['./src/*'] } },
          })}\n`,
          'src/lib/parkNames.ts': "export const first = 'Pawnee Commons';\n",
          'src/lib/benches.ts':
            "import { first } from '@/lib/parkNames';\n\nexport const bench = `${first} bench`;\n",
          'src/components/ParkCard.tsx': [
            "import { first } from '@/lib/parkNames';",
            '',
            'export const ParkCard = ({ name }: { name?: string }) => (',
            '  <div className="park-card">{name ?? first}</div>',
            ');',
            '',
          ].join('\n'),
        }),
        'tsconfig.json': `${JSON.stringify({
          compilerOptions: { strict: true },
        })}\n`,
        ...TAILWIND_CLI,
      });
      dirs.splice(dirs.length, 0, repo.root);
      repo.commit('Pawnee parks map, @/ imports in a workspace');

      return repo;
    };
    const dirs: string[] = [];

    afterEach(() => {
      dirs
        .splice(0)
        .forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
    });

    it('bundles a component importing @/lib through them', async () => {
      const out = outDir();
      dirs.splice(dirs.length, 0, path.dirname(out));
      const result = await build(withPaths(), { out });

      expect(result.notes).toEqual([]);
      expect(read(out, BUNDLE_JS)).toContain('Pawnee Commons');
    });

    it('loads a project module importing @/lib through them', async () => {
      const repo = withPaths();

      await expect(
        loadProjectModule(repo.root, 'apps/parks/src/lib/benches.ts')
      ).resolves.toEqual({ bench: 'Pawnee Commons bench' });
    });
  });

  it('writes the tokens and the README line when the packages are not installed', async () => {
    const repo = makeRepo(parksApp({ installed: false }));
    repo.commit('Pawnee parks map design system');
    const out = outDir();
    const result = await build(repo, { out });
    const line = notInstalledMessage(PROJECT_NAME);

    expect(line).toBe(
      "Pawnee parks map's packages aren't installed, so Lambda can't bundle its components. The design system has the look only."
    );
    expect(result.notes).toEqual([line]);
    expect(read(out, README)).toContain(`## Components\n\n${line}\n`);
    // The output names the project, never a path on this computer.
    listTree(out).forEach((rel) => {
      const body = read(out, rel);

      expect(body).not.toContain(repo.root);
      expect(body).not.toContain(fs.realpathSync(repo.root));
      expect(body).not.toContain(os.homedir());
    });
    expect(JSON.parse(read(out, 'project/tokens.json'))).toMatchObject({
      color: {
        tokens: expect.arrayContaining([
          expect.objectContaining({ name: 'park-green' }),
        ]),
      },
    });
    expect(fs.existsSync(path.join(out, 'project', 'components'))).toBe(false);
    expect(fs.existsSync(path.join(out, 'project', 'sample-data.js'))).toBe(
      false
    );
  });
});

describe('the app runtime check', () => {
  const firstState = (): Files => ({
    ...parksApp(),
    ...ANALYTICS,
    ...MAP_VIEW,
    [`${DIR}/index.tsx`]: indexText({
      ParkCard: '../../src/components/ParkCard',
      MapView: '../../src/components/MapView',
    }),
    [`${DIR}/catalog.ts`]: catalogText([
      { name: 'ParkCard' },
      { name: 'MapView' },
    ]),
    [`${DIR}/sources.json`]: sourcesText({
      components: {
        ParkCard: 'src/components/ParkCard.tsx',
        MapView: 'src/components/MapView.tsx',
      },
    }),
  });

  it('names a component that loads mixpanel-browser, until it becomes a pattern copy', async () => {
    const repo = makeRepo(firstState());
    repo.commit('The park map');
    const source = treeHash(path.join(repo.root, DIR));

    const checked = await build(repo, { check: true });
    expect(checked.problems).toEqual(['MapView loads mixpanel-browser.']);
    expect(treeHash(path.join(repo.root, DIR))).toBe(source);

    // A plain build of the same state drops nothing.
    const plain = outDir();
    await build(repo, { out: plain });
    expect(bundleNames(plain)).toEqual([
      { name: 'ParkCard' },
      { name: 'MapView' },
    ]);

    repo.write({
      [`${DIR}/patterns/MapView.tsx`]: [
        'export const MapView = ({ name }: { name: string }) => (',
        '  <div className="map-view">{name} on the park map</div>',
        ');',
        '',
      ].join('\n'),
      [`${DIR}/index.tsx`]: indexText({
        ParkCard: '../../src/components/ParkCard',
        MapView: './patterns/MapView',
      }),
      [`${DIR}/sources.json`]: sourcesText({
        components: { ParkCard: 'src/components/ParkCard.tsx' },
        patterns: { 'MapView.tsx': ['src/components/MapView.tsx'] },
      }),
    });
    const fixedOut = outDir();
    const fixed = await build(repo, { out: fixedOut, check: true });

    expect(fixed.problems).toEqual([]);
    expect(bundleNames(fixedOut)).toEqual([
      { name: 'ParkCard' },
      { name: 'MapView' },
    ]);
    expect(read(fixedOut, README)).toContain(
      '- `patterns/MapView.tsx` copies `src/components/MapView.tsx`'
    );
    const { metafile } = await bundleEntry({
      checkout: repo.root,
      entry: `${DIR}/index.tsx`,
      namespace: NAMESPACE,
      components: ['ParkCard', 'MapView'],
      exclude: [],
    });
    expect(
      Object.keys(metafile.inputs).filter((input) =>
        input.includes('node_modules/mixpanel-browser/')
      )
    ).toEqual([]);
  });

  it('names a component that loads an excluded file', async () => {
    const repo = makeRepo({
      ...firstState(),
      'lambda.json': `${JSON.stringify({
        name: PROJECT_NAME,
        design: { systemBuild: { exclude: ['src/components/MapView.tsx'] } },
      })}\n`,
    });
    repo.commit('The park map, excluded');
    const result = await build(repo, { check: true });

    expect(result.problems).toContain(
      'MapView loads src/components/MapView.tsx.'
    );
  });
});

/** A project build script: writes a built folder to {out}, counting its calls. */
const BUILD_SCRIPT = `const fs = require('fs');
const path = require('path');
const [out, record, mode] = process.argv.slice(2);
const prior = fs.existsSync(record)
  ? JSON.parse(fs.readFileSync(record, 'utf8'))
  : { calls: 0, cwd: [] };
fs.writeFileSync(record, JSON.stringify({ calls: prior.calls + 1, cwd: prior.cwd.concat([process.cwd()]) }));
if (mode === 'fail') {
  console.log('Building the Pawnee parks map');
  console.error('Ron Swanson unplugged the build');
  process.exit(2);
}
// 'otherns': a whole bundle, and its index, under a namespace the manifest doesn't name.
const ns = mode === 'otherns' ? 'Parks' : '${NAMESPACE}';
const header = '/* @ds-bundle: ' + JSON.stringify({ format: 4, namespace: ns, components: [{ name: 'ParkCard' }] }) + ' */';
const js = (mode === 'bad' ? '' : header + '\\n') +
  '(function(){var h=window.React.createElement;window.' + ns + '={Root:function(p){return h("div",{className:"pawnee-root"},p.children)},ParkCard:function(p){return h("div",{className:"park-card"},p.name)}};})();\\n' +
  (mode === 'big' ? '/*' + 'x'.repeat(2200000) + '*/\\n' : '');
const files = {
  'project/design-system.json': JSON.stringify({ v: 3, namespace: ns, title: '${PROJECT_NAME}' }),
  'project/README.md': '# ${PROJECT_NAME}\\n',
  'project/tokens.json': '{}\\n',
  'project/components/bundle.js': js,
  'project/components/bundle.css': '.park-card{padding:12px}\\n',
};
if (mode === 'metafile') {
  files['metafile.json'] = JSON.stringify({
    inputs: {
      '${DIR}/index.tsx': { imports: [
        { path: 'src/components/ParkCard.tsx', original: '../../src/components/ParkCard' },
        { path: 'src/components/MapView.tsx', original: '../../src/components/MapView' },
      ] },
      'src/components/ParkCard.tsx': { imports: [] },
      'src/components/MapView.tsx': { imports: [{ path: 'node_modules/mixpanel-browser/lib/index.js', original: 'mixpanel-browser/lib' }] },
      'node_modules/mixpanel-browser/lib/index.js': { imports: [] },
    },
  });
}
Object.keys(files).forEach((rel) => {
  const file = path.join(out, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, files[rel]);
});
`;

interface Calls {
  calls: number;
  cwd: string[];
}

describe('design.system.build', () => {
  const ownBuild = (record: string, mode: string): Files => ({
    ...parksApp(),
    ...MAP_VIEW,
    'scripts/build-design-system.js': BUILD_SCRIPT,
    [`${DIR}/index.tsx`]: indexText({
      ParkCard: '../../src/components/ParkCard',
      MapView: '../../src/components/MapView',
    }),
    [`${DIR}/sources.json`]: sourcesText({
      components: {
        ParkCard: 'src/components/ParkCard.tsx',
        MapView: 'src/components/MapView.tsx',
      },
    }),
    'lambda.json': `${JSON.stringify({
      name: PROJECT_NAME,
      design: {
        system: {
          build: `node scripts/build-design-system.js {out} ${record} ${mode}`,
        },
      },
    })}\n`,
  });

  const calls = (record: string): Calls =>
    JSON.parse(fs.readFileSync(record, 'utf8'));

  const recordFile = (): string =>
    path.join(tmp('lambda-ds-record-'), 'calls.json');

  it("keeps the project's own output once it passes the bundle rules", async () => {
    const record = recordFile();
    const repo = makeRepo(ownBuild(record, 'ok'));
    repo.commit('Our own design system build');
    const out = outDir();
    const result = await build(repo, { out });

    expect(result).toEqual({ out, warnings: [], problems: [], notes: [] });
    expect(read(out, BUNDLE_JS).startsWith('/* @ds-bundle: ')).toBe(true);
    expect(calls(record)).toEqual({ calls: 1, cwd: [repo.root] });
    expect(fs.readdirSync(path.dirname(out))).toEqual(['system']);
  });

  it('hands the script an {out} holding a space and a quote, intact', async () => {
    const record = recordFile();
    const repo = makeRepo(ownBuild(record, 'ok'));
    repo.commit('Our own design system build');
    const parent = tmp('lambda-ds-out-');
    const out = path.join(parent, "Knope's system");
    await build(repo, { out });

    // A split or mangled path would have been written somewhere else.
    expect(calls(record).calls).toBe(1);
    expect(fs.readdirSync(parent)).toEqual(["Knope's system"]);
    expect(read(out, BUNDLE_JS).startsWith('/* @ds-bundle: ')).toBe(true);
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('refuses output that breaks a bundle rule, keeping nothing', async () => {
    const repo = makeRepo(ownBuild(recordFile(), 'bad'));
    repo.commit('A build with no header');
    const out = outDir();
    const error = await rejection(build(repo, { out }));

    expect(error.message).toContain('Bundle rule "header"');
    expect(fs.readdirSync(path.dirname(out))).toEqual([]);
  });

  it('refuses a plain build outside a git checkout, rather than skip the uncommitted check', async () => {
    const record = recordFile();
    const root = tmp('lambda-ds-nogit-');
    writeFiles(root, ownBuild(record, 'ok'));
    const out = outDir();

    const error = await rejection(
      buildSystem({
        project: projectAt(root),
        projectName: PROJECT_NAME,
        checkout: root,
        out,
        log: quiet,
      })
    );

    expect(error.message).toContain('not a git repository');
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.existsSync(record)).toBe(false);
  });

  it("refuses output under a namespace the manifest doesn't name, keeping nothing", async () => {
    const repo = makeRepo(ownBuild(recordFile(), 'otherns'));
    repo.commit('A build under another namespace');
    const out = outDir();
    const error = await rejection(build(repo, { out }));

    expect(error.message).toBe(
      `Bundle rule "header": the @ds-bundle header must name namespace ${NAMESPACE}.`
    );
    expect(fs.readdirSync(path.dirname(out))).toEqual([]);
  });

  it('warns about a bundle over 2 MB', async () => {
    const repo = makeRepo(ownBuild(recordFile(), 'big'));
    repo.commit('A big design system build');
    const result = await build(repo);

    expect(result.warnings).toEqual([expect.stringContaining('MB')]);
  });

  it('fails with the exact message when the command fails', async () => {
    const repo = makeRepo(ownBuild(recordFile(), 'fail'));
    repo.commit('A build that fails');
    const out = outDir();
    const error = await rejection(build(repo, { out }));

    expect(error.message).toBe(
      "The project's design system build (design.system.build) failed: Ron Swanson unplugged the build."
    );
    expect(fs.readdirSync(path.dirname(out))).toEqual([]);
  });

  it('with --check and no metafile, says the app runtime is not checked and still draws', async () => {
    const repo = makeRepo(ownBuild(recordFile(), 'ok'));
    repo.commit('Our own design system build');
    const result = await build(repo, { check: true });

    expect(result.notes).toEqual([RUNTIME_NOT_CHECKED]);
    expect(RUNTIME_NOT_CHECKED).toBe(
      "App runtime not checked: the project's own build (design.system.build) made the bundle."
    );
    expect(result.problems).toEqual([]);
    expect(
      listTree(
        path.join(repo.root, '.lambda', 'design', '_system-check', 'canvas')
      )
    ).toContain(path.join('project', '_draw-ParkCard.dc.html'));
  });

  it('with --check and a metafile naming mixpanel-browser, names the component', async () => {
    const repo = makeRepo(ownBuild(recordFile(), 'metafile'));
    repo.commit('Our own design system build, with a metafile');
    const result = await build(repo, { check: true });

    expect(result.notes).toEqual([]);
    expect(result.problems).toEqual(['MapView loads mixpanel-browser.']);
  });
});

describe('--from <ref>', () => {
  const homes: { restore: () => void }[] = [];

  afterEach(() => {
    homes.splice(0).forEach((home) => home.restore());
  });

  /** An origin with main at v3, cloned; the clone on another branch with an uncommitted v5. */
  const cloned = (
    files: Files,
    { installed = true }: { installed?: boolean } = {}
  ): { upstream: Repo; clone: Repo; main: string } => {
    const upstream = makeRepo(files, 'lambda-ds-origin-');
    const main = upstream.commit('Pawnee parks map design system');
    const root = path.join(tmp('lambda-ds-clone-'), 'pawnee-parks-map');
    runGit(path.dirname(root), ['clone', '-q', upstream.root, root]);
    const clone = repoAt(root);
    clone.git(['config', 'user.name', 'Leslie Knope']);
    clone.git(['config', 'user.email', 'leslie@pawnee.example']);

    if (installed) {
      writeFiles(root, { ...INSTALLED, ...TAILWIND_CLI });
    }

    clone.git(['checkout', '-q', '-b', 'bench-hours']);
    clone.write({ [MANIFEST]: manifestText(5) });

    return { upstream, clone, main };
  };

  it("keys the cache on Lambda's project id, never the folder's path", async () => {
    const home = useHome();
    homes.splice(homes.length, 0, home);
    const { clone, main } = cloned(parksApp());
    const project = projectAt(clone.root);
    recordProjectId(project, 'prj_pawneeparks7');

    const { folder } = await buildFromRef({
      project,
      projectName: PROJECT_NAME,
      ref: 'main',
      log: quiet,
    });

    expect(folder).toBe(
      path.join(
        home.home,
        '.lambda',
        'cache',
        'design-system',
        'prj_pawneeparks7',
        main
      )
    );
    expect(
      fs.readdirSync(path.join(home.home, '.lambda', 'cache', 'design-system'))
    ).toEqual(['prj_pawneeparks7']);
  });

  it('refuses a project this computer never linked, building nothing', async () => {
    const home = useHome();
    homes.splice(homes.length, 0, home);
    const { clone } = cloned(parksApp());
    const project = projectAt(clone.root);
    fs.rmSync(path.join(resolvePodsRoot(project), PROJECT_ID_FILE));

    const error = await rejection(
      buildFromRef({
        project,
        projectName: PROJECT_NAME,
        ref: 'main',
        log: quiet,
      })
    );

    expect(error.message).toBe(notLinkedMessage(PROJECT_NAME));
    expect(fs.existsSync(path.join(home.home, '.lambda', 'cache'))).toBe(false);
  });

  it('waits for another build of the project, then fails naming it, building nothing', async () => {
    const home = useHome();
    homes.splice(homes.length, 0, home);
    const { clone, main } = cloned(parksApp());
    const project = projectAt(clone.root);
    const base = cacheDirOf(project, PROJECT_NAME);
    fs.mkdirSync(base, { recursive: true });
    // Held by a live process: this one.
    fs.writeFileSync(path.join(base, 'checkout.lock'), String(process.pid));
    const started = Date.now();

    const error = await rejection(
      buildFromRef({
        project,
        projectName: PROJECT_NAME,
        ref: 'main',
        waitMs: 300,
        log: quiet,
      })
    );

    expect(error.message).toBe(
      'Another design system build is running for Pawnee parks map.'
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(fs.existsSync(path.join(base, main))).toBe(false);
    expect(fs.existsSync(path.join(base, 'checkout'))).toBe(false);
  });

  it("builds main in Lambda's build checkout, never the project's, and reuses the folder", async () => {
    const home = useHome();
    homes.splice(homes.length, 0, home);
    const { clone, main } = cloned(parksApp());
    const project = projectAt(clone.root);
    const base = path.join(
      home.home,
      '.lambda',
      'cache',
      'design-system',
      fixtureProjectId(clone.root)
    );

    const first = await buildFromRef({
      project,
      projectName: PROJECT_NAME,
      ref: 'main',
      log: quiet,
    });

    expect(cacheDirOf(projectAt(clone.root), PROJECT_NAME)).toBe(base);
    expect(first.folder).toBe(path.join(base, main));
    expect(first.built).toBe(true);
    const index = indexJson(first.folder);
    expect(index.lastChange).toMatchObject({
      via: `lambda design system · v3 · ${main.slice(0, 7)}`,
    });
    // The bundle was built through the build checkout's symlinked packages.
    expect(fs.existsSync(path.join(first.folder, BUNDLE_JS))).toBe(true);
    const checkout = path.join(base, 'checkout');
    expect(
      fs.lstatSync(path.join(checkout, 'node_modules')).isSymbolicLink()
    ).toBe(true);
    expect(fs.readlinkSync(path.join(checkout, 'node_modules'))).toBe(
      path.join(clone.root, 'node_modules')
    );
    expect(runGit(checkout, ['rev-parse', 'HEAD'])).toBe(main);
    // The project's checkout is as it was: its branch, its edit.
    expect(clone.git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(
      'bench-hours'
    );
    expect(clone.git(['status', '--porcelain'])).toBe(`M ${MANIFEST}`);
    expect(read(clone.root, MANIFEST)).toBe(manifestText(5));
    expect(fs.existsSync(path.join(clone.root, '.lambda', 'design'))).toBe(
      false
    );
    expect(
      fs.readdirSync(base).filter((name) => name.includes('.building'))
    ).toEqual([]);

    fs.writeFileSync(path.join(first.folder, 'kept.txt'), 'Ann Perkins\n');
    const second = await buildFromRef({
      project,
      projectName: PROJECT_NAME,
      ref: 'main',
      log: quiet,
    });

    expect(second).toEqual({ folder: first.folder, built: false });
    expect(read(first.folder, 'kept.txt')).toBe('Ann Perkins\n');
  });

  it("keeps no build that has the look only because this computer hasn't installed the packages yet", async () => {
    const home = useHome();
    homes.splice(homes.length, 0, home);
    const { clone, main } = cloned(parksApp({ installed: false }), {
      installed: false,
    });
    const project = projectAt(clone.root);
    const base = cacheDirOf(project, PROJECT_NAME);

    const before = await buildFromRef({
      project,
      projectName: PROJECT_NAME,
      ref: 'main',
      log: quiet,
    });

    expect(before.result?.notes).toEqual([notInstalledMessage(PROJECT_NAME)]);
    expect(before.folder).not.toBe(path.join(base, main));
    expect(fs.existsSync(path.join(base, main))).toBe(false);

    writeFiles(clone.root, { ...INSTALLED, ...TAILWIND_CLI });
    const after = await buildFromRef({
      project,
      projectName: PROJECT_NAME,
      ref: 'main',
      log: quiet,
    });

    expect(after).toMatchObject({ folder: path.join(base, main), built: true });
    expect(fs.existsSync(path.join(after.folder, BUNDLE_JS))).toBe(true);
  });

  it("says when bundle.css is esbuild's because no Tailwind CLI is installed, and keeps no such build", async () => {
    const home = useHome();
    homes.splice(homes.length, 0, home);
    const { clone, main } = cloned(parksApp(), { installed: false });
    writeFiles(clone.root, INSTALLED);
    const project = projectAt(clone.root);
    const base = cacheDirOf(project, PROJECT_NAME);

    const before = await buildFromRef({
      project,
      projectName: PROJECT_NAME,
      ref: 'main',
      log: quiet,
    });

    expect(before.result?.notes).toEqual([TAILWIND_NO_CLI]);
    expect(fs.existsSync(path.join(before.folder, BUNDLE_JS))).toBe(true);
    expect(fs.existsSync(path.join(base, main))).toBe(false);

    writeFiles(clone.root, TAILWIND_CLI);
    const after = await buildFromRef({
      project,
      projectName: PROJECT_NAME,
      ref: 'main',
      log: quiet,
    });

    expect(after).toMatchObject({ folder: path.join(base, main), built: true });
    expect(after.result?.notes).toEqual([]);
    expect(read(after.folder, 'project/components/bundle.css')).toContain(
      '@tailwind utilities'
    );
  });

  it('clears what an earlier build left in the build checkout, ignored files too', async () => {
    const home = useHome();
    homes.splice(homes.length, 0, home);
    const { clone, upstream } = cloned(parksApp());
    const project = projectAt(clone.root);
    await buildFromRef({
      project,
      projectName: PROJECT_NAME,
      ref: 'main',
      log: quiet,
    });
    const checkout = path.join(cacheDirOf(project, PROJECT_NAME), 'checkout');
    // As a project's own build might leave: ignored by the project's .gitignore.
    writeFiles(checkout, {
      '.gitignore': 'node_modules/\nleftover/\n',
      'leftover/bench.txt': 'Jerry Gergich was here\n',
    });
    upstream.write({ '.gitignore': 'node_modules/\nleftover/\n' });
    const next = upstream.commit('Ignore what builds leave');
    clone.git(['fetch', '-q', 'origin']);

    await buildFromRef({
      project,
      projectName: PROJECT_NAME,
      ref: next,
      log: quiet,
    });

    expect(fs.existsSync(path.join(checkout, 'leftover'))).toBe(false);
    expect(
      fs.lstatSync(path.join(checkout, 'node_modules')).isSymbolicLink()
    ).toBe(true);
  });

  it('prints the built folder on its last line', async () => {
    const home = useHome();
    homes.splice(homes.length, 0, home);
    const { clone, main } = cloned(parksApp());
    // Linked, as lambda start links a project before anything builds in it.
    projectAt(clone.root);
    const printed: string[] = [];
    const log = jest
      .spyOn(console, 'log')
      .mockImplementation((line: unknown) => {
        printed.splice(printed.length, 0, String(line));
      });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const cwd = process.cwd();
    const savedExit = process.exitCode;

    try {
      process.chdir(clone.root);
      const program = new Command('lambda').exitOverride();
      registerSystemCommands(program.command('design'));
      await program.parseAsync(
        ['design', 'system', 'build', '--from', 'main'],
        {
          from: 'user',
        }
      );

      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      process.chdir(cwd);
      process.exitCode = savedExit;
      log.mockRestore();
      error.mockRestore();
    }

    expect(printed.at(-1)).toBe(
      path.join(
        home.home,
        '.lambda',
        'cache',
        'design-system',
        fixtureProjectId(clone.root),
        main
      )
    );
  });

  it('leaves no folder for a build that fails half way', async () => {
    const home = useHome();
    homes.splice(homes.length, 0, home);
    const { clone, upstream } = cloned(parksApp());
    upstream.git(['checkout', '-q', '-b', 'park-head']);
    upstream.write({
      'src/components/ParkHead.tsx':
        "import Head from 'next/head';\n\nexport const ParkHead = () => <Head />;\n",
      [`${DIR}/index.tsx`]: indexText({
        ParkCard: '../../src/components/ParkCard',
        ParkHead: '../../src/components/ParkHead',
      }),
    });
    const broken = upstream.commit('A park page head');
    clone.git(['fetch', '-q', 'origin']);

    const error = await rejection(
      buildFromRef({
        project: projectAt(clone.root),
        projectName: PROJECT_NAME,
        ref: broken,
        log: quiet,
      })
    );

    expect(error.message).toBe(
      noStandInMessage('src/components/ParkHead.tsx', 'next/head')
    );
    const base = cacheDirOf(projectAt(clone.root), PROJECT_NAME);
    expect(fs.existsSync(path.join(base, broken))).toBe(false);
    expect(fs.readdirSync(base).filter((name) => name !== 'checkout')).toEqual(
      []
    );
  });

  it('refuses a ref with no manifest', async () => {
    const home = useHome();
    homes.splice(homes.length, 0, home);
    const { clone, upstream } = cloned(parksApp());
    upstream.remove(MANIFEST);
    const none = upstream.commit('No design system');
    clone.git(['fetch', '-q', 'origin']);

    const error = await rejection(
      buildFromRef({
        project: projectAt(clone.root),
        projectName: PROJECT_NAME,
        ref: none,
        log: quiet,
      })
    );

    expect(error).toBeInstanceOf(NoDesignSystemError);
    expect(error.message).toBe(noDesignSystemMessage(MANIFEST));
  });

  it("runs the project's own build in the build checkout, once per commit", async () => {
    const home = useHome();
    homes.splice(homes.length, 0, home);
    const record = path.join(tmp('lambda-ds-record-'), 'calls.json');
    const { clone, main } = cloned({
      ...parksApp(),
      'scripts/build-design-system.js': BUILD_SCRIPT,
      'lambda.json': `${JSON.stringify({
        name: PROJECT_NAME,
        design: {
          system: {
            build: `node scripts/build-design-system.js {out} ${record} ok`,
          },
        },
      })}\n`,
    });
    const project = projectAt(clone.root);

    const first = await buildFromRef({
      project,
      projectName: PROJECT_NAME,
      ref: 'main',
      log: quiet,
    });
    const second = await buildFromRef({
      project,
      projectName: PROJECT_NAME,
      ref: 'main',
      log: quiet,
    });

    expect(first.folder).toBe(
      path.join(cacheDirOf(projectAt(clone.root), PROJECT_NAME), main)
    );
    expect(second).toEqual({ folder: first.folder, built: false });
    expect(fs.existsSync(path.join(first.folder, BUNDLE_JS))).toBe(true);
    const ran: Calls = JSON.parse(fs.readFileSync(record, 'utf8'));
    expect(ran).toEqual({
      calls: 1,
      cwd: [
        fs.realpathSync(
          path.join(cacheDirOf(projectAt(clone.root), PROJECT_NAME), 'checkout')
        ),
      ],
    });
  });
});
