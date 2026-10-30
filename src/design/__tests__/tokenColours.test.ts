import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  colourWarnings,
  nearestToken,
  readTokenColours,
  toHex,
} from '../tokenColours';
import { walkPrototype } from '../walk';
import { makeCanvas, tmp, useFixtureRuntime, writeFile } from './canvasFixture';
import { runDesign } from './runDesign';

/** The walk's nudge about hand-written colours that are not the design system's. */

const tokensFile = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-tokens-'));
  const file = path.join(dir, 'tokens.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      color: {
        tokens: [
          {
            name: 'stone-100',
            value: { light: '#f5f5f4', dark: '#1c1917' },
          },
          { name: 'primary-500', value: '#3b82f6' },
          { name: 'broken', value: 'var(--x)' },
        ],
      },
    })
  );

  return file;
};

describe('readTokenColours', () => {
  it('reads every hex token, light and dark, lower-cased', () => {
    expect(readTokenColours(tokensFile())).toEqual([
      { name: 'stone-100', hex: '#f5f5f4' },
      { name: 'stone-100', hex: '#1c1917' },
      { name: 'primary-500', hex: '#3b82f6' },
    ]);
  });
});

describe('toHex', () => {
  it('turns an opaque computed colour into hex', () => {
    expect(toHex('rgb(12, 10, 9)')).toBe('#0c0a09');
    expect(toHex('rgba(59, 130, 246, 1)')).toBe('#3b82f6');
  });

  it('ignores a see-through colour and anything else', () => {
    expect(toHex('rgba(0, 0, 0, 0)')).toBeNull();
    expect(toHex('transparent')).toBeNull();
  });
});

describe('nearestToken and colourWarnings', () => {
  it('names the closest token in the warning', () => {
    const tokens = readTokenColours(tokensFile());
    const nearest = nearestToken('#f6f6f5', tokens);

    expect(nearest).toEqual({ name: 'stone-100', hex: '#f5f5f4' });
    expect(
      colourWarnings([
        { colour: '#f6f6f5', where: ['div "Next inspection"'], nearest },
      ])
    ).toEqual([
      `Colour #f6f6f5 is not one of the design system's tokens (nearest: stone-100 #f5f5f4): div "Next inspection". Use the token, or a component that draws it.`,
    ]);
  });
});

describe('the walk names colours that are not tokens', () => {
  // Real Chromium: a cold launch is slower than Jest's 5 s default.
  jest.setTimeout(60_000);

  const fixture = { restore: () => {} };

  beforeAll(() => {
    fixture.restore = useFixtureRuntime().restore;
  });

  afterAll(() => fixture.restore());

  /** A one-situation prototype whose screen hand-writes #3b82f7. */
  const canvas = (tokens: boolean): string => {
    const dir = makeCanvas({
      artboard: 'Prototype.dc.html',
      body: [
        '<div data-screen="" style="width: 300px; height: 160px; background: #ffffff">',
        '<p style="color: #3b82f7">Pawnee Parks: Lot 48</p>',
        '</div>',
        '<button data-state="open">open</button>',
      ].join(''),
    });

    if (tokens) {
      writeFile(
        path.join(dir, 'project', 'ds', 'pawnee', 'tokens.json'),
        JSON.stringify({
          color: { tokens: [{ name: 'parks-blue', value: '#3b82f6' }] },
        })
      );
    }

    return dir;
  };

  const brief = (): string => {
    const file = path.join(tmp('lambda-design-brief-'), 'brief.json');
    writeFile(
      file,
      JSON.stringify({
        situations: [{ slug: 'open', title: 'Open' }],
        path: [],
      })
    );

    return file;
  };

  const walk = async (tokens: boolean): Promise<string[]> => {
    const logged: { lines: string[] } = { lines: [] };
    await walkPrototype({
      canvasDir: canvas(tokens),
      artboard: 'Prototype.dc.html',
      briefFile: brief(),
      outDir: tmp('lambda-design-walk-'),
      log: (line) => {
        logged.lines = [...logged.lines, line];
      },
    });

    return logged.lines;
  };

  it('warns once, naming the nearest token, and still succeeds', async () => {
    expect(await walk(true)).toEqual([
      `Colour #3b82f7 is not one of the design system's tokens (nearest: parks-blue #3b82f6): p "Pawnee Parks: Lot 48". Use the token, or a component that draws it.`,
    ]);
  });

  it('lambda design walk exits 0 with the warning on stderr', async () => {
    const stderr = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    try {
      const result = await runDesign([
        'walk',
        canvas(true),
        'Prototype.dc.html',
        '--brief',
        brief(),
        '--out-dir',
        tmp('lambda-design-walk-'),
      ]);

      expect(result.code).toBe(0);
      expect(stderr.mock.calls.map(([text]) => String(text)).join('')).toMatch(
        /^Colour #3b82f7 is not one of the design system's tokens \(nearest: parks-blue #3b82f6\)/
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it('says nothing with no design system installed', async () => {
    expect(await walk(false)).toEqual([]);
  });
});
