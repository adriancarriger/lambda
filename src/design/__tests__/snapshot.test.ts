import * as fs from 'fs';
import * as path from 'path';

import { PrototypeManifestSchema } from '../../pod-store/prototypes';
import { boardName, readSituations, snapshotPrototype } from '../snapshot';
import {
  artboardHtml,
  makeCanvas,
  useFixtureRuntime,
  writeFile,
} from './canvasFixture';
import { runDesign } from './runDesign';

/**
 * `lambda design snapshot` keeps each published prototype in the pod as its
 * own version, so Lambda's inbox can let the owner try it.
 */

const POD = 'pawnee-home-a1b2';

const fixture = useFixtureRuntime();

afterAll(() => fixture.restore());

const poster = jest.fn(async ({ out }: { out: string }) => {
  writeFile(out, 'png');
});

const screenDir = (slug = 'home'): string => {
  const dir = path.join(fixture.podsRoot, POD, 'designs', slug);
  fs.mkdirSync(dir, { recursive: true });

  return dir;
};

/** A canvas with boards A and B, each with a busy/quiet switch. */
const twoBoards = (): string => {
  const canvas = makeCanvas({});
  const project = path.join(canvas, 'project');
  const body = (label: string) =>
    artboardHtml({
      body: `<button data-state="busy">Busy afternoon</button><button data-state="quiet">Quiet day</button><div data-screen>${label}</div>`,
    });
  writeFile(path.join(project, 'Main.dc.html'), body('Main'));
  writeFile(path.join(project, 'Desk.dc.html'), body('Desk'));
  writeFile(
    path.join(project, 'canvas.json'),
    JSON.stringify({
      title: 'Home page directions',
      boards: {
        'Desk.dc.html': { w: 1440, h: 900, title: 'B · Your desk' },
        'Main.dc.html': { w: 1440, h: 900, title: "A · Leslie's letter" },
      },
      order: ['Main.dc.html', 'Desk.dc.html'],
    })
  );

  return canvas;
};

beforeEach(() => poster.mockClear());

