import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ProjectConfigSchema } from '../../../config/projectConfig';
import {
  type Detected,
  LIBRARY_PRIMITIVES,
  componentsLine,
  detectStack,
  lookLine,
  nonReactReason,
  stackLine,
} from '../detect';

// Every read goes through a spy, so a test can name the files detect read.
jest.mock('fs', () => {
  const actual: typeof import('fs') = jest.requireActual('fs');

  return { ...actual, readFileSync: jest.fn(actual.readFileSync) };
});

/** A fixture project: each key a relative path, each value its content. */
const project = (files: Record<string, string>): string => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-detect-'))
  );

  Object.entries(files).forEach(([rel, content]) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  });

  return root;
};

const pkg = (deps: Record<string, string>, extra = {}): string =>
  JSON.stringify({ name: 'pawnee-parks', dependencies: deps, ...extra });

const git = (root: string, args: string[]): void => {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
};

/** The fixture as a git repo with one commit holding everything. */
const committed = (files: Record<string, string>): string => {
  const root = project(files);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'leslie@pawnee.gov']);
  git(root, ['config', 'user.name', 'Leslie Knope']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'Pawnee parks']);

  return root;
};

const detect = (root: string, config: unknown = {}): Detected =>
  detectStack(root, ProjectConfigSchema.parse(config), { ref: 'HEAD' });

const component = (name: string): string =>
  `export const ${name} = () => null;\n`;

const importing = (name: string): string =>
  `import { ${name} } from '../components/${name}';\nexport const use${name} = ${name};\n`;

/** `count` page files each importing `name`. */
const importers = (name: string, count: number): Record<string, string> =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `src/pages/${name}Page${index}.tsx`,
      importing(name),
    ])
  );

const sixVariables = `:root {
  --park-green: #2f6b3a;
  --park-sand: #e8dcc0;
  --pawnee-blue: #1f4e79;
  --ink: #1a1a1a;
  --paper: #ffffff;
  --radius-card: 8px;
}
`;

const fourVariables = `:root {
  --park-green: #2f6b3a;
  --park-sand: #e8dcc0;
  --ink: #1a1a1a;
  --paper: #ffffff;
}
`;

const muiTheme = `import { createTheme } from '@mui/material/styles';

export const theme = createTheme({
  palette: { primary: { main: '#2f6b3a' } },
});
`;

