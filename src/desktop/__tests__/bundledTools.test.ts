import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { shimPath } from '../appPaths';
import {
  type AppLayout,
  appEnv,
  appPath,
  bundledTools,
  shimScript,
  writeShim,
} from '../bundledTools';

const layout = (home: string): AppLayout => ({
  bundle: '/Applications/Lambda.app',
  resources: '/Applications/Lambda.app/Contents/Resources',
  electron: '/Applications/Lambda.app/Contents/MacOS/Lambda',
  home,
});

describe('the tools the Mac app carries', () => {
  it('resolves tmux and git from the bundle and lambda from the shim', () => {
    expect(bundledTools(layout('/home/leslie'))).toEqual({
      tmux: '/Applications/Lambda.app/Contents/Resources/tools/bin/tmux',
      git: '/Applications/Lambda.app/Contents/Resources/tools/bin/git',
      lambda: '/home/leslie/Library/Application Support/Lambda/bin/lambda',
    });
  });

  it('puts the shim and the bundled tools first on PATH, without repeats', () => {
    const home = '/home/leslie';

    expect(
      appPath(
        layout(home),
        `/usr/bin:/home/leslie/Library/Application Support/Lambda/bin:/bin`
      ).split(':')
    ).toEqual([
      '/home/leslie/Library/Application Support/Lambda/bin',
      '/Applications/Lambda.app/Contents/Resources/tools/bin',
      '/usr/bin',
      '/bin',
    ]);
  });

  it("gives agents the bundle, PATH and Playwright's browsers folder", () => {
    const env = appEnv(layout('/home/leslie'), { PATH: '/usr/bin' }, '/b');

    expect(env).toMatchObject({
      LAMBDA_APP_BUNDLE: '/Applications/Lambda.app',
      PLAYWRIGHT_BROWSERS_PATH: '/b',
    });
    expect(
      env.PATH?.startsWith(
        '/home/leslie/Library/Application Support/Lambda/bin:'
      )
    ).toBe(true);
  });

  it('writes a shim that runs the bundled CLI through Electron as Node', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-shim-'));
    const file = writeShim(layout(home));

    expect(file).toBe(shimPath(home));
    expect(fs.statSync(file).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(file, 'utf8')).toBe(shimScript(layout(home)));
    expect(shimScript(layout(home))).toContain('ELECTRON_RUN_AS_NODE=1');
    expect(shimScript(layout(home))).toContain(
      "LAMBDA_APP_BUNDLE='/Applications/Lambda.app'"
    );
    expect(shimScript(layout(home))).toContain(
      "exec '/Applications/Lambda.app/Contents/MacOS/Lambda' '/Applications/Lambda.app/Contents/Resources/app.asar/bin/lambda' \"$@\""
    );
  });
});
