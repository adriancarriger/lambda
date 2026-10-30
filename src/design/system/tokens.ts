import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';

import { type Stack } from './detect';
import { loadProjectModule } from './loadModule';

/**
 * The look as `tokens.json`, derived from the app's theme files at every
 * build — never committed, so a theme change needs only a rebuild. One
 * reader per stack (MUI and Chakra theme objects, a Tailwind config or its
 * `@theme` block, a styled-components or Emotion theme, a stylesheet's
 * custom properties), all ending in the same checked shape: colours in two
 * themes, light then dark, each a hex, `rgb()`, `oklch()` or an alias
 * `{name}` of a token that exists.
 */

export type ThemeId = 'light' | 'dark';

export type TokenValue = string | Partial<Record<ThemeId, string>>;

export interface Token {
  name: string;
  value: TokenValue;
}

export interface TokensJson {
  name: string;
  version: number;
  color: { themes: { id: ThemeId; name: string }[]; tokens: Token[] };
  spacing: { tokens: Token[] };
  radius: { tokens: Token[] };
  meta?: {
    source: string;
    ref: string;
    components: Record<string, string>;
  };
}

export interface SkippedToken {
  name: string;
  value: string;
  reason: string;
}

export const TOKEN_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const THEMES: { id: ThemeId; name: string }[] = [
  { id: 'light', name: 'Light' },
  { id: 'dark', name: 'Dark' },
];

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\([^()]*\)$/i;
const OKLCH = /^oklch\([^()]*\)$/i;
const ALIAS = /^\{([^{}]+)\}$/;

