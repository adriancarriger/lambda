import * as fs from 'fs';
import * as path from 'path';
import { type Page } from 'playwright';

import { type WalkPath, parseWalkPath } from './loop';
import { BADGE_SIZE, type MarkBox, layoutMarks, parseMarks } from './marks';
import {
  type ArtboardOptions,
  type OpenArtboard,
  withArtboard,
} from './render';
import { assertScreenDir } from './screenDir';
import {
  type UntokenedColour,
  canvasTokenColours,
  colourWarnings,
  untokenedColours,
} from './tokenColours';

/**
 * `lambda design walk` — photograph a screen's prototype.
 *
 * A prototype artboard puts the screen in one `[data-screen]` root; beside
 * it, outside that root so it never shows, an in-page state switch with one
 * `[data-state="<situation>"]` control per situation. Each path `click`
 * target carries `data-target="<target>"`, and callouts carry `data-mark`.
 *
 * A round walk: one load, switched to the first situation, then `step-<n>.png`
 * after each path step in order; then a fresh load per situation, switched to
 * it, as `<situation>.png`. `--stills`: per situation, from one load, the
 * plain `<situation>.png`, `<situation>.annotated.png` (numbered badges and a
 * legend strip under the screen) and `<situation>.legend.json`.
 *
 * Every failure names the step or situation it happened in.
 */

const SCREEN = '[data-screen]';
const ANNOTATION = '[data-lambda-annotation]';

const readBrief = (briefFile: string): WalkPath =>
  parseWalkPath(JSON.parse(fs.readFileSync(briefFile, 'utf8')));

/** Run `action`, prefixing any error with `label`. */
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

const click = async (
  { page, settle }: OpenArtboard,
  selector: string
): Promise<void> => {
  const control = page.locator(selector);

  if ((await control.count()) === 0) {
    throw new Error(`the prototype has no ${selector}`);
  }

  await control.first().click({ timeout: 5_000 });
  await settle();
};

/** The single `[data-screen]` element's page box; throws on none, two or zero size. */
const screenBox = async (
  page: Page
): Promise<{ x: number; y: number; width: number; height: number }> => {
  const screen = page.locator(SCREEN);
  const count = await screen.count();

  if (count !== 1) {
    throw new Error(
      `the prototype needs exactly one ${SCREEN} element, not ${count}`
    );
  }

  const box = await screen.boundingBox();

  if (box === null || !(box.width > 0 && box.height > 0)) {
    throw new Error(
      `${SCREEN} has a zero-size box (${box?.width ?? 0}×${box?.height ?? 0})`
    );
  }

  return box;
};

const shoot = async (
  { page, check }: OpenArtboard,
  file: string
): Promise<string> => {
  await screenBox(page);
  await page.locator(SCREEN).screenshot({ path: file });
  check();

  return file;
};

const openIn = async (
  open: () => Promise<OpenArtboard>,
  state: string
): Promise<OpenArtboard> => {
  const loaded = await open();
  await click(loaded, `[data-state="${state}"]`);

  return loaded;
};

export interface WalkOptions extends Omit<ArtboardOptions, 'scale'> {
  briefFile: string;
  outDir: string;
}

/** A round's walk. Returns the files written, in order. */
export const walkPrototype = async (
  options: WalkOptions
): Promise<string[]> => {
  // parseWalkPath refuses a brief with no situations, so states[0] exists.
  const { steps, states } = readBrief(options.briefFile);
  const [opening] = states;

  fs.mkdirSync(options.outDir, { recursive: true });
  const tokens = canvasTokenColours(options.canvasDir);
  const log = options.log ?? ((line) => process.stderr.write(`${line}\n`));

  return withArtboard(options, async ({ open }) => {
    const walking = await naming(`Opening state ${opening}`, () =>
      openIn(open, opening)
    );
    const stepFiles = await steps.reduce<Promise<string[]>>(
      async (written, { n, step, action }) => {
        const done = await written;

        return naming(`Step ${n} (${step})`, async () => {
          await click(
            walking,
            action.kind === 'click'
              ? `[data-target="${action.target}"]`
              : `[data-state="${action.slug}"]`
          );

          return [
            ...done,
            await shoot(walking, path.join(options.outDir, `step-${n}.png`)),
          ];
        });
      },
      Promise.resolve([])
    );
    await walking.page.close();

    const shot = await states.reduce<
      Promise<{ files: string[]; colours: UntokenedColour[] }>
    >(async (written, slug) => {
      const done = await written;

      return naming(`Situation ${slug}`, async () => {
        const loaded = await openIn(open, slug);
        const file = await shoot(
          loaded,
          path.join(options.outDir, `${slug}.png`)
        );
        const colours =
          tokens.length === 0
            ? []
            : await untokenedColours(loaded.page, tokens);
        await loaded.page.close();

        return {
          files: [...done.files, file],
          colours: [
            ...done.colours,
            ...colours.filter(
              ({ colour }) =>
                !done.colours.some((seen) => seen.colour === colour)
            ),
          ],
        };
      });
    }, Promise.resolve({ files: [], colours: [] }));

    // A nudge, not a failure: hand-written colours that are not tokens.
    colourWarnings(shot.colours).forEach(log);

    return [...stepFiles, ...shot.files];
  });
};

