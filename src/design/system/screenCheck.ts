import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type OpenArtboard, withArtboard } from '../render';
import { type ReferenceScreen, SCREENS_DIR, SCREENS_PAGE } from './assemble';
import { readyRelease, writeCheckCanvas } from './checkCanvas';
import { installSystem } from './install';

/**
 * The reference screens, checked at every build. A screen a design copies
 * has to work, so each is opened on a canvas laid out exactly as an
 * installed copy sits — the screen at the top, the system in
 * `ds/<namespace>/` below — and the build fails when any of them:
 *
 *   - throws, or fails to load a script or stylesheet;
 *   - lacks one `[data-screen]`, a `[data-state]` for a situation, or a
 *     `[data-target]` its path clicks;
 *   - is taller or wider than its window in any situation (the page scrolls
 *     inside the app's frame, never the window).
 *
 * Then it writes `Screens.md`, the system's Screens page: each screen's
 * first situation as a small JPEG `data:` URI with its title, route,
 * summary and situations, the page at most 200 KB.
 */

export const DESKTOP = { w: 1440, h: 900 };
export const PHONE = { w: 390, h: 844 };

export const screenSize = ({
  phone,
}: Pick<ReferenceScreen, 'phone'>): { w: number; h: number } =>
  phone === true ? PHONE : DESKTOP;

const MAX_PAGE_BYTES = 200 * 1024;
const PICTURE_SCALE = 0.4;
const PICTURE_QUALITY = 70;

const OVERFLOW = `(() => {
  const doc = document.scrollingElement || document.documentElement;
  return { x: doc.scrollWidth - window.innerWidth, y: doc.scrollHeight - window.innerHeight };
})()`;

const isOverflow = (value: unknown): value is { x: number; y: number } =>
  typeof value === 'object' &&
  value !== null &&
  'x' in value &&
  typeof value.x === 'number' &&
  'y' in value &&
  typeof value.y === 'number';

const clickOne = async (
  { page, settle }: OpenArtboard,
  selector: string
): Promise<void> => {
  const control = page.locator(selector);

  if ((await control.count()) === 0) {
    throw new Error(`it has no ${selector}`);
  }

  await control.first().click({ timeout: 5_000 });
  await settle();
};

const assertOneWindow = async ({ page }: OpenArtboard): Promise<void> => {
  const screens = page.locator('[data-screen]');
  const count = await screens.count();

  if (count !== 1) {
    throw new Error(`it needs exactly one [data-screen], not ${count}`);
  }

  // The screen spans the window's width: a narrower one was drawn for
  // another window.
  const box = await screens.first().boundingBox();
  const viewport = page.viewportSize();

  if (
    box !== null &&
    viewport !== null &&
    Math.abs(box.width - viewport.width) > 1
  ) {
    throw new Error(
      `its [data-screen] is ${Math.round(
        box.width
      )}px wide, not one window of ${viewport.width}×${viewport.height}`
    );
  }

  // …and reaches the window's bottom: a shorter one was drawn for another
  // window too. (A bar above it, like the situation switch, may take its top;
  // a taller one makes the window scroll, refused below.)
  if (
    box !== null &&
    viewport !== null &&
    viewport.height - (box.y + box.height) > 1
  ) {
    throw new Error(
      `its [data-screen] ends ${Math.round(
        box.y + box.height
      )}px down, not at the bottom of one window of ${viewport.width}×${
        viewport.height
      }`
    );
  }

  const overflow: unknown = await page.evaluate(OVERFLOW);

  if (!isOverflow(overflow)) {
    throw new Error('could not measure the window');
  }

  if (overflow.y > 1 || overflow.x > 1) {
    throw new Error(
      `the window scrolls (${Math.max(0, overflow.x)}px across, ${Math.max(
        0,
        overflow.y
      )}px down): the page must scroll inside the app's frame, never the window`
    );
  }
};

