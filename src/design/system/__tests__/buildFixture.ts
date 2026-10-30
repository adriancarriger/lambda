import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  PROJECT_CONFIG_FILE,
  type Project,
  ProjectConfigSchema,
} from '../../../config/projectConfig';
import { readConfigFile } from '../../../config/readConfigFile';
import { TYPE_URL } from '../../__tests__/canvasFixture';
import { importRuntime } from '../../runtime';
import { recordProjectId } from '../projectId';

/**
 * Fixture projects for the design system build tests (build, cache,
 * drawCheck, screenCheck, tokens, and the pod tests in
 * src/pod/__tests__/designSystemStep0.test.ts): a small git repo holding a
 * Pawnee parks app and its design system source, plus a cached Design runtime whose
 * `support.js` provides React 18, as the real one does. Not a test file:
 * jest only runs `*.test.ts`.
 */

export const NAMESPACE = 'PawneeParksMap';
export const PROJECT_NAME = 'Pawnee parks map';
export const DIR = '.lambda/design-system';
export const MANIFEST = `${DIR}/design-system.json`;

export type Files = Record<string, string>;

export const tmp = (prefix: string): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

export const writeFiles = (root: string, files: Files): void =>
  Object.entries(files).forEach(([rel, body]) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // An installed package's bin runs.
    fs.writeFileSync(file, body, {
      mode: rel.includes('node_modules/.bin/') ? 0o755 : 0o644,
    });
  });

export const read = (root: string, rel: string): string =>
  fs.readFileSync(path.join(root, rel), 'utf8');

export const runGit = (
  cwd: string,
  args: string[],
  env: Record<string, string> = {}
): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  }).trim();

export interface Repo {
  root: string;
  write: (files: Files) => void;
  remove: (rel: string) => void;
  /** Commit everything; `date` pins both the author and committer dates. */
  commit: (message: string, date?: string) => string;
  git: (args: string[]) => string;
  project: () => Project;
}

/** The id the mothership gave a fixture project when it was linked. */
export const fixtureProjectId = (root: string): string =>
  `prj_${path.basename(path.dirname(root))}_${path.basename(root)}`.replace(
    /[^A-Za-z0-9_]/g,
    ''
  );

/** A fixture project, linked to Lambda as `lambda start` links one. */
export const projectAt = (root: string): Project => {
  const file = path.join(root, PROJECT_CONFIG_FILE);
  const project = {
    root,
    file,
    config: readConfigFile(file, ProjectConfigSchema),
  };
  recordProjectId(project, fixtureProjectId(root));

  return project;
};

export const repoAt = (root: string): Repo => ({
  root,
  write: (files) => writeFiles(root, files),
  remove: (rel) => fs.rmSync(path.join(root, rel), { recursive: true }),
  commit: (message, date = '2026-10-01T09:00:00-05:00') => {
    runGit(root, ['add', '-A']);
    runGit(
      root,
      ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message],
      {
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      }
    );

    return runGit(root, ['rev-parse', 'HEAD']);
  },
  git: (args) => runGit(root, args),
  project: () => projectAt(root),
});

/** A new git repo on `main` holding `files`, not yet committed. */
export const makeRepo = (files: Files, prefix = 'lambda-ds-app-'): Repo => {
  const root = tmp(prefix);
  runGit(root, ['init', '-q', '-b', 'main']);
  runGit(root, ['config', 'user.name', 'Leslie Knope']);
  runGit(root, ['config', 'user.email', 'leslie@pawnee.example']);
  writeFiles(root, files);

  return repoAt(root);
};

/** "Installed": what the build looks for. React itself is never bundled. */
export const INSTALLED: Files = {
  'node_modules/react/package.json':
    '{ "name": "react", "version": "18.2.0", "main": "index.js" }\n',
  'node_modules/react/index.js': 'module.exports = {};\n',
};

/** A Tailwind v3 CLI that writes its --input's text as the compiled CSS. */
export const TAILWIND_CLI: Files = {
  'node_modules/.bin/tailwindcss': [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    'const args = process.argv.slice(2);',
    'const at = (flag) => args[args.indexOf(flag) + 1];',
    "fs.writeFileSync(at('--output'), fs.readFileSync(at('--input'), 'utf8'));",
    '',
  ].join('\n'),
  'node_modules/tailwindcss/package.json':
    '{ "name": "tailwindcss", "version": "3.4.0" }\n',
};