// Browser-side code is passed as strings, so it never needs the DOM lib.
const MEASURE = `(() => {
  const screen = document.querySelector('${SCREEN}');
  const s = screen.getBoundingClientRect();
  return {
    width: s.width,
    height: s.height,
    boxes: Array.from(screen.querySelectorAll('[data-mark]')).map((el) => {
      const r = el.getBoundingClientRect();
      return { mark: el.getAttribute('data-mark') || '', x: r.left - s.left, y: r.top - s.top, width: r.width, height: r.height };
    }),
  };
})()`;

const isMarkBox = (value: unknown): value is MarkBox =>
  typeof value === 'object' &&
  value !== null &&
  'mark' in value &&
  typeof value.mark === 'string' &&
  ['x', 'y', 'width', 'height'].every(
    (key) =>
      key in value &&
      typeof Object.entries(value).find(([name]) => name === key)?.[1] ===
        'number'
  );

const measure = async (
  page: Page
): Promise<{ width: number; height: number; boxes: MarkBox[] }> => {
  const measured: unknown = await page.evaluate(MEASURE);

  if (
    typeof measured !== 'object' ||
    measured === null ||
    !('width' in measured) ||
    typeof measured.width !== 'number' ||
    !('height' in measured) ||
    typeof measured.height !== 'number' ||
    !('boxes' in measured) ||
    !Array.isArray(measured.boxes) ||
    !measured.boxes.every(isMarkBox)
  ) {
    throw new Error(`could not measure ${SCREEN} and its [data-mark]s`);
  }

  return {
    width: measured.width,
    height: measured.height,
    boxes: measured.boxes,
  };
};

/**
 * Draws the badges over the screen and a legend strip under it, in one
 * absolutely placed overlay; labels go in as text, never markup.
 */
const overlayScript = (data: {
  badges: { n: number; x: number; y: number }[];
  legend: { n: number; label: string }[];
}): string => `((data) => {
  const screen = document.querySelector('${SCREEN}').getBoundingClientRect();
  const badge = (n) => {
    const el = document.createElement('span');
    el.textContent = String(n);
    Object.assign(el.style, {
      display: 'inline-block', width: '${BADGE_SIZE}px', height: '${BADGE_SIZE}px',
      borderRadius: '50%', background: '#dc2626', color: '#ffffff',
      font: '600 13px/${BADGE_SIZE}px system-ui, sans-serif', textAlign: 'center',
      boxShadow: '0 0 0 2px #ffffff', flex: 'none',
    });
    return el;
  };
  const wrap = document.createElement('div');
  wrap.setAttribute('data-lambda-annotation', '');
  Object.assign(wrap.style, {
    position: 'absolute', left: (screen.left + window.scrollX) + 'px',
    top: (screen.top + window.scrollY) + 'px', width: screen.width + 'px',
    zIndex: '2147483647', pointerEvents: 'none', margin: '0', padding: '0',
  });
  const over = document.createElement('div');
  Object.assign(over.style, { position: 'relative', height: screen.height + 'px' });
  data.badges.forEach(({ n, x, y }) => {
    const el = badge(n);
    Object.assign(el.style, { position: 'absolute', left: x + 'px', top: y + 'px' });
    over.appendChild(el);
  });
  const legend = document.createElement('div');
  Object.assign(legend.style, {
    background: '#ffffff', borderTop: '1px solid #e7e5e4', padding: '12px 16px',
    display: 'flex', flexDirection: 'column', gap: '6px',
    font: '14px/20px system-ui, sans-serif', color: '#0c0a09',
  });
  if (data.legend.length === 0) {
    legend.textContent = 'No callouts in this state.';
  }
  data.legend.forEach(({ n, label }) => {
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px' });
    const text = document.createElement('span');
    text.textContent = label;
    row.append(badge(n), text);
    legend.appendChild(row);
  });
  wrap.append(over, legend);
  document.body.appendChild(wrap);
})(${JSON.stringify(data)})`;

export interface StillsOptions extends Omit<ArtboardOptions, 'scale'> {
  briefFile: string;
  marksFile: string;
  /** `<pods root>/<pod>/designs/<screen-slug>`: checked by assertScreenDir. */
  screenDir: string;
}

/** The approved prototype's stills. Returns the files written, in order. */
export const walkStills = async (options: StillsOptions): Promise<string[]> => {
  const screenDir = assertScreenDir(options.screenDir);
  const { states } = readBrief(options.briefFile);
  const marks = parseMarks(fs.readFileSync(options.marksFile, 'utf8'));

  return withArtboard(options, ({ open }) =>
    states.reduce<Promise<string[]>>(async (written, slug) => {
      const done = await written;

      return naming(`Situation ${slug}`, async () => {
        const loaded = await openIn(open, slug);
        await screenBox(loaded.page);
        // Marks are checked before anything is written for this state.
        const { width, height, boxes } = await measure(loaded.page);
        const { badges, legend } = layoutMarks(boxes, marks, { width, height });
        const plain = await shoot(loaded, path.join(screenDir, `${slug}.png`));

        await loaded.page.evaluate(overlayScript({ badges, legend }));
        await loaded.settle();

        const annotated = path.join(screenDir, `${slug}.annotated.png`);
        await loaded.page.locator(ANNOTATION).screenshot({ path: annotated });

        const legendFile = path.join(screenDir, `${slug}.legend.json`);
        fs.writeFileSync(legendFile, `${JSON.stringify(legend, null, 2)}\n`);
        await loaded.page.close();

        return [...done, plain, annotated, legendFile];
      });
    }, Promise.resolve([]))
  );
};