const naming = async <T>(
  label: string,
  action: () => Promise<T>
): Promise<T> => {
  try {
    return await action();
  } catch (error) {
    throw new Error(
      `${label}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

const checkScreen = (
  canvasDir: string,
  screen: ReferenceScreen,
  log: (line: string) => void
): Promise<Buffer> =>
  withArtboard(
    { canvasDir, artboard: screen.file, scale: PICTURE_SCALE, log },
    async ({ open }) => {
      const [opening] = screen.situations;

      if (opening === undefined) {
        throw new Error(`${screen.file} lists no situations.`);
      }

      const pictures = await screen.situations.reduce<Promise<Buffer[]>>(
        async (taken, { slug }) => {
          const done = await taken;

          return naming(`${screen.file}, situation ${slug}`, async () => {
            const loaded = await open();
            await clickOne(loaded, `[data-state="${slug}"]`);
            await assertOneWindow(loaded);
            const picture = await loaded.page.screenshot({
              type: 'jpeg',
              quality: PICTURE_QUALITY,
              scale: 'device',
            });
            await loaded.page.close();

            return [...done, picture];
          });
        },
        Promise.resolve([])
      );

      const walking = await naming(`${screen.file}`, open);
      await clickOne(walking, `[data-state="${opening.slug}"]`);
      await screen.path.reduce<Promise<void>>(
        async (before, { step, action }) => {
          await before;
          await naming(`${screen.file}, step "${step}"`, async () => {
            const [kind, target] = action.split(' ');

            if (
              target === undefined ||
              (kind !== 'click' && kind !== 'state')
            ) {
              throw new Error(
                `"${action}" is not click <target> or state <slug>`
              );
            }

            await clickOne(
              walking,
              kind === 'click'
                ? `[data-target="${target}"]`
                : `[data-state="${target}"]`
            );
            await assertOneWindow(walking);
          });
        },
        Promise.resolve()
      );
      await walking.page.close();

      const [first] = pictures;

      if (first === undefined) {
        throw new Error(`${screen.file} took no picture.`);
      }

      return first;
    }
  );

/** `Screens.md`: the Screens page of the system. */
export const screensPage = (
  title: string,
  screens: { screen: ReferenceScreen; picture: Buffer }[]
): string =>
  [
    '# Screens',
    '',
    `${title}'s real pages, redrawn from this system's components and its sample data (\`sample-data.js\`). Each is one window, 1440×900 (390×844 for a phone), with its situations switchable. To design a change, copy the closest one and change only what the design changes.`,
    '',
    ...screens.flatMap(({ screen, picture }) => [
      `## ${screen.title}`,
      '',
      screen.summary,
      '',
      `![${screen.title}](data:image/jpeg;base64,${picture.toString(
        'base64'
      )})`,
      '',
      `- File: \`screens/${screen.file}\`, the app's \`${screen.route}\`${
        screen.phone === true ? ', on a phone' : ''
      }`,
      `- Situations: ${screen.situations
        .map(({ slug, title: name }) => `${name} (\`${slug}\`)`)
        .join(', ')}`,
      '',
    ]),
  ].join('\n');

/**
 * Check every reference screen of a built folder (`<out>/project/…`) and
 * write its Screens page. Throws naming the screen and what failed.
 */
export const checkScreens = async ({
  out,
  title,
  namespace,
  screens,
  log = (line) => process.stderr.write(`${line}\n`),
}: {
  out: string;
  title: string;
  namespace: string;
  screens: ReferenceScreen[];
  log?: (line: string) => void;
}): Promise<{ page: string; bytes: number }> => {
  const canvasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-screens-'));
  const project = path.join(canvasDir, 'project');

  try {
    installSystem({ builtDir: out, canvasDir, namespace });
    screens.forEach((screen) =>
      fs.copyFileSync(
        path.join(out, SCREENS_DIR, screen.file),
        path.join(project, screen.file)
      )
    );
    writeCheckCanvas({
      canvasDir,
      release: readyRelease('the reference screens cannot be checked'),
      boards: screens.map((screen) => ({
        file: screen.file,
        ...screenSize(screen),
      })),
    });

    const shot = await screens.reduce<
      Promise<{ screen: ReferenceScreen; picture: Buffer }[]>
    >(async (taken, screen) => {
      const done = await taken;

      return [
        ...done,
        { screen, picture: await checkScreen(canvasDir, screen, log) },
      ];
    }, Promise.resolve([]));
    const page = screensPage(title, shot);
    const bytes = Buffer.byteLength(page);

    if (bytes > MAX_PAGE_BYTES) {
      throw new Error(
        `Screens.md would be ${Math.round(
          bytes / 1024
        )} KB; a page of the system holds 200 KB. Have fewer reference screens.`
      );
    }

    const file = path.join(out, SCREENS_PAGE);
    fs.writeFileSync(file, page);

    return { page: file, bytes };
  } finally {
    fs.rmSync(canvasDir, { recursive: true, force: true });
  }
};
