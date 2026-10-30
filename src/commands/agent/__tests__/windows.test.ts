import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  WINDOW_MAP_ENV,
  isScratchWindow,
  windowMapPath,
} from '../subcommands/windows';

const folder = (): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-windows-')));

describe('scratch windows', () => {
  it('is the project shell and any window named after it', () => {
    expect(isScratchWindow('scratchPad')).toBe(true);
    expect(isScratchWindow('scratchPad-trail-map')).toBe(true);
  });

  it('is never an agent window, or no window', () => {
    expect(isScratchWindow('dev')).toBe(false);
    expect(isScratchWindow('manager')).toBe(false);
    expect(isScratchWindow(undefined)).toBe(false);
  });
});

describe('the window map lambda agent context reads', () => {
  it('is --map first, resolved from where it runs', () => {
    const cwd = folder();

    expect(
      windowMapPath({
        map: 'maps/windows.json',
        env: { [WINDOW_MAP_ENV]: '/elsewhere.json' },
        cwd,
      })
    ).toBe(path.join(cwd, 'maps', 'windows.json'));
  });

  it(`is ${WINDOW_MAP_ENV} without --map`, () => {
    expect(
      windowMapPath({
        env: { [WINDOW_MAP_ENV]: '/srv/pawnee/window-map.json' },
        cwd: folder(),
      })
    ).toBe('/srv/pawnee/window-map.json');
  });

  it('is .lambda/window-map.json in the project otherwise', () => {
    const root = folder();
    fs.writeFileSync(path.join(root, 'lambda.json'), '{}');
    const inside = path.join(root, 'apps', 'parks');
    fs.mkdirSync(inside, { recursive: true });

    expect(windowMapPath({ env: {}, cwd: inside })).toBe(
      path.join(root, '.lambda', 'window-map.json')
    );
  });

  it('is nothing outside a project with neither set', () => {
    expect(windowMapPath({ env: {}, cwd: folder() })).toBeNull();
  });
});