describe('detectStack: stacks', () => {
  it('finds MUI from its createTheme file', () => {
    const root = project({
      'package.json': pkg({ react: '18.3.1', '@mui/material': '6.0.0' }),
      'src/theme.ts': muiTheme,
      'src/components/ParkCard.tsx': component('ParkCard'),
    });

    const found = detect(root);

    expect(found.stack).toBe('mui');
    expect(found.react).toBe(true);
    expect(found.theme).toEqual(['src/theme.ts']);
    expect(stackLine(found)).toBe('React · MUI');
  });

  it('finds MUI from an extendTheme file too (its CSS-variables theme)', () => {
    const root = project({
      'package.json': pkg({ react: '18.3.1', '@mui/material': '6.0.0' }),
      'src/theme.ts': muiTheme.replace(/createTheme/g, 'extendTheme'),
    });

    const found = detect(root);

    expect(found.stack).toBe('mui');
    expect(found.theme).toEqual(['src/theme.ts']);
  });

  it('never reads a file under node_modules, even one calling createTheme(', () => {
    const root = project({
      'package.json': pkg({ react: '18.3.1', '@mui/material': '6.0.0' }),
      'src/theme.ts': muiTheme,
      'node_modules/@mui/material/styles/createTheme.js': muiTheme,
      'node_modules/pawnee/theme.ts': muiTheme,
    });
    const read = jest.mocked(fs.readFileSync);
    read.mockClear();

    const found = detect(root);
    const readFiles = read.mock.calls.map(([file]) => String(file));

    expect(found.theme).toEqual(['src/theme.ts']);
    expect(readFiles).toContain(path.join(root, 'src/theme.ts'));
    expect(
      readFiles.filter((file) =>
        file.includes(`${path.sep}node_modules${path.sep}`)
      )
    ).toEqual([]);
  });

  it('finds Chakra from its extendTheme file', () => {
    const root = project({
      'package.json': pkg({ react: '18.3.1', '@chakra-ui/react': '2.8.0' }),
      'src/theme.ts': `import { extendTheme } from '@chakra-ui/react';\nexport default extendTheme({ colors: { park: { green: '#2f6b3a' } } });\n`,
    });

    const found = detect(root);

    expect(found.stack).toBe('chakra');
    expect(found.theme).toEqual(['src/theme.ts']);
  });

  it('finds Tailwind with shadcn/ui, its config and its CSS', () => {
    const root = project({
      'package.json': pkg({ react: '18.3.1', tailwindcss: '3.4.0' }),
      'components.json': '{}',
      'tailwind.config.ts': `export default { theme: { extend: { colors: { park: '#2f6b3a' } } } };\n`,
      'src/app/globals.css': '@tailwind base;\n@tailwind components;\n',
      'src/app/plain.css': 'body { margin: 0; }\n',
    });

    const found = detect(root);

    expect(found.stack).toBe('tailwind');
    expect(found.shadcn).toBe(true);
    expect(found.theme).toEqual(['tailwind.config.ts', 'src/app/globals.css']);
    expect(stackLine(found)).toBe('React · Tailwind (shadcn/ui)');
    expect(lookLine(found)).toBe('tailwind.config.ts, src/app/globals.css');
  });

  it('finds Tailwind without shadcn/ui when there is no components.json', () => {
    const root = project({
      'package.json': pkg({ react: '18.3.1', tailwindcss: '3.4.0' }),
      'tailwind.config.js': 'module.exports = {};\n',
    });

    expect(detect(root)).toMatchObject({ stack: 'tailwind', shadcn: false });
  });

  it('finds styled-components from the theme its ThemeProvider is given', () => {
    const root = project({
      'package.json': pkg({ react: '18.3.1', 'styled-components': '6.1.0' }),
      'src/theme.ts': `export const parkTheme = { colors: { green: '#2f6b3a' } };\n`,
      'src/App.tsx': `import { ThemeProvider } from 'styled-components';\nimport { parkTheme } from './theme';\nexport const App = () => <ThemeProvider theme={parkTheme}><div /></ThemeProvider>;\n`,
    });

    const found = detect(root);

    expect(found.stack).toBe('styled-components');
    expect(found.theme).toEqual(['src/theme.ts']);
  });

  it('finds CSS variables from a :root block with 6 custom properties', () => {
    const root = project({
      'package.json': pkg({ react: '18.3.1' }),
      'src/styles.css': sixVariables,
    });

    const found = detect(root);

    expect(found.stack).toBe('css-variables');
    expect(found.theme).toEqual(['src/styles.css']);
  });

  it('calls 4 custom properties not a theme: unknown', () => {
    const root = project({
      'package.json': pkg({ react: '18.3.1' }),
      'src/styles.css': fourVariables,
    });

    expect(detect(root)).toMatchObject({
      stack: 'unknown',
      theme: [],
      components: [],
    });
  });

  it('gives a Vue app no components and says why', () => {
    const root = project({
      'package.json': pkg({ vue: '3.4.0' }),
      'src/styles/tokens.css': sixVariables,
      'src/components/ParkCard.tsx': component('ParkCard'),
    });

    const found = detect(root);

    expect(found).toMatchObject({
      stack: 'vue',
      react: false,
      theme: ['src/styles/tokens.css'],
      components: [],
      reason: "Vue components can't run in Claude Design, which uses React.",
    });
    expect(stackLine(found)).toBe('Vue');
    expect(lookLine(found)).toBe('src/styles/tokens.css');
    expect(componentsLine(found)).toBe(
      "none — Vue components can't run in Claude Design, which uses React."
    );
  });

  it('calls a Vue app with no theme files unknown', () => {
    const root = project({ 'package.json': pkg({ vue: '3.4.0' }) });

    expect(detect(root)).toMatchObject({
      stack: 'unknown',
      react: false,
      components: [],
    });
  });

  it('is not React when react sits beside a non-React framework', () => {
    const root = project({
      'package.json': pkg({ react: '18.3.1', 'solid-js': '1.8.0' }),
      'src/styles.css': sixVariables,
    });

    expect(detect(root)).toMatchObject({
      stack: 'solid',
      react: false,
      reason: nonReactReason('Solid'),
    });
  });

  it('calls an empty React app unknown', () => {
    const root = project({
      'package.json': pkg({ react: '18.3.1' }),
      'src/main.tsx': `import { createRoot } from 'react-dom/client';\n`,
    });

    const found = detect(root);

    expect(found).toMatchObject({
      stack: 'unknown',
      react: true,
      theme: [],
      components: [],
    });
    expect(found.reason).toBeUndefined();
    expect(lookLine(found)).toBe('none');
    expect(componentsLine(found)).toBe('none');
  });

  it('reads the app package of a workspace, the one app.start names', () => {
    const root = project({
      'package.json': JSON.stringify({
        name: 'pawnee',
        workspaces: ['apps/*'],
      }),
      'apps/parks/package.json': JSON.stringify({
        name: 'parks',
        dependencies: { react: '18.3.1', '@mui/material': '6.0.0' },
      }),
      'apps/parks/src/theme.ts': muiTheme,
      'apps/library/package.json': JSON.stringify({ name: 'library' }),
      'apps/library/src/theme.ts': muiTheme,
    });

    const found = detect(root, { app: { start: 'pnpm --filter parks dev' } });

    expect(found.stack).toBe('mui');
    expect(found.theme).toEqual(['apps/parks/src/theme.ts']);
  });

  it('matches a workspace folder whole, so apps/web is not the app apps/webapp names', () => {
    const root = project({
      'package.json': JSON.stringify({
        name: 'pawnee',
        workspaces: ['apps/*'],
      }),
      'apps/web/package.json': JSON.stringify({ name: 'pawnee-web' }),
      'apps/web/src/theme.ts': muiTheme,
      'apps/webapp/package.json': JSON.stringify({
        name: 'pawnee-site',
        dependencies: { react: '18.3.1', '@mui/material': '6.0.0' },
      }),
      'apps/webapp/src/theme.ts': muiTheme,
    });

    const found = detect(root, {
      app: { start: 'cd apps/webapp && npm run dev' },
    });

    expect(found.theme).toEqual(['apps/webapp/src/theme.ts']);
  });

  it('takes design.systemBuild.theme over what it finds', () => {
    const root = project({
      'package.json': pkg({ react: '18.3.1', tailwindcss: '3.4.0' }),
      'tailwind.config.ts': 'export default {};\n',
      'src/look/park.css': fourVariables,
    });

    expect(
      detect(root, { design: { systemBuild: { theme: ['src/look/*.css'] } } })
        .theme
    ).toEqual(['src/look/park.css']);
  });
});

