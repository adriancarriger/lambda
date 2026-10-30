import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chromium } from 'playwright';

import {
  COMPOSITE_GUTTER,
  COMPOSITE_LABEL_BAND,
  composeExpectedActual,
  pngSize,
} from '../composite';
import { writePng } from './pngFixture';

/**
 * Expected | actual in one PNG, drawn in a Playwright page: nothing resized,
 * a 48px label band above, a 24px gutter between, and never doubled by a
 * retina scale.
 */

jest.setTimeout(60_000);

const dir = { path: '' };

beforeEach(() => {
  dir.path = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-composite-'));
});

afterEach(() => {
  fs.rmSync(dir.path, { recursive: true, force: true });
});

const file = (name: string): string => path.join(dir.path, name);

const WHITE: [number, number, number] = [255, 255, 255];

/** RGB at each `[x, y]` of a PNG, read back through a canvas. */
const pixelsAt = async (
  png: string,
  points: Array<[number, number]>
): Promise<Array<[number, number, number]>> => {
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage();

    return await page.evaluate(
      async ({ src, at }) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const context = canvas.getContext('2d');

        if (context === null) {
          throw new Error('No 2d canvas.');
        }

        context.drawImage(img, 0, 0);

        return at.map(([x, y]): [number, number, number] => {
          const [r = -1, g = -1, b = -1] = context.getImageData(
            x,
            y,
            1,
            1
          ).data;

          return [r, g, b];
        });
      },
      {
        src: `data:image/png;base64,${fs.readFileSync(png).toString('base64')}`,
        at: points,
      }
    );
  } finally {
    await browser.close();
  }
};

describe('composeExpectedActual', () => {
  it('lays two real PNGs side by side: 300×200 and 320×240 make 644×288', async () => {
    const expected = writePng(file('expected.png'), 300, 200);
    const actual = writePng(file('actual.png'), 320, 240, [40, 40, 200]);

    await composeExpectedActual({ expected, actual, out: file('out.png') });

    expect(COMPOSITE_GUTTER).toBe(24);
    expect(COMPOSITE_LABEL_BAND).toBe(48);
    // Read back from the PNG's own IHDR: a scale of 2 would double both.
    expect(pngSize(file('out.png'))).toEqual({ width: 644, height: 288 });
  });

  it('is the same 644×288 on a machine whose default scale factor is 2', async () => {
    // Every page this browser opens defaults to a scale of 2, as a retina
    // machine's would; only an explicit deviceScaleFactor overrides it.
    const realLaunch = chromium.launch.bind(chromium);
    const launch = jest
      .spyOn(chromium, 'launch')
      .mockImplementation(async (options) => {
        const browser = await realLaunch(options);
        const newPage = browser.newPage.bind(browser);
        jest
          .spyOn(browser, 'newPage')
          .mockImplementation((pageOptions) =>
            newPage({ deviceScaleFactor: 2, ...pageOptions })
          );

        return browser;
      });

    try {
      const expected = writePng(file('expected.png'), 300, 200);
      const actual = writePng(file('actual.png'), 320, 240, [40, 40, 200]);

      await composeExpectedActual({ expected, actual, out: file('out.png') });

      expect(launch).toHaveBeenCalled();
      expect(pngSize(file('out.png'))).toEqual({ width: 644, height: 288 });
    } finally {
      launch.mockRestore();
    }
  });

  it('resizes neither a desktop board nor a phone photo', async () => {
    const red: [number, number, number] = [200, 40, 40];
    const blue: [number, number, number] = [40, 40, 200];
    const expected = writePng(file('desktop.png'), 1440, 900, red);
    const actual = writePng(file('phone.png'), 390, 844, blue);

    await composeExpectedActual({ expected, actual, out: file('out.png') });

    expect(pngSize(file('out.png'))).toEqual({
      width: 1440 + COMPOSITE_GUTTER + 390,
      height: COMPOSITE_LABEL_BAND + 900,
    });
    // Each picture's own corners, the gutter, and the white under the phone:
    // only an unresized pair puts every one of them here.
    const right = 1440 + COMPOSITE_GUTTER;
    const band = COMPOSITE_LABEL_BAND;
    expect(
      await pixelsAt(file('out.png'), [
        [0, band],
        [1439, band + 899],
        [1440, band + 400],
        [right - 1, band + 400],
        [right, band],
        [right + 389, band + 843],
        [right + 389, band + 844],
      ])
    ).toEqual([red, red, WHITE, WHITE, blue, blue, WHITE]);
  });

  it('refuses a picture that isn’t a PNG, naming it', async () => {
    const expected = writePng(file('expected.png'), 10, 10);
    fs.writeFileSync(file('actual.png'), 'not a png');

    await expect(
      composeExpectedActual({
        expected,
        actual: file('actual.png'),
        out: file('out.png'),
      })
    ).rejects.toThrow(/actual\.png isn't a PNG/);
    expect(fs.existsSync(file('out.png'))).toBe(false);
  });
});