export const ANALYTICS: Files = {
  'node_modules/mixpanel-browser/package.json':
    '{ "name": "mixpanel-browser", "version": "10.0.0" }\n',
  'node_modules/mixpanel-browser/lib/index.js':
    "exports.init = function () { return { name: 'pawnee' }; };\n",
};

export const manifestText = (version: number): string =>
  `${JSON.stringify({ namespace: NAMESPACE, version }, null, 2)}\n`;

export interface CatalogItem {
  name: string;
  summary?: string;
  example?: unknown;
}

export const catalogText = (items: CatalogItem[]): string =>
  `export const catalog = ${JSON.stringify(
    items.map(({ name, summary, example }) => ({
      name,
      summary: summary ?? `${name}, as the app draws it.`,
      props: { name: 'string' },
      example: example ?? {
        component: name,
        props: { name: 'Pawnee Commons' },
      },
    })),
    null,
    2
  )};\n`;

/** `<dir>/index.tsx`: imports each component and assigns `window.<N>` itself. */
export const indexText = (imports: Record<string, string>): string => {
  const names = ['Root', ...Object.keys(imports)];

  return [
    "import { Root } from '../../src/components/Root';",
    ...Object.entries(imports).map(
      ([name, from]) => `import { ${name} } from '${from}';`
    ),
    '',
    `(window as unknown as Record<string, unknown>).${NAMESPACE} = { ${names.join(
      ', '
    )} };`,
    '',
    `export { ${names.join(', ')} };`,
    '',
  ].join('\n');
};

export const sourcesText = ({
  components,
  patterns = {},
}: {
  components: Record<string, string>;
  patterns?: Record<string, string[]>;
}): string =>
  `${JSON.stringify(
    {
      system: [`${DIR}/`],
      tokens: ['tailwind.config.ts', 'src/app/globals.css'],
      components: { Root: 'src/components/Root.tsx', ...components },
      patterns,
    },
    null,
    2
  )}\n`;

export const SAMPLE_DATA = {
  director: 'Leslie Knope',
  parks: [
    { name: 'Pawnee Commons', ranger: 'Ron Swanson', benches: 12 },
    { name: 'Ramsett Park', ranger: 'April Ludgate', benches: 4 },
  ],
};

export interface ScreenFixture {
  file: string;
  title?: string;
  situations?: string[];
  /** Data-state buttons drawn; defaults to every situation. */
  drawnStates?: string[];
  /** The path's clicks: `click <target>` steps. */
  clicks?: string[];
  /** Data-target buttons drawn; defaults to every click. */
  drawnTargets?: string[];
  width?: number;
  height?: number;
  /** The screen's height once its `bench` situation is shown. */
  benchHeight?: number;
  noScreen?: boolean;
  /** A script that runs before the runtime paints. */
  script?: string;
}