const NAMED: Record<string, string> = {
  white: '#ffffff',
  black: '#000000',
  transparent: '#00000000',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const round = (n: number): number => Math.round(n);

/** `hsl(h s% l%)`, or a bare `h s% l%` triplet (shadcn's custom properties). */
const hslToRgb = (text: string): string | null => {
  const inner = /^hsla?\(([^()]*)\)$/i.exec(text)?.[1] ?? text;
  const parts = inner
    .replace(/[,/]/g, ' ')
    .split(/\s+/)
    .filter((part) => part !== '');
  const [h, s, l, a] = parts;

  if (
    h === undefined ||
    s === undefined ||
    l === undefined ||
    !/^-?[\d.]+(deg)?$/.test(h) ||
    !/^[\d.]+%$/.test(s) ||
    !/^[\d.]+%$/.test(l)
  ) {
    return null;
  }

  const hue = (((parseFloat(h) % 360) + 360) % 360) / 360;
  const sat = parseFloat(s) / 100;
  const light = parseFloat(l) / 100;
  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  const channel = (t0: number): number => {
    const t = t0 < 0 ? t0 + 1 : t0 > 1 ? t0 - 1 : t0;

    if (t < 1 / 6) {
      return p + (q - p) * 6 * t;
    }

    if (t < 1 / 2) {
      return q;
    }

    return t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  const [r, g, b] = [hue + 1 / 3, hue, hue - 1 / 3].map((t) =>
    round(channel(t) * 255)
  );

  return a === undefined
    ? `rgb(${r}, ${g}, ${b})`
    : `rgba(${r}, ${g}, ${b}, ${a.endsWith('%') ? parseFloat(a) / 100 : a})`;
};

/**
 * A theme value as a token colour: hex, `rgb()`, `oklch()`, an alias from a
 * `var(--x)`, or null when it isn't one (left out, and noted).
 */
export const asColour = (
  raw: string,
  aliasOf: (variable: string) => string | null
): string | null => {
  const value = raw.trim();
  const lower = value.toLowerCase();

  if (HEX.test(value) || RGB.test(value) || OKLCH.test(value)) {
    return value;
  }

  if (NAMED[lower] !== undefined) {
    return NAMED[lower] ?? null;
  }

  const variable = /^var\(\s*--([A-Za-z0-9_-]+)\s*(?:,[^()]*)?\)$/.exec(value);

  if (variable !== null) {
    return aliasOf(variable[1] ?? '');
  }

  const wrapped = /^hsla?\(\s*var\(\s*--([A-Za-z0-9_-]+)\s*\)\s*\)$/i.exec(
    value
  );

  if (wrapped !== null) {
    return aliasOf(wrapped[1] ?? '');
  }

  return hslToRgb(value);
};

/** `{ park: { 500: '#…', DEFAULT: '#…' } }` → `[['park-500', '#…'], ['park', '#…']]`. */
const flatten = (value: unknown, prefix: string[] = []): [string, string][] => {
  if (isRecord(value)) {
    // Chakra's tokens: `{ value: '#…' }` leaves.
    if (typeof value.value === 'string' && Object.keys(value).length <= 2) {
      return [[prefix.join('-'), value.value]];
    }

    return Object.entries(value).flatMap(([key, child]) =>
      flatten(child, key === 'DEFAULT' ? prefix : [...prefix, key])
    );
  }

  if (typeof value === 'string' || typeof value === 'number') {
    return [[prefix.join('-'), String(value)]];
  }

  return [];
};

// ── CSS custom properties ───────────────────────────────────────────────────

interface CssRule {
  selector: string;
  /** The enclosing `@media` / `@theme` prelude, when there is one. */
  within: string;
  body: string;
}

/** Every `selector { declarations }` rule, with the at-rule around it. */
const cssRules = (css: string, within = ''): CssRule[] => {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const ruleAt = (selector: string, body: string): CssRule[] =>
    selector.startsWith('@media') || selector.startsWith('@layer')
      ? cssRules(body, selector)
      : [{ selector, within, body }];

  const initial: {
    depth: number;
    open: number;
    start: number;
    rules: CssRule[];
  } = { depth: 0, open: 0, start: 0, rules: [] };

  return Array.from(text).reduce((acc, char, index) => {
    if (char === '{') {
      return {
        ...acc,
        open: acc.depth === 0 ? index : acc.open,
        depth: acc.depth + 1,
      };
    }

    if (char === '}' && acc.depth > 0) {
      const depth = acc.depth - 1;

      if (depth !== 0) {
        return { ...acc, depth };
      }

      const selector = text.slice(acc.start, acc.open).trim();
      const body = text.slice(acc.open + 1, index);

      return {
        ...acc,
        depth,
        start: index + 1,
        rules: [...acc.rules, ...ruleAt(selector, body)],
      };
    }

    if (char === ';' && acc.depth === 0) {
      return { ...acc, start: index + 1 };
    }

    return acc;
  }, initial).rules;
};

const declarations = (body: string): [string, string][] =>
  Array.from(
    body.matchAll(/--([A-Za-z0-9_-]+)\s*:\s*([^;]+);?/g),
    (match): [string, string] => [match[1] ?? '', (match[2] ?? '').trim()]
  );

const isDark = ({ selector, within }: CssRule): boolean =>
  /prefers-color-scheme:\s*dark/.test(within) ||
  /\.dark\b|\[data-theme=["']?dark["']?\]|\[data-mode=["']?dark["']?\]/.test(
    selector
  );

/** Rules that declare the theme: `:root`, `html`, a dark/light class, `@theme`. */
const isRootLike = ({ selector }: CssRule): boolean =>
  selector.startsWith('@theme') ||
  /(^|,)\s*(:root|html|:host|\.dark|\.light|\[data-(theme|mode)[^\]]*\])/.test(
    selector
  );

/** Light and dark custom properties of one or more stylesheets. */
export const cssVariables = (
  css: string
): { light: [string, string][]; dark: [string, string][] } => {
  const rules = cssRules(css).filter(isRootLike);

  return {
    light: rules
      .filter((rule) => !isDark(rule))
      .flatMap((r) => declarations(r.body)),
    dark: rules.filter(isDark).flatMap((r) => declarations(r.body)),
  };
};

// ── one palette → tokens ────────────────────────────────────────────────────

interface Palette {
  light: [string, string][];
  dark: [string, string][];
  radius: [string, string][];
  spacing: [string, string][];
}

const emptyPalette = (): Palette => ({
  light: [],
  dark: [],
  radius: [],
  spacing: [],
});

/** Size properties, by where the word sits: `--color-workspace-bg` is a colour. */
const RADIUS = /(^|-)radius/;
const SPACING = /^(spacing|space)/;

/** A token name from a theme key: `color-park-green` → `park-green`. */
const tokenName = (key: string): string =>
  key.replace(/^color-/, '').replace(/[^A-Za-z0-9_.-]/g, '-');

const fromVariables = ({
  light,
  dark,
}: {
  light: [string, string][];
  dark: [string, string][];
}): Palette => {
  const sizeOf = (
    pattern: RegExp,
    list: [string, string][]
  ): [string, string][] =>
    list
      .filter(([name]) => pattern.test(name))
      .map(([name, value]) => [name, value]);

  const isSize = (name: string): boolean =>
    RADIUS.test(name) || SPACING.test(name);

  return {
    light: light.filter(([name]) => !isSize(name)),
    dark: dark.filter(([name]) => !isSize(name)),
    radius: sizeOf(RADIUS, light),
    spacing: sizeOf(SPACING, light),
  };
};

/**
 * The palette's colour tokens: every light colour, with its dark value when
 * the theme has one (no dark theme: the light value in both). A value that
 * is not a colour, a name tokens.json can't hold, and an alias of a colour
 * left out are each left out and noted.
 */
export const paletteTokens = (
  palette: Palette
): { tokens: Token[]; skipped: SkippedToken[] } => {
  // The last declaration of a name wins, as in CSS (and as for dark).
  const lastLight = new Map(
    palette.light.map(([key, raw]) => [tokenName(key), raw])
  );
  const aliasIn =
    (names: Set<string>) =>
    (variable: string): string | null => {
      const stripped = tokenName(variable.replace(/^[a-z]+-palette-/, ''));

      return names.has(stripped) ? `{${stripped}}` : null;
    };
  // The names that become tokens: drop each whose light value isn't a
  // colour given the rest, until none drops, so no alias names a dropped one.
  const tokensOf = (names: Set<string>): Set<string> => {
    const kept = new Set(
      Array.from(names).filter(
        (name) => asColour(lastLight.get(name) ?? '', aliasIn(names)) !== null
      )
    );

    return kept.size === names.size ? names : tokensOf(kept);
  };
  const known = tokensOf(
    new Set(
      Array.from(lastLight.keys()).filter((name) => TOKEN_NAME.test(name))
    )
  );
  const aliasOf = aliasIn(known);
  const darkValues = new Map(
    palette.dark.map(([key, value]) => [tokenName(key), value])
  );
  const hasDark = palette.dark.length > 0;
  const skip = (name: string, raw: string): SkippedToken => ({
    name,
    value: raw,
    reason: 'not a colour Lambda can write',
  });
  const seen = new Set<string>();
  const entries = palette.light.map(
    ([key]): { tokens: Token[]; skipped: SkippedToken[] } => {
      const name = tokenName(key);

      if (seen.has(name)) {
        return { tokens: [], skipped: [] };
      }

      seen.add(name);
      const raw = lastLight.get(name) ?? '';

      if (!TOKEN_NAME.test(name)) {
        return {
          tokens: [],
          skipped: [
            { name, value: raw, reason: 'not a token name Lambda can write' },
          ],
        };
      }

      const light = asColour(raw, aliasOf);

      if (light === null) {
        return { tokens: [], skipped: [skip(name, raw)] };
      }

      const darkRaw = darkValues.get(name);

      if (!hasDark || darkRaw === undefined) {
        return {
          tokens: [{ name, value: { light, dark: light } }],
          skipped: [],
        };
      }

      const dark = asColour(darkRaw, aliasOf);

      return {
        tokens: [{ name, value: { light, dark: dark ?? light } }],
        skipped: dark === null ? [skip(name, darkRaw)] : [],
      };
    }
  );

  return {
    tokens: entries.flatMap((entry) => entry.tokens),
    skipped: entries.flatMap((entry) => entry.skipped),
  };
};

// ── readers by stack ────────────────────────────────────────────────────────

const readText = (root: string, file: string): string =>
  fs.readFileSync(path.join(root, file), 'utf8');

/** The first export that looks like a theme object. */
const themeObject = (
  exports: Record<string, unknown>,
  looksLikeTheme: (value: Record<string, unknown>) => boolean
): Record<string, unknown> | null => {
  const candidates = [exports.default, ...Object.values(exports)];
  const found = candidates.find(
    (value): value is Record<string, unknown> =>
      isRecord(value) && looksLikeTheme(value)
  );

  return found ?? null;
};

const fromMui = (theme: Record<string, unknown>): Palette => {
  const schemes = isRecord(theme.colorSchemes) ? theme.colorSchemes : {};
  const paletteOf = (scheme: unknown): unknown =>
    isRecord(scheme) ? scheme.palette : undefined;
  const light = paletteOf(schemes.light) ?? theme.palette;
  const dark = paletteOf(schemes.dark);

  return {
    light: flatten(light),
    dark: flatten(dark),
    radius: isRecord(theme.radius) ? flatten(theme.radius, ['radius']) : [],
    spacing: [],
  };
};

const fromChakra = (theme: Record<string, unknown>): Palette => {
  const config = isRecord(theme._config) ? theme._config : {};
  const configTheme = isRecord(config.theme) ? config.theme : {};
  const tokens = isRecord(configTheme.tokens) ? configTheme.tokens : {};
  const colors = theme.colors ?? tokens.colors;
  const radii = theme.radii ?? tokens.radii;

  return {
    light: flatten(colors),
    dark: [],
    radius: isRecord(radii) ? flatten(radii, ['radius']) : [],
    spacing: [],
  };
};

const fromStyled = (theme: Record<string, unknown>): Palette => ({
  light: flatten(theme.colors ?? theme.palette ?? theme),
  dark: isRecord(theme.dark) ? flatten(theme.dark) : [],
  radius: isRecord(theme.radii) ? flatten(theme.radii, ['radius']) : [],
  spacing: [],
});

/** Tailwind v3: the config's own colours (resolved when its CLI is installed). */
const fromTailwindConfig = async (
  checkout: string,
  file: string
): Promise<Palette> => {
  const exported = await loadProjectModule(checkout, file);
  const config = isRecord(exported.default) ? exported.default : exported;
  const theme = isRecord(config.theme) ? config.theme : {};
  const extend = isRecord(theme.extend) ? theme.extend : {};
  const own = {
    ...(isRecord(theme.colors) ? theme.colors : {}),
    ...(isRecord(extend.colors) ? extend.colors : {}),
  };
  const resolved = (() => {
    // From the config's own folder, as Node finds a workspace package's install.
    const load = createRequire(path.resolve(checkout, file));
    const resolveConfig: unknown = (() => {
      try {
        return load('tailwindcss/resolveConfig');
      } catch (error) {
        // Tailwind not installed: the config's own colours stand.
        if (
          isRecord(error) &&
          error.code === 'MODULE_NOT_FOUND' &&
          String(error.message).includes('tailwindcss/resolveConfig')
        ) {
          return null;
        }

        throw error;
      }
    })();

    if (typeof resolveConfig !== 'function') {
      return null;
    }

    const full: unknown = resolveConfig(config);

    return isRecord(full) && isRecord(full.theme) && isRecord(full.theme.colors)
      ? full.theme.colors
      : null;
  })();
  const colors = Object.fromEntries(
    Object.keys(own).map((key) => [key, resolved?.[key] ?? own[key]])
  );
  const radius = {
    ...(isRecord(theme.borderRadius) ? theme.borderRadius : {}),
    ...(isRecord(extend.borderRadius) ? extend.borderRadius : {}),
  };

  return {
    light: flatten(colors),
    dark: [],
    radius: flatten(radius, ['radius']),
    spacing: isRecord(extend.spacing) ? flatten(extend.spacing, ['space']) : [],
  };
};

const merge = (palettes: Palette[]): Palette =>
  palettes.reduce(
    (all, one) => ({
      light: [...all.light, ...one.light],
      dark: [...all.dark, ...one.dark],
      radius: [...all.radius, ...one.radius],
      spacing: [...all.spacing, ...one.spacing],
    }),
    emptyPalette()
  );

/**
 * A theme module's palette, by its shape: MUI's `colorSchemes` (or a
 * `palette` in an MUI app), Chakra's `_config` (or `colors` in a Chakra
 * app), else a plain theme object.
 */
const themePalette = (
  exported: Record<string, unknown>,
  stack: Stack
): Palette => {
  const mui = themeObject(
    exported,
    (value) =>
      'colorSchemes' in value || (stack === 'mui' && 'palette' in value)
  );

  if (mui !== null) {
    return fromMui(mui);
  }

  const chakra = themeObject(
    exported,
    (value) => '_config' in value || (stack === 'chakra' && 'colors' in value)
  );

  if (chakra !== null) {
    return fromChakra(chakra);
  }

  const plain = themeObject(exported, () => true);

  return plain === null ? emptyPalette() : fromStyled(plain);
};

/** Read the theme files of a stack into a palette. */
export const readPalette = async ({
  checkout,
  stack,
  theme,
}: {
  checkout: string;
  stack: Stack;
  theme: string[];
}): Promise<Palette> => {
  const sheets = theme.filter((file) => file.endsWith('.css'));
  const modules = theme.filter((file) => !file.endsWith('.css'));
  const css = fromVariables(
    cssVariables(sheets.map((file) => readText(checkout, file)).join('\n'))
  );

  // Each file by what it is, not by the first stack found: a project can
  // match two (a Tailwind config beside a styled-components theme).
  const fromModules = await Promise.all(
    modules.map(async (file): Promise<Palette> => {
      if (/(^|\/)tailwind\.config\./.test(file)) {
        return fromTailwindConfig(checkout, file);
      }

      const exported = await loadProjectModule(checkout, file);
      const palette = themePalette(exported, stack);

      if (palette.light.length === 0 && palette.dark.length === 0) {
        throw new Error(
          `${file} is a theme file, but no colours could be read from what it exports.`
        );
      }

      return palette;
    })
  );

  return merge([...fromModules, css]);
};

const sizeTokens = (list: [string, string][], prefix: string): Token[] =>
  Array.from(new Map(list.map(([name, value]) => [name, value])).entries()).map(
    ([name, value]) => ({
      name: tokenName(name.startsWith(prefix) ? name : `${prefix}-${name}`),
      value,
    })
  );

/** Every rule tokens.json has to keep; throws naming the token. */
export const checkTokens = (tokens: TokensJson): void => {
  // A committed tokens.photos.json is read as it is: check its shape first.
  const groups: [string, unknown, string[]][] = [
    ['color', tokens.color, ['themes', 'tokens']],
    ['spacing', tokens.spacing, ['tokens']],
    ['radius', tokens.radius, ['tokens']],
  ];
  groups.forEach(([field, group, lists]) => {
    if (
      !isRecord(group) ||
      !lists.every((list) => Array.isArray(group[list]))
    ) {
      throw new Error(
        `tokens.json: ${field} must hold ${lists.join(' and ')} (lists).`
      );
    }
  });

  const ids = tokens.color.themes.map(({ id }) => id).join(',');

  if (ids !== 'light,dark') {
    throw new Error(
      `tokens.json: color.themes must be light then dark, not ${ids || 'none'}.`
    );
  }

  const { meta } = tokens;

  if (
    meta === undefined ||
    typeof meta.source !== 'string' ||
    meta.source === '' ||
    typeof meta.ref !== 'string' ||
    meta.ref === '' ||
    typeof meta.components !== 'object' ||
    meta.components === null
  ) {
    throw new Error(
      'tokens.json: meta must hold source, ref and components (each component → its source file).'
    );
  }

  const unnamed = Object.entries(meta.components).find(
    ([, file]) => typeof file !== 'string' || file === ''
  );

  if (unnamed !== undefined) {
    throw new Error(
      `tokens.json: meta.components.${unnamed[0]} must name its source file.`
    );
  }

  const all = [
    ...tokens.color.tokens,
    ...tokens.spacing.tokens,
    ...tokens.radius.tokens,
  ];
  const names = all.map(({ name }) => name);
  const colourNames = new Set(tokens.color.tokens.map(({ name }) => name));

  names.forEach((name, index) => {
    if (!TOKEN_NAME.test(name)) {
      throw new Error(
        `tokens.json: the token name ${JSON.stringify(
          name
        )} must match ${TOKEN_NAME}.`
      );
    }

    if (names.indexOf(name) !== index) {
      throw new Error(`tokens.json: two tokens are named ${name}.`);
    }
  });

  const valueIn = (value: TokenValue, theme: string): string | undefined =>
    typeof value === 'string'
      ? value
      : Object.entries(value).find(([id]) => id === theme)?.[1];
  const byName = new Map(
    tokens.color.tokens.map(({ name, value }) => [name, value])
  );
  /** The aliases followed from `{first}` until a colour, or until one repeats. */
  const loopFrom = (
    name: string,
    theme: string,
    first: string
  ): string[] | null => {
    const step = (chain: string[]): string[] | null => {
      const at = chain.at(-1) ?? '';

      if (at === name || chain.indexOf(at) !== chain.length - 1) {
        return chain;
      }

      const next = ALIAS.exec(valueIn(byName.get(at) ?? '', theme) ?? '')?.[1];

      return next === undefined || !colourNames.has(next)
        ? null
        : step([...chain, next]);
    };

    return step([first]);
  };

  tokens.color.tokens.forEach(({ name, value }) => {
    const values =
      typeof value === 'string'
        ? [['light', value] as const]
        : Object.entries(value);

    values.forEach(([theme, one]) => {
      const alias = ALIAS.exec(one ?? '');

      if (alias !== null) {
        if (!colourNames.has(alias[1] ?? '')) {
          throw new Error(
            `tokens.json: ${name} is an alias of {${alias[1]}}, which is not a token.`
          );
        }

        const loop = loopFrom(name, theme, alias[1] ?? '');

        if (loop !== null) {
          throw new Error(
            `tokens.json: ${name} is an alias that never reaches a colour: ${loop
              .map((one) => `{${one}}`)
              .join(' → ')}.`
          );
        }

        return;
      }

      if (
        !HEX.test(one ?? '') &&
        !RGB.test(one ?? '') &&
        !OKLCH.test(one ?? '')
      ) {
        throw new Error(
          `tokens.json: ${name} is ${JSON.stringify(
            one
          )}, not a hex, rgb() or oklch() colour or an {alias}.`
        );
      }
    });
  });
};

/**
 * `tokens.json` for a design system: the theme files read, made into tokens
 * and checked. `ref` is the short sha of the commit built; `components`
 * maps each component to its source file.
 */
export const deriveTokens = async ({
  checkout,
  stack,
  theme,
  title,
  ref,
  components,
}: {
  checkout: string;
  stack: Stack;
  theme: string[];
  title: string;
  ref: string;
  components: Record<string, string>;
}): Promise<{ tokens: TokensJson; skipped: SkippedToken[] }> => {
  const palette = await readPalette({ checkout, stack, theme });
  const { tokens: colours, skipped } = paletteTokens(palette);
  const tokens: TokensJson = {
    name: title,
    version: 1,
    color: { themes: THEMES, tokens: colours },
    spacing: { tokens: sizeTokens(palette.spacing, 'space') },
    radius: { tokens: sizeTokens(palette.radius, 'radius') },
    meta: { source: stack, ref, components },
  };
  checkTokens(tokens);

  return { tokens, skipped };
};