describe('snapshotPrototype', () => {
  it('saves v1: the files with support.js, the stills it finds, posters for the rest', async () => {
    const canvas = twoBoards();
    const screen = screenDir();
    writeFile(path.join(screen, 'A', 'busy.png'), 'busy');

    const result = await snapshotPrototype({
      canvasDir: canvas,
      screenDir: screen,
      renderPoster: poster,
      now: new Date('2026-10-20T15:00:00Z'),
    });

    const v1 = path.join(screen, 'prototype', 'v1');
    expect(result.line).toBe('[Prototype: home v1]');
    expect(fs.existsSync(path.join(v1, 'files', 'Main.dc.html'))).toBe(true);
    expect(fs.existsSync(path.join(v1, 'files', 'support.js'))).toBe(true);
    expect(result.manifest.boards.map((board) => board.letter)).toEqual([
      'A',
      'B',
    ]);
    expect(result.manifest.boards[0]?.stills).toEqual({
      busy: 'designs/home/prototype/v1/stills/A/busy.png',
    });
    expect(result.manifest.boards[1]?.stills).toEqual({
      poster: 'designs/home/prototype/v1/stills/B/poster.png',
    });
    expect(poster).toHaveBeenCalledTimes(1);
    expect(result.manifest.situations).toEqual([
      { slug: 'busy', title: 'Busy afternoon' },
      { slug: 'quiet', title: 'Quiet day' },
    ]);
    expect(
      fs.readFileSync(path.join(v1, 'stills', 'A', 'busy.png'), 'utf8')
    ).toBe('busy');
  });

  it('an unchanged project keeps the newest version; a changed one is the next', async () => {
    const canvas = twoBoards();
    const screen = screenDir('desk');
    const first = await snapshotPrototype({
      canvasDir: canvas,
      screenDir: screen,
      renderPoster: poster,
    });
    const again = await snapshotPrototype({
      canvasDir: canvas,
      screenDir: screen,
      renderPoster: poster,
    });

    expect(again.unchanged).toBe(true);
    expect(again.manifest.version).toBe(first.manifest.version);

    writeFile(
      path.join(canvas, 'project', 'Desk.dc.html'),
      artboardHtml({ colour: '#ff0000' })
    );
    const changed = await snapshotPrototype({
      canvasDir: canvas,
      screenDir: screen,
      renderPoster: poster,
    });

    expect(changed.manifest.version).toBe(2);
    expect(changed.line).toBe('[Prototype: desk v2]');
    // v1 stays as it was: a message that showed it still shows it.
    expect(fs.existsSync(path.join(screen, 'prototype', 'v1'))).toBe(true);
  });

  it('a lone board reads its photos from the screen folder itself', async () => {
    const canvas = makeCanvas({
      artboard: 'Prototype.dc.html',
      board: { w: 390, h: 844 },
    });
    const screen = screenDir('trail-map');
    writeFile(
      path.join(screen, 'brief.json'),
      JSON.stringify({
        name: 'Trail map',
        changes: 'Ann Perkins sees which trails are closed first.',
        situations: [{ slug: 'closed', title: 'Trail closed' }],
        path: [],
      })
    );
    writeFile(path.join(screen, 'closed.png'), 'png');

    const { manifest } = await snapshotPrototype({
      canvasDir: canvas,
      screenDir: screen,
      renderPoster: poster,
    });

    expect(manifest.boards[0]?.stills).toEqual({
      closed: 'designs/trail-map/prototype/v1/stills/A/closed.png',
    });
    expect(manifest.changes).toBe(
      'Ann Perkins sees which trails are closed first.'
    );
    expect(manifest.situations).toEqual([
      { slug: 'closed', title: 'Trail closed' },
    ]);
    expect(poster).not.toHaveBeenCalled();
  });

  it('refuses a screen folder outside a pod', async () => {
    await expect(
      snapshotPrototype({
        canvasDir: makeCanvas({}),
        screenDir: makeCanvas({}),
        renderPoster: poster,
      })
    ).rejects.toThrow('Refusing screen dir');
  });

  it('refuses a board taller than a window', async () => {
    const screen = screenDir('tall-home');

    await expect(
      snapshotPrototype({
        canvasDir: makeCanvas({ board: { w: 1440, h: 1240 } }),
        screenDir: screen,
        renderPoster: poster,
      })
    ).rejects.toThrow('Main.dc.html is 1440×1240: a board is one window');
    expect(fs.existsSync(path.join(screen, 'prototype'))).toBe(false);
  });

  it('refuses two boards with the same letter, which would share their stills', async () => {
    const canvas = twoBoards();
    const project = path.join(canvas, 'project');
    writeFile(
      path.join(project, 'canvas.json'),
      JSON.stringify({
        title: 'Home page directions',
        boards: {
          'Desk.dc.html': { w: 1440, h: 900, title: 'A · Your desk' },
          'Main.dc.html': { w: 1440, h: 900, title: "A · Leslie's letter" },
        },
        order: ['Main.dc.html', 'Desk.dc.html'],
      })
    );
    const screen = screenDir('twin-letters');

    await expect(
      snapshotPrototype({
        canvasDir: canvas,
        screenDir: screen,
        renderPoster: poster,
      })
    ).rejects.toThrow('Main.dc.html and Desk.dc.html are both board A');
    expect(fs.existsSync(path.join(screen, 'prototype'))).toBe(false);
  });

  it('leaves nothing behind when a poster fails', async () => {
    const screen = screenDir('broken');

    await expect(
      snapshotPrototype({
        canvasDir: twoBoards(),
        screenDir: screen,
        renderPoster: async () => {
          throw new Error('no ready signal');
        },
      })
    ).rejects.toThrow('no ready signal');
    expect(fs.readdirSync(path.join(screen, 'prototype'))).toEqual([]);
  });
});

describe('boardName', () => {
  it('reads the letter from the title, else the board’s place', () => {
    expect(boardName('C · Your desk', 'Desk.dc.html', 0)).toEqual({
      letter: 'C',
      title: 'Your desk',
    });
    expect(boardName(undefined, 'Prototype.dc.html', 1)).toEqual({
      letter: 'B',
      title: 'Prototype',
    });
  });
});

