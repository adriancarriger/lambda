import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildSystem } from '../build';
import { type Stack } from '../detect';
import {
  type Token,
  type TokensJson,
  asColour,
  checkTokens,
  cssVariables,
  deriveTokens,
  paletteTokens,
  readPalette,
} from '../tokens';
import { DIR, MANIFEST, makeRepo } from './buildFixture';

/** A fixture project: each key a relative path, each value its content. */
const project = (files: Record<string, string>): string => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-tokens-'))
  );
  write(root, files);

  return root;
};

const write = (root: string, files: Record<string, string>): void => {
  Object.entries(files).forEach(([rel, content]) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  });
};

const derive = (
  checkout: string,
  stack: Stack,
  theme: string[]
): ReturnType<typeof deriveTokens> =>
  deriveTokens({
    checkout,
    stack,
    theme,
    title: 'Pawnee parks map',
    ref: 'a1b2c3d',
    components: { ParkCard: 'src/components/ParkCard.tsx' },
  });

/** Colour tokens by name. */
const colours = (tokens: TokensJson): Record<string, Token['value']> =>
  Object.fromEntries(
    tokens.color.tokens.map(({ name, value }) => [name, value])
  );

/** A stand-in for `@mui/material`: its `createTheme` keeps the colour schemes and a custom radius scale. */
const fakeMui = {
  'node_modules/@mui/material/package.json': JSON.stringify({
    name: '@mui/material',
    version: '6.0.0',
    main: 'index.js',
  }),
  'node_modules/@mui/material/index.js': 'module.exports = {};\n',
  'node_modules/@mui/material/styles/index.js': `exports.createTheme = (opts) => ({
  colorSchemes: opts.colorSchemes,
  radius: opts.radius,
});
`,
};

const muiTheme = (
  lightPrimary: string
): string => `import { createTheme } from '@mui/material/styles';

export const theme = createTheme({
  colorSchemes: {
    light: {
      palette: {
        primary: { main: '${lightPrimary}' },
        background: { default: '#ffffff' },
        action: { active: 'var(--mui-palette-primary-main)' },
      },
    },
    dark: {
      palette: {
        primary: { main: '#4caf50' },
        background: { default: '#121212' },
        action: { active: 'var(--mui-palette-primary-main)' },
      },
    },
  },
  radius: { sm: '4px', md: '8px' },
});
`;

const parkCss = `:root {
  --park-green: #2f6b3a;
  --paper: white;
  --ink: rgb(26, 26, 26);
  --link: var(--park-green);
  --lost: var(--x);
  --radius-card: 8px;
  --space-2: 8px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --park-green: #4caf50;
    --paper: #121212;
  }
}
`;

