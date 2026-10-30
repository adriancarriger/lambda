import * as fs from 'fs';
import * as path from 'path';

import { walkPrototype, walkStills } from '../walk';
import {
  makeCanvas,
  pngSize,
  quiet,
  rejection,
  tmp,
  useFixtureRuntime,
  writeFile,
} from './canvasFixture';

// Real Chromium: a cold launch is slower than Jest's 5 s default.
jest.setTimeout(60_000);

const ARTBOARD = 'Prototype.dc.html';

const setLabel = (text: string): string =>
  `document.getElementById('label').textContent='${text}'`;

/**
 * A 300×160 screen with a `go` click target and mark 1, and a state switch
 * beside it: `second` also adds mark 2, so the two states' legends differ.
 */
const prototype = (opts: { target?: boolean } = {}): string =>
  [
    '<div data-screen="" style="width: 300px; height: 160px; background: #f5f5f4">',
    '<p id="label">opening</p>',
    opts.target === false
      ? ''
      : `<span data-target="go" onclick="${setLabel(
          'went'
        )}" style="display: inline-block; width: 60px; height: 24px; background: #1d4ed8">go</span>`,
    '<span data-mark="1" style="display: inline-block; width: 40px; height: 20px; background: #f97316"></span>',
    '</div>',
    `<button data-state="first" onclick="${setLabel('first')}">first</button>`,
    `<button data-state="second" onclick="${setLabel(
      'second'
    )}; var m = document.createElement('span'); m.setAttribute('data-mark', '2'); m.style.cssText = 'display: inline-block; width: 30px; height: 30px; background: #16a34a'; document.querySelector('[data-screen]').appendChild(m)">second</button>`,
  ].join('');

const writeBrief = (dir: string): string => {
  const file = path.join(dir, 'brief.json');
  writeFile(
    file,
    JSON.stringify({
      name: 'Trail map',
      change: 'changed',
      changes: 'Leslie Knope can mark a trail closed.',
      situations: [
        { slug: 'first', title: 'First' },
        { slug: 'second', title: 'Second' },
      ],
      path: [
        { step: 'Go', action: 'click go' },
        { step: 'Switch', action: 'state second' },
      ],
    })
  );

  return file;
};

describe('lambda design walk', () => {
  const fixture = { podsRoot: '', restore: () => {} };

  beforeAll(() => {
    Object.assign(fixture, useFixtureRuntime());
  });

  afterAll(() => {
    fixture.restore();
  });

  describe('walkPrototype', () => {
    it('writes a photo of the screen after each step, then one per situation', async () => {
      const outDir = path.join(tmp('lambda-design-walk-'), 'round-1');
      const files = await walkPrototype({
        canvasDir: makeCanvas({ artboard: ARTBOARD, body: prototype() }),
        artboard: ARTBOARD,
        briefFile: writeBrief(tmp('lambda-design-brief-')),
        outDir,
        log: quiet,
      });

      expect(files.map((file) => path.basename(file))).toEqual([
        'step-1.png',
        'step-2.png',
        'first.png',
        'second.png',
      ]);
      // Only [data-screen] is photographed, never the state switch.
      files.forEach((file) =>
        expect(pngSize(file)).toEqual({ width: 300, height: 160 })
      );
      // Step 1 clicked `go` after opening in `first`, so it differs from first.png.
      expect(
        fs
          .readFileSync(path.join(outDir, 'step-1.png'))
          .equals(fs.readFileSync(path.join(outDir, 'first.png')))
      ).toBe(false);
    });

    it('fails naming step 1 when its data-target is missing, writing no step photo', async () => {
      const outDir = path.join(tmp('lambda-design-walk-'), 'round-1');
      const error = await rejection(
        walkPrototype({
          canvasDir: makeCanvas({
            artboard: ARTBOARD,
            body: prototype({ target: false }),
          }),
          artboard: ARTBOARD,
          briefFile: writeBrief(tmp('lambda-design-brief-')),
          outDir,
          log: quiet,
        })
      );

      expect(error.message).toMatch(/^Step 1 \(Go\): .*data-target="go"/);
      expect(fs.existsSync(path.join(outDir, 'step-1.png'))).toBe(false);
    });
  });

  describe('walkStills', () => {
    const screenDir = (): string => {
      const dir = path.join(
        fixture.podsRoot,
        'pawnee-trails',
        'designs',
        'trail-map'
      );
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });

      return dir;
    };

    const writeMarks = (dir: string, marks: unknown): string => {
      const file = path.join(dir, 'marks.json');
      writeFile(file, JSON.stringify(marks));

      return file;
    };

    it('writes plain, annotated (taller: the legend strip) and legend per situation', async () => {
      const dir = screenDir();
      const files = await walkStills({
        canvasDir: makeCanvas({ artboard: ARTBOARD, body: prototype() }),
        artboard: ARTBOARD,
        briefFile: writeBrief(dir),
        marksFile: writeMarks(dir, [
          { n: 1, label: 'Detour button' },
          { n: 2, label: 'Trail open badge' },
        ]),
        screenDir: dir,
        log: quiet,
      });

      expect(files.map((file) => path.basename(file))).toEqual([
        'first.png',
        'first.annotated.png',
        'first.legend.json',
        'second.png',
        'second.annotated.png',
        'second.legend.json',
      ]);
      ['first', 'second'].forEach((slug) =>
        expect(
          pngSize(path.join(dir, `${slug}.annotated.png`)).height
        ).toBeGreaterThan(pngSize(path.join(dir, `${slug}.png`)).height)
      );
      expect(
        JSON.parse(fs.readFileSync(path.join(dir, 'first.legend.json'), 'utf8'))
      ).toEqual([{ n: 1, label: 'Detour button' }]);
      expect(
        JSON.parse(
          fs.readFileSync(path.join(dir, 'second.legend.json'), 'utf8')
        )
      ).toEqual([
        { n: 1, label: 'Detour button' },
        { n: 2, label: 'Trail open badge' },
      ]);
    });

    it('fails naming the situation and the mark that marks.json does not label', async () => {
      const dir = screenDir();
      const error = await rejection(
        walkStills({
          canvasDir: makeCanvas({ artboard: ARTBOARD, body: prototype() }),
          artboard: ARTBOARD,
          briefFile: writeBrief(dir),
          marksFile: writeMarks(dir, [{ n: 1, label: 'Detour button' }]),
          screenDir: dir,
          log: quiet,
        })
      );

      expect(error.message).toMatch(/^Situation second: data-mark 2/);
      expect(fs.existsSync(path.join(dir, 'second.png'))).toBe(false);
    });
  });
});