describe("detectStack: the pods' folders", () => {
  it("never reads a pod worktree's copy of the app, wherever lambda.json puts the pods", () => {
    const saved = process.env.LAMBDA_PODS_ROOT;
    delete process.env.LAMBDA_PODS_ROOT;

    try {
      const root = project({
        'package.json': pkg({ react: '^18.2.0' }),
        'src/components/ParkCard.tsx': component('ParkCard'),
        'pods/pod-pawnee-1/worktree/src/styles/tokens.css': sixVariables,
        'pods/pod-pawnee-1/worktree/src/pages/Bench.tsx': importing('ParkCard'),
      });

      const found = detect(root, { pods: { root: 'pods' } });

      expect(found.theme).toEqual([]);
      expect(found.stack).toBe('unknown');
    } finally {
      if (saved !== undefined) {
        process.env.LAMBDA_PODS_ROOT = saved;
      }
    }
  });
});

describe('detectStack: components', () => {
  it('leaves out the design system’s own pattern copies', () => {
    const root = project({
      'package.json': pkg({ react: '18.3.1' }),
      'src/styles.css': sixVariables,
      'src/components/Button.tsx': component('Button'),
      '.lambda/design-system/patterns/ParkCard.tsx': component('ParkCard'),
    });

    expect(detect(root).components).toEqual(['Button']);
  });

  it('leaves out a design.system.dir that sits among the components', () => {
    const root = project({
      'package.json': pkg({ react: '18.3.1' }),
      'src/components/Button.tsx': component('Button'),
      'src/components/design-system/patterns/ParkCard.tsx':
        component('ParkCard'),
    });

    expect(
      detect(root, {
        design: { system: { dir: 'src/components/design-system' } },
      }).components
    ).toEqual(['Button']);
  });

  it.each([
    ['./src/components/design-system'],
    ['src/components/design-system/'],
  ])('leaves it out however its dir is spelled: %s', (dir) => {
    const root = project({
      'package.json': pkg({ react: '18.3.1' }),
      'src/components/Button.tsx': component('Button'),
      'src/components/design-system/patterns/ParkCard.tsx':
        component('ParkCard'),
    });

    expect(detect(root, { design: { system: { dir } } }).components).toEqual([
      'Button',
    ]);
  });

  it('ranks by how many files import each, and skips lowercase exports', () => {
    const root = project({
      'package.json': pkg({ react: '18.3.1' }),
      'src/components/Button.tsx': component('Button'),
      'src/components/ParkCard.tsx': component('ParkCard'),
      'src/components/BenchRow.tsx': component('BenchRow'),
      'src/components/helper.ts': `export const helper = (n: number) => n + 1;\n`,
      ...importers('Button', 5),
      ...importers('ParkCard', 3),
      ...importers('BenchRow', 1),
      ...importers('helper', 7),
    });

    const found = detect(root);

    expect(found.components).toEqual(['Button', 'ParkCard', 'BenchRow']);
    expect(componentsLine(found)).toBe('3 — Button, ParkCard, BenchRow');
  });

  it('keeps 40 of 45 components, ties by name', () => {
    const names = Array.from(
      { length: 45 },
      (_, index) => `Bench${String(index + 1).padStart(2, '0')}`
    );
    const root = project({
      'package.json': pkg({ react: '18.3.1' }),
      ...Object.fromEntries(
        names.map((name) => [`src/components/${name}.tsx`, component(name)])
      ),
    });

    const found = detect(root);

    expect(found.components).toHaveLength(40);
    expect(found.components).toEqual(names.slice(0, 40));
    expect(componentsLine(found)).toBe(
      '40 — Bench01, Bench02, Bench03, Bench04, Bench05, …'
    );
  });

  it('leaves out components of a sibling package beside the app', () => {
    const root = project({
      'package.json': JSON.stringify({
        name: 'pawnee',
        workspaces: ['apps/*'],
      }),
      'apps/web/package.json': JSON.stringify({
        name: 'web',
        dependencies: { react: '18.3.1' },
      }),
      'apps/web/src/components/ParkCard.tsx': component('ParkCard'),
      'apps/api/package.json': JSON.stringify({ name: 'api' }),
      'apps/api/src/components/Foo.tsx': component('Foo'),
    });

    expect(
      detect(root, { app: { start: 'pnpm --filter web dev' } }).components
    ).toEqual(['ParkCard']);
  });

  it('never reads or lists a generated coverage report', () => {
    const root = project({
      'package.json': pkg({ react: '18.3.1' }),
      'src/components/ParkCard.tsx': component('ParkCard'),
      'coverage/lcov-report/src/components/Foo.tsx': component('Foo'),
      'coverage/lcov-report/styles.css': sixVariables,
    });
    const read = jest.mocked(fs.readFileSync);
    read.mockClear();

    const found = detect(root);

    expect(found.components).toEqual(['ParkCard']);
    expect(found.theme).toEqual([]);
    expect(
      read.mock.calls.filter(([file]) =>
        String(file).includes(`${path.sep}coverage${path.sep}`)
      )
    ).toEqual([]);
  });

  it('reads each source file once, however many components it ranks', () => {
    const root = project({
      'package.json': pkg({ react: '18.3.1' }),
      'src/components/Button.tsx': component('Button'),
      'src/components/ParkCard.tsx': component('ParkCard'),
      'src/components/BenchRow.tsx': component('BenchRow'),
      ...importers('Button', 3),
      ...importers('ParkCard', 2),
    });
    const read = jest.mocked(fs.readFileSync);
    read.mockClear();

    detect(root);
    const sources = read.mock.calls
      .map(([file]) => String(file))
      .filter((file) => file.endsWith('.tsx'));

    expect(sources.length).toBeGreaterThan(0);
    expect(sources).toEqual(Array.from(new Set(sources)));
  });

  it('takes design.systemBuild.components over what it finds', () => {
    const root = project({
      'package.json': pkg({ react: '18.3.1' }),
      'src/components/Button.tsx': component('Button'),
      'src/components/ParkCard.tsx': component('ParkCard'),
      ...importers('Button', 5),
    });

    expect(
      detect(root, {
        design: {
          systemBuild: { components: ['src/components/ParkCard.tsx'] },
        },
      }).components
    ).toEqual(['ParkCard']);
  });

  it('puts the 14 library primitives first for MUI', () => {
    const root = project({
      'package.json': pkg({ react: '18.3.1', '@mui/material': '6.0.0' }),
      'src/theme.ts': muiTheme,
      'src/components/ParkCard.tsx': component('ParkCard'),
      'src/components/Button.tsx': component('Button'),
      ...importers('ParkCard', 2),
    });

    const found = detect(root);

    expect(LIBRARY_PRIMITIVES).toHaveLength(14);
    expect(found.components.slice(0, 14)).toEqual(LIBRARY_PRIMITIVES);
    expect(found.components.slice(14)).toEqual(['ParkCard']);
  });
});