describe('deriveTokens: the colours match the source', () => {
  it('reads a MUI createTheme palette, light and dark', async () => {
    const root = project({
      ...fakeMui,
      'src/theme.ts': muiTheme('#2f6b3a'),
    });

    const { tokens, skipped } = await derive(root, 'mui', ['src/theme.ts']);

    expect(colours(tokens)).toEqual({
      'primary-main': { light: '#2f6b3a', dark: '#4caf50' },
      'background-default': { light: '#ffffff', dark: '#121212' },
      'action-active': { light: '{primary-main}', dark: '{primary-main}' },
    });
    expect(tokens.radius.tokens).toEqual([
      { name: 'radius-sm', value: '4px' },
      { name: 'radius-md', value: '8px' },
    ]);
    expect(tokens.color.themes.map(({ id }) => id)).toEqual(['light', 'dark']);
    expect(tokens.meta).toEqual({
      source: 'mui',
      ref: 'a1b2c3d',
      components: { ParkCard: 'src/components/ParkCard.tsx' },
    });
    expect(skipped).toEqual([]);
  });

  it('changes the tokens on the next derive when the theme file changes', async () => {
    const root = project({
      ...fakeMui,
      'src/theme.ts': muiTheme('#2f6b3a'),
    });

    const before = await derive(root, 'mui', ['src/theme.ts']);
    write(root, { 'src/theme.ts': muiTheme('#1f4e79') });
    const after = await derive(root, 'mui', ['src/theme.ts']);

    expect(colours(before.tokens)['primary-main']).toEqual({
      light: '#2f6b3a',
      dark: '#4caf50',
    });
    expect(colours(after.tokens)['primary-main']).toEqual({
      light: '#1f4e79',
      dark: '#4caf50',
    });
  });

  it('leaves no bundle of the theme behind', async () => {
    const root = project({
      ...fakeMui,
      'src/theme.ts': muiTheme('#2f6b3a'),
    });

    await derive(root, 'mui', ['src/theme.ts']);

    expect(
      fs.readdirSync(path.join(root, 'node_modules/.cache/lambda-design'))
    ).toEqual([]);
  });

  it('reads a Tailwind v3 config’s theme.extend.colors with no tailwindcss installed', async () => {
    const root = project({
      'tailwind.config.ts': `export default {
  theme: {
    extend: {
      colors: { park: { green: '#2f6b3a', 500: '#3c8a4b' } },
      borderRadius: { card: '0.5rem' },
    },
  },
};
`,
    });

    const { tokens } = await derive(root, 'tailwind', ['tailwind.config.ts']);

    expect(colours(tokens)).toEqual({
      'park-500': { light: '#3c8a4b', dark: '#3c8a4b' },
      'park-green': { light: '#2f6b3a', dark: '#2f6b3a' },
    });
    expect(tokens.radius.tokens).toEqual([
      { name: 'radius-card', value: '0.5rem' },
    ]);
  });

  it('takes the installed tailwindcss/resolveConfig value for the config’s own colours', async () => {
    const root = project({
      'package.json': JSON.stringify({ name: 'pawnee-parks' }),
      'node_modules/tailwindcss/package.json': JSON.stringify({
        name: 'tailwindcss',
        version: '3.4.0',
      }),
      'node_modules/tailwindcss/resolveConfig.js': `module.exports = () => ({
  theme: { colors: { park: '#3c8a4b', slate: { 500: '#64748b' } } },
});
`,
      'tailwind.config.ts': `export default { theme: { extend: { colors: { park: 'theme(colors.green.700)' } } } };\n`,
    });

    const { tokens } = await derive(root, 'tailwind', ['tailwind.config.ts']);

    // Only the config's own keys: the resolved default palette stays out.
    expect(colours(tokens)).toEqual({
      park: { light: '#3c8a4b', dark: '#3c8a4b' },
    });
  });

  it('reads a Tailwind v4 @theme block', async () => {
    const root = project({
      'src/app.css': `@import "tailwindcss";

@theme {
  --color-park-green: oklch(0.52 0.12 145);
  --color-pawnee-blue: #1f4e79;
  --radius-card: 0.5rem;
}
`,
    });

    const { tokens } = await derive(root, 'tailwind', ['src/app.css']);

    expect(colours(tokens)).toEqual({
      'park-green': {
        light: 'oklch(0.52 0.12 145)',
        dark: 'oklch(0.52 0.12 145)',
      },
      'pawnee-blue': { light: '#1f4e79', dark: '#1f4e79' },
    });
    expect(tokens.radius.tokens).toEqual([
      { name: 'radius-card', value: '0.5rem' },
    ]);
  });

  it('reads a stylesheet’s :root and dark-scheme custom properties', async () => {
    const root = project({ 'src/styles.css': parkCss });

    const { tokens, skipped } = await derive(root, 'css-variables', [
      'src/styles.css',
    ]);

    expect(colours(tokens)).toEqual({
      'park-green': { light: '#2f6b3a', dark: '#4caf50' },
      paper: { light: '#ffffff', dark: '#121212' },
      ink: { light: 'rgb(26, 26, 26)', dark: 'rgb(26, 26, 26)' },
      link: { light: '{park-green}', dark: '{park-green}' },
    });
    // A var() naming no token can't be written as a colour: left out, noted.
    expect(skipped).toEqual([
      {
        name: 'lost',
        value: 'var(--x)',
        reason: 'not a colour Lambda can write',
      },
    ]);
    expect(tokens.radius.tokens).toEqual([
      { name: 'radius-card', value: '8px' },
    ]);
    expect(tokens.spacing.tokens).toEqual([{ name: 'space-2', value: '8px' }]);
  });

  it('reads a styled-components theme object', async () => {
    const root = project({
      'src/theme.ts': `export const parkTheme = {
  colors: { green: '#2f6b3a', sand: '#e8dcc0' },
  dark: { green: '#4caf50' },
};
`,
    });

    const { tokens } = await derive(root, 'styled-components', [
      'src/theme.ts',
    ]);

    expect(colours(tokens)).toEqual({
      green: { light: '#2f6b3a', dark: '#4caf50' },
      sand: { light: '#e8dcc0', dark: '#e8dcc0' },
    });
  });

  // An alias of a token to itself would be circular, so a light-only theme
  // writes its light value as dark.
  it('gives a light-only theme a dark equal to light', async () => {
    const root = project({
      'src/styles.css': `:root {
  --park-green: #2f6b3a;
  --pawnee-blue: #1f4e79;
}
`,
    });

    const { tokens } = await derive(root, 'css-variables', ['src/styles.css']);

    expect(tokens.color.themes.map(({ id }) => id)).toEqual(['light', 'dark']);
    tokens.color.tokens.forEach(({ value }) => {
      expect(typeof value === 'string' ? value : value.dark).toBe(
        typeof value === 'string' ? value : value.light
      );
    });
    expect(colours(tokens)['park-green']).toEqual({
      light: '#2f6b3a',
      dark: '#2f6b3a',
    });
  });

  it('keeps a colour whose name only contains "space" or "radius" a colour', async () => {
    const root = project({
      'src/styles.css': `:root {
  --color-workspace-bg: #f5f5f0;
  --whitespace-tint: #eeeeee;
  --radius-card: 8px;
  --space-2: 8px;
}
`,
    });

    const { tokens } = await derive(root, 'css-variables', ['src/styles.css']);

    expect(colours(tokens)).toEqual({
      'workspace-bg': { light: '#f5f5f0', dark: '#f5f5f0' },
      'whitespace-tint': { light: '#eeeeee', dark: '#eeeeee' },
    });
    expect(tokens.radius.tokens).toEqual([
      { name: 'radius-card', value: '8px' },
    ]);
    expect(tokens.spacing.tokens).toEqual([{ name: 'space-2', value: '8px' }]);
  });

  it("reads a workspace package's theme, whose package is installed only in that package", async () => {
    const root = project({
      'package.json': JSON.stringify({
        name: 'pawnee',
        private: true,
        workspaces: ['apps/*'],
      }),
      'apps/parks/package.json': JSON.stringify({ name: 'parks' }),
      'apps/parks/node_modules/park-palette/package.json': JSON.stringify({
        name: 'park-palette',
        version: '1.0.0',
        main: 'index.js',
      }),
      'apps/parks/node_modules/park-palette/index.js':
        "exports.green = '#2f6b3a';\n",
      'apps/parks/src/theme.ts': `import { green } from 'park-palette';

export const parkTheme = { colors: { green } };
`,
    });

    const { tokens } = await derive(root, 'styled-components', [
      'apps/parks/src/theme.ts',
    ]);

    expect(colours(tokens)).toEqual({
      green: { light: '#2f6b3a', dark: '#2f6b3a' },
    });
  });

  it("resolves a workspace package's Tailwind config through that package's own tailwindcss", async () => {
    const root = project({
      'package.json': JSON.stringify({ name: 'pawnee', private: true }),
      'apps/parks/package.json': JSON.stringify({ name: 'parks' }),
      'apps/parks/node_modules/tailwindcss/package.json': JSON.stringify({
        name: 'tailwindcss',
        version: '3.4.0',
      }),
      'apps/parks/node_modules/tailwindcss/resolveConfig.js': `module.exports = () => ({
  theme: { colors: { park: '#3c8a4b' } },
});
`,
      'apps/parks/tailwind.config.ts': `export default { theme: { extend: { colors: { park: 'theme(colors.green.700)' } } } };\n`,
    });

    const { tokens } = await derive(root, 'tailwind', [
      'apps/parks/tailwind.config.ts',
    ]);

    expect(colours(tokens)).toEqual({
      park: { light: '#3c8a4b', dark: '#3c8a4b' },
    });
  });

  it('merges a module and a stylesheet of one theme', async () => {
    const root = project({
      'tailwind.config.ts': `export default { theme: { extend: { colors: { park: '#2f6b3a' } } } };\n`,
      'src/app/globals.css': `@tailwind base;\n:root { --pawnee-blue: #1f4e79; }\n`,
    });

    const palette = await readPalette({
      checkout: root,
      stack: 'tailwind',
      theme: ['tailwind.config.ts', 'src/app/globals.css'],
    });

    expect(palette.light).toEqual([
      ['park', '#2f6b3a'],
      ['pawnee-blue', '#1f4e79'],
    ]);
  });
});

