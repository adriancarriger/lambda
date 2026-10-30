import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { podFilePath } from '../server/podFile';

/**
 * The UX review's pictures are served from the pod's own `designs/` folder
 * and nowhere else: questions, thread and intent stay unreachable.
 */

const POD = 'pawnee-a1b2';

const roots: string[] = [];

afterEach(() => {
  roots
    .splice(0)
    .forEach((made) => fs.rmSync(made, { recursive: true, force: true }));
});

const seed = (): string => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pods-file-'))
  );
  const designs = path.join(root, POD, 'designs', 'trail-map');
  fs.mkdirSync(designs, { recursive: true });
  fs.writeFileSync(path.join(designs, 'after.png'), 'png');
  fs.writeFileSync(path.join(designs, 'a.svg'), '<svg/>');
  fs.writeFileSync(path.join(root, POD, 'intent.md'), 'intent');
  fs.writeFileSync(path.join(root, POD, 'pod.json'), '{}');
  fs.writeFileSync(path.join(root, 'outside.png'), 'png');
  fs.symlinkSync(
    path.join(root, 'outside.png'),
    path.join(designs, 'escape.png')
  );
  roots.splice(roots.length, 0, root);

  return root;
};

describe('podFilePath', () => {
  it('resolves a PNG inside the pod designs folder', () => {
    const root = seed();

    expect(podFilePath(root, POD, 'designs/trail-map/after.png')).toBe(
      path.join(root, POD, 'designs', 'trail-map', 'after.png')
    );
  });

  it.each([
    ['../x', POD],
    ['designs/%2e%2e/pod.json', POD],
    ['designs/../pod.json', POD],
    ['designs/trail-map/a.svg', POD],
    ['intent.md', POD],
    ['designs/trail-map/escape.png', POD],
    ['designs/trail-map/after.png', 'Pawnee!'],
    ['designs/trail-map/missing.png', POD],
  ])('refuses %s (pod %s)', (rest, podId) => {
    expect(podFilePath(seed(), podId, rest)).toBeNull();
  });

  it("serves a PNG from the pod's shots folder too, nothing else beside it", () => {
    const root = seed();
    const shots = path.join(root, POD, 'shots');
    fs.mkdirSync(shots, { recursive: true });
    fs.writeFileSync(path.join(shots, 'home-desktop.png'), 'png');

    expect(podFilePath(root, POD, 'shots/home-desktop.png')).toBe(
      path.join(root, POD, 'shots', 'home-desktop.png')
    );
    expect(podFilePath(root, POD, 'turns/dev.png')).toBeNull();
  });

  it('serves a manifest.json only from a screenshots folder', () => {
    const root = seed();
    const attempt = path.join(root, POD, 'screenshots', '3', '1');
    fs.mkdirSync(attempt, { recursive: true });
    fs.writeFileSync(path.join(attempt, 'manifest.json'), '[]');
    fs.writeFileSync(path.join(root, POD, 'designs', 'manifest.json'), '[]');

    expect(podFilePath(root, POD, 'screenshots/3/1/manifest.json')).toBe(
      path.join(attempt, 'manifest.json')
    );
    expect(podFilePath(root, POD, 'designs/manifest.json')).toBeNull();
  });

  it('serves a folder or file named in capitals (designs/home/C/busy.png)', () => {
    const root = seed();
    const folder = path.join(root, POD, 'designs', 'home', 'C');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'Busy.png'), 'png');

    expect(podFilePath(root, POD, 'designs/home/C/Busy.png')).toBe(
      path.join(folder, 'Busy.png')
    );
  });

  it.each(['screenshots', 'shots'])(
    'refuses a %s folder that is a symlink out of the pod',
    (folder) => {
      const root = seed();
      const elsewhere = path.join(root, 'elsewhere');
      fs.mkdirSync(path.join(elsewhere, '3', '1'), { recursive: true });
      fs.writeFileSync(path.join(elsewhere, '3', '1', 'home.png'), 'png');
      fs.symlinkSync(elsewhere, path.join(root, POD, folder));

      expect(podFilePath(root, POD, `${folder}/3/1/home.png`)).toBeNull();
    }
  );
});
