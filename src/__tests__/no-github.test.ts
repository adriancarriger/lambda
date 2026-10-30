import * as fs from 'fs';
import * as path from 'path';

/**
 * Lambda never reads GitHub: no file in the mothership, the runner or events
 * names its API or runs `gh`.
 */
const GITHUB = /api\.github\.com|['"`]gh['"`\s]/;

const SRC = path.resolve(__dirname, '..');
const DIRS = ['mothership', 'runner', 'events'];

const filesUnder = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);

    return entry.isDirectory() ? filesUnder(full) : [full];
  });

describe('no GitHub', () => {
  it('matches what it should, and not a word that ends in gh', () => {
    expect(GITHUB.test("execFile('gh', ['pr'])")).toBe(true);
    expect(GITHUB.test('`gh pr view`')).toBe(true);
    expect(GITHUB.test('fetch("https://api.github.com/repos")')).toBe(true);
    expect(GITHUB.test('enough time')).toBe(false);
  });

  it('appears nowhere in the mothership, the runner or events', () => {
    const hits = DIRS.flatMap((dir) => filesUnder(path.join(SRC, dir))).filter(
      (file) => GITHUB.test(fs.readFileSync(file, 'utf8'))
    );

    expect(hits).toEqual([]);
  });
});
