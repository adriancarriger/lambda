/**
 * Expected | actual, side by side in one sharp PNG: what a ticket comment
 * and a Blocked item show for each picture the build's visual check left
 * differing from its design. Neither image is resized: a difference is only
 * visible at the size the judge saw it.
 *
 * Drawn in a Playwright page (Lambda carries Playwright, not an image
 * library) at a device scale of 1, its viewport exactly the composite's size,
 * so a retina default can never double the PNG.
 */
import * as fs from 'fs';
import { chromium } from 'playwright';

/** Space between the two pictures. */
export const COMPOSITE_GUTTER = 24;

/** The band above the pictures that holds the two labels ("Expected" / "Actual" by default). */
export const COMPOSITE_LABEL_BAND = 48;

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** A PNG's size, from its IHDR chunk; throws on a file that isn't a PNG. */
export const pngSize = (file: string): { width: number; height: number } => {
  const bytes = fs.readFileSync(file);

  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw new Error(`${file} isn't a PNG, so its size can't be read.`);
  }

  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

const label = (text: string, x: number): string =>
  `<div style="position:absolute;left:${
    x + 4
  }px;top:6px;font:bold 24px/32px Helvetica, Arial, sans-serif;color:#111111;white-space:nowrap">${text}</div>`;

/** An `<img>`, so the page's load waits for it to decode. */
const image = (
  file: string,
  size: { width: number; height: number },
  x: number
): string =>
  `<img src="data:image/png;base64,${fs
    .readFileSync(file)
    .toString(
      'base64'
    )}" style="position:absolute;left:${x}px;top:${COMPOSITE_LABEL_BAND}px;width:${
    size.width
  }px;height:${size.height}px;display:block" alt="" />`;

export const composeExpectedActual = async ({
  expected,
  actual,
  out,
  labels = { left: 'Expected', right: 'Actual' },
}: {
  expected: string;
  actual: string;
  out: string;
  /** The words over the left and right pictures. */
  labels?: { left: string; right: string };
}): Promise<void> => {
  const left = pngSize(expected);
  const right = pngSize(actual);
  const width = left.width + COMPOSITE_GUTTER + right.width;
  const height = COMPOSITE_LABEL_BAND + Math.max(left.height, right.height);
  const rightX = left.width + COMPOSITE_GUTTER;
  const body = [
    label(labels.left, 0),
    label(labels.right, rightX),
    image(expected, left, 0),
    image(actual, right, rightX),
  ].join('');
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    // `load` waits for both images.
    await page.setContent(
      `<!doctype html><html><body style="margin:0;width:${width}px;height:${height}px;position:relative;overflow:hidden;background:#ffffff">${body}</body></html>`,
      { waitUntil: 'load' }
    );
    await page.screenshot({
      path: out,
      clip: { x: 0, y: 0, width, height },
      omitBackground: false,
    });
  } finally {
    await browser.close();
  }
};