describe('detectStack: the design system on the ref', () => {
  it('reads the manifest committed at the ref', () => {
    const root = committed({
      'package.json': pkg({ react: '18.3.1' }),
      '.lambda/design-system/design-system.json': JSON.stringify({
        namespace: 'PawneeDS',
        version: 3,
        builtFrom: 'a1b2c3d',
      }),
    });

    expect(detect(root).system).toEqual({
      dir: '.lambda/design-system',
      version: 3,
      builtFrom: 'a1b2c3d',
    });
  });

  it('has no system when the ref holds no manifest, even one on disk', () => {
    const root = committed({ 'package.json': pkg({ react: '18.3.1' }) });
    fs.mkdirSync(path.join(root, '.lambda/design-system'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.lambda/design-system/design-system.json'),
      JSON.stringify({ namespace: 'PawneeDS', version: 1 })
    );

    expect(detect(root).system).toBeNull();
  });
});

describe('the detect lines', () => {
  const detected = (fields: Partial<Detected>): Detected => ({
    stack: 'unknown',
    shadcn: false,
    react: true,
    theme: [],
    components: [],
    system: null,
    ...fields,
  });

  it('shortens a long component list to five and an ellipsis', () => {
    expect(
      componentsLine(
        detected({
          components: [
            'Button',
            'Card',
            'Input',
            'Dialog',
            'ParkCard',
            'BenchRow',
            'Map',
            'Badge',
            'Chip',
            'List',
            'Tabs',
            'Menu',
          ],
        })
      )
    ).toBe('12 — Button, Card, Input, Dialog, ParkCard, …');
  });

  it('names the stack, React first', () => {
    expect(stackLine(detected({ stack: 'css-variables' }))).toBe(
      'React · CSS variables'
    );
    expect(stackLine(detected({ stack: 'unknown', react: false }))).toBe(
      'Unknown'
    );
  });
});

describe('detectStack: at a ref', () => {
  const made: string[] = [];

  afterEach(() => {
    made
      .splice(0)
      .forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  });

  it('reads the app as committed at the ref, not the files on disk', () => {
    const root = committed({
      'package.json': pkg({ react: '18.3.1', tailwindcss: '3.4.0' }),
      'tailwind.config.js': 'module.exports = { theme: {} };\n',
      'src/components/BenchRow.tsx': component('BenchRow'),
    });
    made.splice(made.length, 0, root);
    // Uncommitted: a stylesheet and a component added, one component deleted.
    fs.writeFileSync(path.join(root, 'src/park.css'), '@tailwind base;\n');
    fs.writeFileSync(
      path.join(root, 'src/components/ParkCard.tsx'),
      component('ParkCard')
    );
    fs.rmSync(path.join(root, 'src/components/BenchRow.tsx'));

    const found = detectStack(root, ProjectConfigSchema.parse({}), {
      ref: 'main',
    });

    expect(found.stack).toBe('tailwind');
    expect(found.theme).toEqual(['tailwind.config.js']);
    expect(found.components).toEqual(['BenchRow']);
  });

  it('reads the files on disk when no ref is given', () => {
    const root = committed({
      'package.json': pkg({ react: '18.3.1' }),
      'src/components/BenchRow.tsx': component('BenchRow'),
    });
    made.splice(made.length, 0, root);
    fs.writeFileSync(
      path.join(root, 'src/components/ParkCard.tsx'),
      component('ParkCard')
    );

    expect(detectStack(root, ProjectConfigSchema.parse({})).components).toEqual(
      ['BenchRow', 'ParkCard']
    );
  });
});

describe('detectStack: what counts as a component', () => {
  it('lists PascalCase components only, not constants, schemas or classes', () => {
    const root = project({
      'package.json': pkg({ react: '18.3.1' }),
      [path.join('packages', 'parks', 'src', 'parks.ts')]: [
        "import { z } from 'zod';",
        'export const MAX_BENCHES = 1;',
        'export const ParkSchema = z.object({});',
        'export class Gazebo {}',
        'export const ParkCard = () => null;',
        '',
      ].join('\n'),
    });

    try {
      expect(detect(root).components).toEqual(['ParkCard']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