/** A reference screen: one window, situations switched by `[data-state]`. */
export const screenHtml = (screen: ScreenFixture): string => {
  const situations = screen.situations ?? ['list', 'bench'];
  const states = screen.drawnStates ?? situations;
  const targets = screen.drawnTargets ?? screen.clicks ?? [];
  const width = screen.width ?? 1440;
  const height = screen.height ?? 900;
  const bench =
    screen.benchHeight === undefined
      ? ''
      : `if (this.getAttribute('data-state') === 'bench') { s.style.height = '${screen.benchHeight}px'; }`;
  const ds = `ds/${NAMESPACE.toLowerCase()}`;
  const attr = screen.noScreen === true ? 'data-page' : 'data-screen';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${screen.title ?? screen.file}</title>
<style>html, body { margin: 0; } button { display: block; }</style>
<script src="./support.js"></script>
<link rel="stylesheet" href="${ds}/components/bundle.css">
<script src="${ds}/components/bundle.js"></script>
<script src="${ds}/sample-data.js"></script>
${screen.script === undefined ? '' : `<script>${screen.script}</script>`}
</head>
<body>
<x-dc><div ${attr} style="width: ${width}px; height: ${height}px; overflow: hidden; background: #f0fff4;">
${states
  .map(
    (slug) =>
      `<button data-state="${slug}" onclick="var s = document.querySelector('[${attr}]'); s.setAttribute('data-current', '${slug}'); ${bench}">${slug}</button>`
  )
  .join('\n')}
${targets
  .map(
    (target) =>
      `<button data-target="${target}" onclick="this.textContent = 'opened'">${target}</button>`
  )
  .join('\n')}
<div data-slot></div>
</div></x-dc>
<script>
  (function () {
    function wait() {
      var slot = document.querySelector('#dc-root [data-slot]');
      if (slot === null) { requestAnimationFrame(wait); return; }
      var N = window.${NAMESPACE}, park = window.${NAMESPACE}Sample.parks[0];
      window.ReactDOM.createRoot(slot).render(
        window.React.createElement(N.Root, null, window.React.createElement(N.ParkCard, { name: park.name }))
      );
    }
    wait();
  })();
</script>
</body>
</html>
`;
};

export const screensIndexText = (screens: ScreenFixture[]): string =>
  `export const SCREENS = ${JSON.stringify(
    screens.map((screen) => ({
      file: screen.file,
      title: screen.title ?? screen.file.replace(/\.dc\.html$/, ''),
      route: `/${screen.file.replace(/\.dc\.html$/, '').toLowerCase()}`,
      summary: `${screen.title ?? screen.file} as Leslie Knope sees it.`,
      situations: (screen.situations ?? ['list', 'bench']).map((slug) => ({
        slug,
        title: slug,
      })),
      path: (screen.clicks ?? []).map((target) => ({
        step: `Open ${target}`,
        action: `click ${target}`,
      })),
      scenario: `parks-${screen.file.replace(/\.dc\.html$/, '').toLowerCase()}`,
    })),
    null,
    2
  )};\n`;

export const screenFiles = (screens: ScreenFixture[]): Files => ({
  [`${DIR}/screens/index.ts`]: screensIndexText(screens),
  ...Object.fromEntries(
    screens.map((screen) => [
      `${DIR}/screens/${screen.file}`,
      screenHtml(screen),
    ])
  ),
});

/**
 * The Tailwind Pawnee parks app with its design system: `Root` and
 * `ParkCard` re-exported from the app, a catalog, sample data and a source
 * map. Screens are added by the tests that check them.
 */
export const parksApp = ({
  version = 3,
  installed = true,
  sampleData = true,
}: {
  version?: number;
  installed?: boolean;
  sampleData?: boolean;
} = {}): Files => ({
  '.gitignore': 'node_modules/\n',
  [PROJECT_CONFIG_FILE]: `${JSON.stringify({ name: PROJECT_NAME }, null, 2)}\n`,
  'package.json': `${JSON.stringify(
    {
      name: 'pawnee-parks-map',
      private: true,
      dependencies: { react: '18.2.0', 'react-dom': '18.2.0' },
      devDependencies: { tailwindcss: '3.4.0' },
    },
    null,
    2
  )}\n`,
  'tailwind.config.ts': [
    'export default {',
    "  content: ['./src/**/*.tsx'],",
    "  theme: { extend: { colors: { 'park-green': '#2f855a', 'pawnee-blue': '#1d4ed8' } } },",
    '};',
    '',
  ].join('\n'),
  'src/app/globals.css':
    '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n',
  'src/components/Root.tsx': [
    "import './Root.css';",
    '',
    'export const Root = ({ children }: { children?: string }) => (',
    '  <div className="pawnee-root">{children}</div>',
    ');',
    '',
  ].join('\n'),
  'src/components/Root.css': '.pawnee-root { font-family: system-ui; }\n',
  'src/components/ParkCard.tsx': [
    "import './ParkCard.css';",
    '',
    'export const ParkCard = ({ name }: { name: string }) => (',
    '  <div className="park-card">{name}</div>',
    ');',
    '',
  ].join('\n'),
  'src/components/ParkCard.css':
    '.park-card { padding: 12px; border-radius: 8px; background: #2f855a; color: #ffffff; }\n',
  'src/app/page.tsx': [
    "import { ParkCard } from '../components/ParkCard';",
    '',
    'export default function Page() { return <ParkCard name="Pawnee Commons" />; }',
    '',
  ].join('\n'),
  [MANIFEST]: manifestText(version),
  [`${DIR}/index.tsx`]: indexText({
    ParkCard: '../../src/components/ParkCard',
  }),
  [`${DIR}/catalog.ts`]: catalogText([{ name: 'ParkCard' }]),
  [`${DIR}/sources.json`]: sourcesText({
    components: { ParkCard: 'src/components/ParkCard.tsx' },
  }),
  ...(sampleData
    ? {
        [`${DIR}/sampleData.ts`]: `export const sample = ${JSON.stringify(
          SAMPLE_DATA,
          null,
          2
        )};\n`,
      }
    : {}),
  ...(installed ? INSTALLED : {}),
});

/** Every file under `dir` with a hash of its bytes, sorted: a tree's fingerprint. */
export const treeHash = (dir: string): string => {
  const walk = (at: string): string[] =>
    fs.existsSync(at)
      ? fs.readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
          const full = path.join(at, entry.name);

          return entry.isDirectory() ? walk(full) : [full];
        })
      : [];

  return createHash('sha256')
    .update(
      walk(dir)
        .sort()
        .map(
          (file) =>
            `${path.relative(dir, file)} ${createHash('sha256')
              .update(fs.readFileSync(file))
              .digest('hex')}`
        )
        .join('\n')
    )
    .digest('hex');
};

/** Every file under `dir`, relative and sorted. */
export const listTree = (dir: string): string[] => {
  const walk = (at: string): string[] =>
    fs.readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(at, entry.name);

      return entry.isDirectory() ? walk(full) : [path.relative(dir, full)];
    });

  return fs.existsSync(dir) ? walk(dir).sort() : [];
};

export const REACT_RELEASE = 'react-fixture-release';

const lambdaModules = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'node_modules'
);

/**
 * A stand-in for the Design type's runtime that, like the real one, gives the
 * page React 18 (`window.React`, `window.ReactDOM`) and swaps `<x-dc>` for a
 * painted `#dc-root`. It is not Anthropic's runtime.
 */
export const reactSupportJs = (): string =>
  [
    fs.readFileSync(
      path.join(lambdaModules, 'react', 'umd', 'react.production.min.js'),
      'utf8'
    ),
    fs.readFileSync(
      path.join(
        lambdaModules,
        'react-dom',
        'umd',
        'react-dom.production.min.js'
      ),
      'utf8'
    ),
    `document.addEventListener('DOMContentLoaded', function () {
  var source = document.querySelector('x-dc');
  if (source === null) return;
  var root = document.createElement('div');
  root.id = 'dc-root';
  root.innerHTML = source.innerHTML;
  source.replaceWith(root);
});
`,
  ].join('\n;\n');

/**
 * Point LAMBDA_PODS_ROOT at a fresh folder and cache the React runtime there
 * as the only (so newest) release. Returns a restore for afterAll.
 */
export const useReactRuntime = (): {
  podsRoot: string;
  restore: () => void;
} => {
  const saved = process.env.LAMBDA_PODS_ROOT;
  const podsRoot = tmp('lambda-ds-pods-');
  process.env.LAMBDA_PODS_ROOT = podsRoot;
  const runtime = tmp('lambda-ds-runtime-');
  writeFiles(runtime, {
    'artifact-type/dc-runtime.js': reactSupportJs(),
    'index.html': '<!doctype html>',
  });
  importRuntime(runtime, REACT_RELEASE, TYPE_URL);

  return {
    podsRoot,
    restore: () => {
      if (saved === undefined) {
        delete process.env.LAMBDA_PODS_ROOT;

        return;
      }

      process.env.LAMBDA_PODS_ROOT = saved;
    },
  };
};

/**
 * Point HOME at a fresh folder (and drop LAMBDA_HOME), so the cache lands
 * there. Jest hands each test file its own copy of `process.env`, which the
 * real `os.homedir()` never reads, so a test file using this mocks `os` with
 * a `homedir()` that follows `process.env.HOME` (build.test.ts shows how).
 * Refuses to run without that mock: the cache would land in the real home.
 */
export const useHome = (): { home: string; restore: () => void } => {
  const saved = { home: process.env.HOME, lambda: process.env.LAMBDA_HOME };
  const home = tmp('lambda-ds-home-');
  const restore = (): void => {
    if (saved.home !== undefined) {
      process.env.HOME = saved.home;
    }

    if (saved.lambda !== undefined) {
      process.env.LAMBDA_HOME = saved.lambda;
    }
  };
  process.env.HOME = home;
  delete process.env.LAMBDA_HOME;

  if (os.homedir() !== home) {
    restore();

    throw new Error(
      "os.homedir() doesn't follow process.env.HOME: mock os in this test file."
    );
  }

  return { home, restore };
};

/** The Error a promise rejects with; fails the test if it resolves. */
export const rejection = async (promise: Promise<unknown>): Promise<Error> => {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error
  );

  if (outcome === undefined) {
    throw new Error('Expected the promise to reject.');
  }

  return outcome instanceof Error ? outcome : new Error(String(outcome));
};

export const quiet = (): void => {};
