import * as fs from 'fs';
import * as path from 'path';
import { type Page } from 'playwright';

/**
 * A nudge, never a failure: colours a prototype wrote itself that are not the
 * design system's. Components take their colours from the theme, so only
 * inline `style` attributes inside `[data-screen]` are read — what the
 * prototype hand-wrote. Each colour that matches no token in the canvas's
 * installed copy of `ds/<namespace>/tokens.json` (light or dark) is named with
 * the nearest token, which is almost always what was meant. With no design
 * system installed there are no tokens, and nothing is said.
 */

export interface TokenColour {
  name: string;
  hex: string;
}

export interface UntokenedColour {
  colour: string;
  /** Up to three elements that use it, by tag and their text. */
  where: string[];
  nearest: TokenColour | null;
}

const HEX = /^#[0-9a-f]{6}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every hex colour token in a system's `tokens.json`, light and dark. */
export const readTokenColours = (tokensFile: string): TokenColour[] => {
  const parsed: unknown = JSON.parse(fs.readFileSync(tokensFile, 'utf8'));
  const color = isRecord(parsed) ? parsed.color : undefined;
  const tokens = isRecord(color) ? color.tokens : undefined;

  return (Array.isArray(tokens) ? tokens : []).flatMap((token: unknown) => {
    if (!isRecord(token) || typeof token.name !== 'string') {
      return [];
    }

    const { name, value } = token;
    const values =
      typeof value === 'string'
        ? [value]
        : isRecord(value)
        ? Object.values(value)
        : [];

    return values.flatMap((hex) =>
      typeof hex === 'string' && HEX.test(hex)
        ? [{ name, hex: hex.toLowerCase() }]
        : []
    );
  });
};

/** `rgb(12, 10, 9)` / `rgba(…, 1)` → `#0c0a09`; null for anything else or a see-through one. */
export const toHex = (css: string): string | null => {
  const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(
    css.trim()
  );

  if (match === null || (match[4] !== undefined && Number(match[4]) < 1)) {
    return null;
  }

  return `#${[match[1], match[2], match[3]]
    .map((part) => Number(part).toString(16).padStart(2, '0'))
    .join('')}`;
};

const channels = (hex: string): number[] =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** The token closest to `hex` by RGB distance. */
export const nearestToken = (
  hex: string,
  tokens: TokenColour[]
): TokenColour | null =>
  tokens.reduce<{ token: TokenColour | null; distance: number }>(
    (best, token) => {
      const distance = channels(hex).reduce(
        (sum, value, i) => sum + (value - (channels(token.hex)[i] ?? 0)) ** 2,
        0
      );

      return distance < best.distance ? { token, distance } : best;
    },
    { token: null, distance: Infinity }
  ).token;

// Browser-side: the inline-styled elements in [data-screen] and the colours
// their styles set, as the browser computed them.
const INLINE_COLOURS = `(() => {
  const screen = document.querySelector('[data-screen]');
  if (!screen) return [];
  const props = ['color', 'background-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'];
  return Array.from(screen.querySelectorAll('[style]')).flatMap((el) => {
    const style = el.getAttribute('style') || '';
    if (!/(color|background|border)/i.test(style)) return [];
    const computed = getComputedStyle(el);
    const label = el.tagName.toLowerCase() + ' "' + (el.textContent || '').trim().slice(0, 30) + '"';
    return props
      .filter((prop) => el.style.getPropertyValue(prop) !== '')
      .map((prop) => ({ colour: computed.getPropertyValue(prop), label }));
  });
})()`;

const isUse = (value: unknown): value is { colour: string; label: string } =>
  isRecord(value) &&
  typeof value.colour === 'string' &&
  typeof value.label === 'string';

/** The colours a loaded prototype hand-wrote that are not tokens. */
export const untokenedColours = async (
  page: Page,
  tokens: TokenColour[]
): Promise<UntokenedColour[]> => {
  const uses: unknown = await page.evaluate(INLINE_COLOURS);
  const known = new Set(tokens.map(({ hex }) => hex));
  const byColour = (Array.isArray(uses) ? uses.filter(isUse) : []).reduce<
    Map<string, string[]>
  >((found, { colour, label }) => {
    const hex = toHex(colour);

    if (
      hex === null ||
      known.has(hex) ||
      hex === '#ffffff' ||
      hex === '#000000'
    ) {
      return found;
    }

    const where = found.get(hex) ?? [];

    return new Map(found).set(
      hex,
      where.includes(label) ? where : [...where, label]
    );
  }, new Map());

  return Array.from(byColour.entries()).map(([colour, where]) => ({
    colour,
    where: where.slice(0, 3),
    nearest: nearestToken(colour, tokens),
  }));
};

/**
 * The tokens of every design system installed on the canvas
 * (`project/ds/<namespace>/tokens.json`, whatever the namespace); empty when
 * none is.
 */
export const canvasTokenColours = (canvasDir: string): TokenColour[] => {
  const ds = path.join(canvasDir, 'project', 'ds');

  return !fs.existsSync(ds)
    ? []
    : fs
        .readdirSync(ds, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(ds, entry.name, 'tokens.json'))
        .sort()
        .flatMap((file) => (fs.existsSync(file) ? readTokenColours(file) : []));
};

/** One warning line per colour. */
export const colourWarnings = (found: UntokenedColour[]): string[] =>
  found.map(
    ({ colour, where, nearest }) =>
      `Colour ${colour} is not one of the design system's tokens${
        nearest === null ? '' : ` (nearest: ${nearest.name} ${nearest.hex})`
      }: ${where.join(', ')}. Use the token, or a component that draws it.`
  );