describe('readPalette: each theme file by what it is', () => {
  const made: string[] = [];

  afterEach(() => {
    made
      .splice(0)
      .forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  });

  it('reads a styled-components theme beside a Tailwind config', async () => {
    const root = project({
      'tailwind.config.ts': `export default { theme: { extend: { colors: { park: '#2f6b3a' } } } };\n`,
      'src/theme.ts': `export const parkTheme = { colors: { sand: '#e8dcc0' } };\n`,
    });
    made.splice(made.length, 0, root);

    const palette = await readPalette({
      checkout: root,
      stack: 'tailwind',
      theme: ['tailwind.config.ts', 'src/theme.ts'],
    });

    expect(palette.light).toEqual([
      ['park', '#2f6b3a'],
      ['sand', '#e8dcc0'],
    ]);
  });

  it('refuses a theme module with no colours, naming the file', async () => {
    const root = project({
      'src/theme.ts': `export const parkTheme = { colors: {} };\n`,
    });
    made.splice(made.length, 0, root);

    await expect(
      readPalette({
        checkout: root,
        stack: 'styled-components',
        theme: ['src/theme.ts'],
      })
    ).rejects.toThrow('src/theme.ts');
  });
});

describe('checkTokens', () => {
  const valid = (): TokensJson => ({
    name: 'Pawnee parks map',
    version: 1,
    color: {
      themes: [
        { id: 'light', name: 'Light' },
        { id: 'dark', name: 'Dark' },
      ],
      tokens: [
        { name: 'park-green', value: { light: '#2f6b3a', dark: '#4caf50' } },
        {
          name: 'link',
          value: { light: '{park-green}', dark: '{park-green}' },
        },
        { name: 'ink', value: 'rgb(26, 26, 26)' },
        { name: 'sky', value: 'oklch(0.7 0.1 230)' },
      ],
    },
    spacing: { tokens: [{ name: 'space-2', value: '8px' }] },
    radius: { tokens: [{ name: 'radius-card', value: '8px' }] },
    meta: { source: 'css-variables', ref: 'a1b2c3d', components: {} },
  });

  it.each<[string, Partial<TokensJson>, string]>([
    ['no meta', { meta: undefined }, 'tokens.json: meta must hold'],
    [
      'a meta with no ref',
      { meta: { source: 'tailwind', ref: '', components: {} } },
      'tokens.json: meta must hold',
    ],
    [
      'a meta with no source',
      { meta: { source: '', ref: 'a1b2c3d', components: {} } },
      'tokens.json: meta must hold',
    ],
    [
      'a component with no source file',
      {
        meta: {
          source: 'tailwind',
          ref: 'a1b2c3d',
          // Built from model-written JSON, so anything can arrive.
          components: JSON.parse('{"ParkCard": 7}'),
        },
      },
      'tokens.json: meta.components.ParkCard must name its source file',
    ],
  ])('refuses %s', (_label, change, message) => {
    expect(() => checkTokens({ ...valid(), ...change })).toThrow(message);
  });

  it('keeps a meta naming each component’s source file', () => {
    expect(() =>
      checkTokens({
        ...valid(),
        meta: {
          source: 'tailwind',
          ref: 'a1b2c3d',
          components: { ParkCard: 'src/components/ParkCard.tsx' },
        },
      })
    ).not.toThrow();
  });

  const withColour = (token: Token): TokensJson => {
    const tokens = valid();

    return {
      ...tokens,
      color: { ...tokens.color, tokens: [...tokens.color.tokens, token] },
    };
  };

  it('passes a well-formed file', () => {
    expect(() => checkTokens(valid())).not.toThrow();
  });

  it('refuses themes that are not light then dark', () => {
    const tokens = valid();

    expect(() =>
      checkTokens({
        ...tokens,
        color: {
          ...tokens.color,
          themes: [
            { id: 'dark', name: 'Dark' },
            { id: 'light', name: 'Light' },
          ],
        },
      })
    ).toThrow('color.themes must be light then dark, not dark,light');
  });

  it('refuses a raw var() colour, naming the token', () => {
    expect(() =>
      checkTokens(withColour({ name: 'lost', value: { light: 'var(--x)' } }))
    ).toThrow('tokens.json: lost is "var(--x)"');
  });

  it('refuses an alias of a token that does not exist, naming both', () => {
    expect(() =>
      checkTokens(withColour({ name: 'trail', value: '{missing}' }))
    ).toThrow(
      'tokens.json: trail is an alias of {missing}, which is not a token.'
    );
  });

  it('refuses an alias of itself, naming the token', () => {
    expect(() =>
      checkTokens(withColour({ name: 'trail', value: '{trail}' }))
    ).toThrow(
      'tokens.json: trail is an alias that never reaches a colour: {trail}.'
    );
  });

  it('refuses aliases that loop through each other, naming the token', () => {
    const tokens = withColour({ name: 'trail', value: { light: '{loop}' } });

    expect(() =>
      checkTokens({
        ...tokens,
        color: {
          ...tokens.color,
          tokens: [
            ...tokens.color.tokens,
            { name: 'loop', value: { light: '{trail}' } },
          ],
        },
      })
    ).toThrow(
      'tokens.json: trail is an alias that never reaches a colour: {loop} → {trail}.'
    );
  });

  it.each([
    ['no color', { color: undefined }, 'color'],
    ['no spacing', { spacing: undefined }, 'spacing'],
    ['no radius', { radius: undefined }, 'radius'],
  ])('refuses %s, naming the field', (_label, change, field) => {
    // Read from a committed tokens.photos.json, so anything can arrive.
    const broken: TokensJson = JSON.parse(
      JSON.stringify({ ...valid(), ...change })
    );

    expect(() => checkTokens(broken)).toThrow(
      `tokens.json: ${field} must hold`
    );
  });

  it('refuses two tokens named park-green', () => {
    expect(() =>
      checkTokens(withColour({ name: 'park-green', value: '#123456' }))
    ).toThrow('tokens.json: two tokens are named park-green.');
  });

  it('refuses a name the pattern does not allow, naming it', () => {
    expect(() =>
      checkTokens(withColour({ name: '-park green', value: '#123456' }))
    ).toThrow('the token name "-park green"');
  });

  it('fails a derive whose token breaks a rule, naming the token', async () => {
    const long = `radius-ramsett-park-${'trail'.repeat(12)}`;
    const root = project({
      'src/styles.css': `:root { --park-green: #2f6b3a; --${long}: 8px; }\n`,
    });

    await expect(
      derive(root, 'css-variables', ['src/styles.css'])
    ).rejects.toThrow(`the token name "${long}"`);
  });

  it('leaves out a colour it cannot write, an alias of it and a private property, and still builds', async () => {
    const root = project({
      'src/styles.css': `:root {
  --park-green: #2f6b3a;
  --brand: color-mix(in oklch, var(--park-green) 80%, white);
  --primary: var(--brand);
  --link: var(--park-green);
  --_accent: #e8dcc0;
}
`,
    });

    const { tokens, skipped } = await derive(root, 'css-variables', [
      'src/styles.css',
    ]);

    expect(colours(tokens)).toEqual({
      'park-green': { light: '#2f6b3a', dark: '#2f6b3a' },
      link: { light: '{park-green}', dark: '{park-green}' },
    });
    expect(skipped.map(({ name }) => name)).toEqual([
      'brand',
      'primary',
      '_accent',
    ]);
  });
});