describe('readSituations', () => {
  it("falls back to the boards' own switches, once each", () => {
    const html =
      '<button class="switch" data-state="busy" aria-pressed="{{isBusy}}">Busy afternoon</button>';

    expect(readSituations(screenDir('none'), [html, html])).toEqual([
      { slug: 'busy', title: 'Busy afternoon' },
    ]);
  });
});

describe('lambda design snapshot', () => {
  /** One 1440×900 board, and a brief with two situations, both photographed. */
  const screenWithStills = (
    slug: string,
    board = { w: 1440, h: 900 }
  ): { canvas: string; screen: string } => {
    const canvas = makeCanvas({ artboard: 'Prototype.dc.html', board });
    const screen = screenDir(slug);
    writeFile(
      path.join(screen, 'brief.json'),
      JSON.stringify({
        name: 'Park map',
        changes: 'April Ludgate can find Lot 48 on the park map.',
        situations: [
          { slug: 'empty', title: 'No parks yet' },
          { slug: 'busy', title: 'Every park' },
        ],
        path: [],
      })
    );
    writeFile(path.join(screen, 'empty.png'), 'empty');
    writeFile(path.join(screen, 'busy.png'), 'busy');

    return { canvas, screen };
  };

  it('saves v1, says Unchanged on a second run, and saves v2 with --note after an edit', async () => {
    const { canvas, screen } = screenWithStills('park-map');
    const first = await runDesign(['snapshot', canvas, screen]);

    expect(first.code).toBe(0);
    expect(first.out.split('\n')).toContain('[Prototype: park-map v1]');
    const v1 = path.join(screen, 'prototype', 'v1');
    const manifest = PrototypeManifestSchema.parse(
      JSON.parse(fs.readFileSync(path.join(v1, 'prototype.json'), 'utf8'))
    );
    expect(manifest).toMatchObject({
      slug: 'park-map',
      version: 1,
      situations: [
        { slug: 'empty', title: 'No parks yet' },
        { slug: 'busy', title: 'Every park' },
      ],
    });
    expect(manifest.boards[0]?.stills).toEqual({
      empty: 'designs/park-map/prototype/v1/stills/A/empty.png',
      busy: 'designs/park-map/prototype/v1/stills/A/busy.png',
    });
    expect(fs.existsSync(path.join(v1, 'files', 'Prototype.dc.html'))).toBe(
      true
    );
    expect(fs.existsSync(path.join(v1, 'files', 'support.js'))).toBe(true);

    const again = await runDesign(['snapshot', canvas, screen]);
    expect(again.code).toBe(0);
    expect(again.out).toContain('Unchanged');
    expect(again.out.split('\n')).toContain('[Prototype: park-map v1]');
    expect(fs.existsSync(path.join(screen, 'prototype', 'v2'))).toBe(false);

    writeFile(
      path.join(canvas, 'project', 'Prototype.dc.html'),
      artboardHtml({ colour: '#15803d' })
    );
    const edited = await runDesign([
      'snapshot',
      canvas,
      screen,
      '--note',
      'Lot 48 is green now.',
    ]);
    expect(edited.code).toBe(0);
    expect(edited.out.split('\n')).toContain('[Prototype: park-map v2]');
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(screen, 'prototype', 'v2', 'prototype.json'),
          'utf8'
        )
      )
    ).toMatchObject({ version: 2, note: 'Lot 48 is green now.' });
  });

  it('refuses a 1440×1600 board, naming it, and writes nothing', async () => {
    const { canvas, screen } = screenWithStills('tall-map', {
      w: 1440,
      h: 1600,
    });
    const result = await runDesign(['snapshot', canvas, screen]);

    expect(result.code).toBe(1);
    expect(result.err).toContain('Prototype.dc.html is 1440×1600');
    expect(fs.existsSync(path.join(screen, 'prototype'))).toBe(false);
  });
});
