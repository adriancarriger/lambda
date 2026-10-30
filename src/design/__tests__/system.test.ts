import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installSystem } from '../system/install';
import { runDesign } from './runDesign';

const tmp = (prefix: string): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const NOW = () => new Date('2026-10-20T21:00:00.000Z');

const write = (file: string, body: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};

/** A design system built from main: its manifest names the namespace. */
const built = (
  options: { namespace?: unknown; manifest?: boolean; skip?: string[] } = {}
): string => {
  const dir = tmp('lambda-design-system-built-');

  if (options.manifest !== false) {
    write(
      path.join(dir, 'design-system.json'),
      JSON.stringify({
        namespace: options.namespace ?? 'Pawnee',
        title: 'Pawnee Parks',
      })
    );
  }

  [
    'README.md',
    'tokens.json',
    'components/bundle.css',
    'components/bundle.js',
    'sample-data.js',
    'screens/Home.dc.html',
  ]
    .filter((rel) => !(options.skip ?? []).includes(rel))
    .forEach((rel) => write(path.join(dir, rel), `/* ${rel} */`));

  return dir;
};

const canvas = (): string => {
  const dir = tmp('lambda-design-canvas-');
  write(
    path.join(dir, 'project', 'canvas.json'),
    JSON.stringify({
      v: 3,
      boards: { 'Prototype.dc.html': { x: 0, y: 0, w: 1440, h: 900 } },
    })
  );

  return dir;
};

const projectFiles = (dir: string): string[] =>
  fs
    .readdirSync(path.join(dir, 'project'), { recursive: true })
    .map(String)
    .filter((rel) => fs.statSync(path.join(dir, 'project', rel)).isFile())
    .map((rel) => `project/${rel.split(path.sep).join('/')}`)
    .sort();

const records = (dir: string): unknown => {
  const parsed: unknown = JSON.parse(
    fs.readFileSync(path.join(dir, 'project', 'canvas.json'), 'utf8')
  );

  return typeof parsed === 'object' &&
    parsed !== null &&
    'designSystems' in parsed
    ? parsed.designSystems
    : undefined;
};

describe('installSystem', () => {
  it('copies the system under project/ds/pawnee/ only, screen and sample data included, with one record', () => {
    const dir = canvas();
    installSystem({ builtDir: built(), canvasDir: dir, now: NOW });

    expect(projectFiles(dir)).toEqual([
      'project/canvas.json',
      'project/ds/pawnee/README.md',
      'project/ds/pawnee/components/bundle.css',
      'project/ds/pawnee/components/bundle.js',
      'project/ds/pawnee/sample-data.js',
      'project/ds/pawnee/screens/Home.dc.html',
      'project/ds/pawnee/tokens.json',
    ]);
    expect(records(dir)).toEqual([
      {
        title: 'Pawnee Parks',
        namespace: 'pawnee',
        copiedAt: '2026-10-20T21:00:00.000Z',
      },
    ]);
  });

  it('keeps one record when run twice, and keeps the boards', () => {
    const dir = canvas();
    const source = built();
    installSystem({ builtDir: source, canvasDir: dir, now: NOW });
    installSystem({ builtDir: source, canvasDir: dir, now: NOW });

    expect(records(dir)).toHaveLength(1);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(dir, 'project', 'canvas.json'), 'utf8')
      )
    ).toMatchObject({ boards: { 'Prototype.dc.html': { w: 1440 } } });
  });

  it('installs a system without screens or sample data', () => {
    const dir = canvas();
    installSystem({
      builtDir: built({ skip: ['sample-data.js', 'screens/Home.dc.html'] }),
      canvasDir: dir,
      now: NOW,
    });

    expect(projectFiles(dir)).not.toContain('project/ds/pawnee/sample-data.js');
    expect(projectFiles(dir)).toContain('project/ds/pawnee/tokens.json');
  });

  it('refuses a namespace that is not a JavaScript name, copying nothing', () => {
    const dir = canvas();

    expect(() =>
      installSystem({
        builtDir: built({ namespace: 'pawnee!' }),
        canvasDir: dir,
        now: NOW,
      })
    ).toThrow(/namespace/);
    expect(projectFiles(dir)).toEqual(['project/canvas.json']);
  });

  it('refuses a folder with no manifest, naming it', () => {
    const dir = canvas();

    expect(() =>
      installSystem({
        builtDir: built({ manifest: false }),
        canvasDir: dir,
        now: NOW,
      })
    ).toThrow(/design-system\.json/);
    expect(projectFiles(dir)).toEqual(['project/canvas.json']);
  });

  it('throws naming a missing bundle.js, copying nothing', () => {
    const dir = canvas();

    expect(() =>
      installSystem({
        builtDir: built({ skip: ['components/bundle.js'] }),
        canvasDir: dir,
        now: NOW,
      })
    ).toThrow(/bundle\.js/);
    expect(projectFiles(dir)).toEqual(['project/canvas.json']);
  });

  it('throws on a tokens.json that is a symlink outside the built folder, copying nothing', () => {
    const dir = canvas();
    const source = built({ skip: ['tokens.json'] });
    const outside = path.join(tmp('lambda-design-outside-'), 'tokens.json');
    fs.writeFileSync(outside, '{"ron":"swanson"}');
    fs.symlinkSync(outside, path.join(source, 'tokens.json'));

    expect(() =>
      installSystem({ builtDir: source, canvasDir: dir, now: NOW })
    ).toThrow(/tokens\.json/);
    expect(projectFiles(dir)).toEqual(['project/canvas.json']);
  });

  it('also copies the pictures under assets/', () => {
    const dir = canvas();
    const source = built();
    write(path.join(source, 'assets', 'Parks', 'lot-48.jpg'), 'jpeg');
    installSystem({ builtDir: source, canvasDir: dir, now: NOW });

    expect(projectFiles(dir)).toContain(
      'project/ds/pawnee/assets/Parks/lot-48.jpg'
    );
  });

  it("writes .lambda/design/.gitignore for a canvas inside a pod's working folder", () => {
    const work = tmp('lambda-design-work-');
    const dir = path.join(work, '.lambda', 'design', 'park-map', 'canvas');
    fs.mkdirSync(path.join(dir, 'project'), { recursive: true });
    installSystem({ builtDir: built(), canvasDir: dir, now: NOW });

    expect(
      fs.readFileSync(
        path.join(work, '.lambda', 'design', '.gitignore'),
        'utf8'
      )
    ).toBe('*\n');
  });
});

describe('lambda design system install', () => {
  it('installs and exits 0; a bad namespace exits 1', async () => {
    const ok = await runDesign(['system', 'install', built(), canvas()]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('Installed');

    const dir = canvas();
    const bad = await runDesign([
      'system',
      'install',
      built({ namespace: 'pawnee!' }),
      dir,
    ]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('namespace');
    expect(projectFiles(dir)).toEqual(['project/canvas.json']);
  });
});