describe('asColour', () => {
  const none = (): string | null => null;

  it.each([
    ['#2f6b3a', '#2f6b3a'],
    ['#fff', '#fff'],
    ['rgb(47, 107, 58)', 'rgb(47, 107, 58)'],
    ['rgba(47, 107, 58, 0.5)', 'rgba(47, 107, 58, 0.5)'],
    ['oklch(0.52 0.12 145)', 'oklch(0.52 0.12 145)'],
    ['white', '#ffffff'],
    ['  Black ', '#000000'],
    ['hsl(120 100% 50%)', 'rgb(0, 255, 0)'],
    ['0 100% 50%', 'rgb(255, 0, 0)'],
    ['hsl(240, 100%, 50%, 50%)', 'rgba(0, 0, 255, 0.5)'],
  ])('writes %s as %s', (raw, expected) => {
    expect(asColour(raw, none)).toBe(expected);
  });

  it.each([['calc(1px + 2px)'], ['8px'], ['red'], ['var(--x)']])(
    'leaves out %s',
    (raw) => {
      expect(asColour(raw, none)).toBeNull();
    }
  );

  it('makes a var() of a known token an alias', () => {
    const aliasOf = (variable: string): string | null =>
      variable === 'park-green' ? '{park-green}' : null;

    expect(asColour('var(--park-green)', aliasOf)).toBe('{park-green}');
    expect(asColour('var(--park-green, #000)', aliasOf)).toBe('{park-green}');
    expect(asColour('hsl(var(--park-green))', aliasOf)).toBe('{park-green}');
  });
});

describe('cssVariables', () => {
  it('splits light from a .dark class, a data-theme and a dark media query', () => {
    const found = cssVariables(`/* Pawnee */
:root { --park-green: #2f6b3a; }
.dark { --park-green: #4caf50; }
[data-theme="dark"] { --paper: #121212; }
@media (prefers-color-scheme: dark) { :root { --ink: #eeeeee; } }
.park-card { --not-a-theme: #ff0000; }
`);

    expect(found).toEqual({
      light: [['park-green', '#2f6b3a']],
      dark: [
        ['park-green', '#4caf50'],
        ['paper', '#121212'],
        ['ink', '#eeeeee'],
      ],
    });
  });
});

describe('paletteTokens', () => {
  // As CSS does, and as the dark values already did.
  it('keeps the last of two keys that make one name, and aliases MUI vars', () => {
    const { tokens, skipped } = paletteTokens({
      light: [
        ['primary-main', '#000000'],
        ['primary-main', '#2f6b3a'],
        ['link', 'var(--mui-palette-primary-main)'],
        ['shadow', '0 1px 2px black'],
      ],
      dark: [],
      radius: [],
      spacing: [],
    });

    expect(tokens).toEqual([
      { name: 'primary-main', value: { light: '#2f6b3a', dark: '#2f6b3a' } },
      {
        name: 'link',
        value: { light: '{primary-main}', dark: '{primary-main}' },
      },
    ]);
    expect(skipped).toEqual([
      {
        name: 'shadow',
        value: '0 1px 2px black',
        reason: 'not a colour Lambda can write',
      },
    ]);
  });

  it('writes the light value as dark when a dark value is not a colour, and notes it', () => {
    const { tokens, skipped } = paletteTokens({
      light: [['park-green', '#2f6b3a']],
      dark: [['park-green', 'inherit']],
      radius: [],
      spacing: [],
    });

    expect(tokens).toEqual([
      { name: 'park-green', value: { light: '#2f6b3a', dark: '#2f6b3a' } },
    ]);
    expect(skipped.map(({ name, value }) => [name, value])).toEqual([
      ['park-green', 'inherit'],
    ]);
  });
});

describe('a design system made from photos only', () => {
  it('builds tokens.json as the committed tokens.photos.json', async () => {
    const photoTokens: TokensJson = {
      name: 'Pawnee parks map',
      version: 1,
      color: {
        themes: [
          { id: 'light', name: 'Light' },
          { id: 'dark', name: 'Dark' },
        ],
        tokens: [
          { name: 'park-green', value: { light: '#2f6b3a', dark: '#2f6b3a' } },
          {
            name: 'bench-brown',
            value: { light: '#7a5230', dark: '{park-green}' },
          },
        ],
      },
      spacing: { tokens: [{ name: 'space-2', value: '8px' }] },
      radius: { tokens: [{ name: 'radius-md', value: '6px' }] },
    };
    const repo = makeRepo({
      'lambda.json': JSON.stringify({ name: 'Pawnee parks map' }),
      [MANIFEST]: JSON.stringify({
        namespace: 'PawneeParksMap',
        version: 1,
        source: 'photos',
      }),
      [`${DIR}/tokens.photos.json`]: JSON.stringify(photoTokens, null, 2),
    });
    const sha = repo.commit('Pawnee parks map, from photos');
    const out = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-photos-')),
      'system'
    );

    await buildSystem({
      project: repo.project(),
      projectName: 'Pawnee parks map',
      checkout: repo.root,
      out,
    });

    expect(
      JSON.parse(
        fs.readFileSync(path.join(out, 'project', 'tokens.json'), 'utf8')
      )
    ).toEqual({
      ...photoTokens,
      // The photos' look as committed; meta names where it came from.
      meta: { source: 'photos', ref: sha.slice(0, 7), components: {} },
    });
    expect(fs.existsSync(path.join(out, 'project', 'components'))).toBe(false);
  });

  it('refuses a tokens.photos.json with no color, naming the file and the field', async () => {
    const repo = makeRepo({
      'lambda.json': JSON.stringify({ name: 'Pawnee parks map' }),
      [MANIFEST]: JSON.stringify({
        namespace: 'PawneeParksMap',
        version: 1,
        source: 'photos',
      }),
      [`${DIR}/tokens.photos.json`]: JSON.stringify({
        name: 'Pawnee parks map',
        version: 1,
        spacing: { tokens: [] },
        radius: { tokens: [] },
      }),
    });
    repo.commit('Pawnee parks map, from photos, no colours');
    const out = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-photos-')),
      'system'
    );

    await expect(
      buildSystem({
        project: repo.project(),
        projectName: 'Pawnee parks map',
        checkout: repo.root,
        out,
      })
    ).rejects.toThrow(`${DIR}/tokens.photos.json: color must hold`);
    expect(fs.existsSync(out)).toBe(false);
  });
});
