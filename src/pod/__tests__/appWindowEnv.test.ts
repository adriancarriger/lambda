import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { newWindow } from '../tmux';

/**
 * The person already runs tmux, started from their own terminal. Lambda's
 * windows land on that server, which knows nothing of the app, so each
 * window is given the app's environment. (Its PATH comes from tmux's client,
 * which is Lambda, run with the app's PATH.)
 */
describe("a pod window on the person's own tmux server", () => {
  const saved = { ...process.env };
  // A short socket folder: tmux refuses socket paths over about 100 bytes.
  const dir = fs.mkdtempSync('/tmp/lw-');
  const serverEnv = {
    PATH: '/usr/bin:/bin',
    // No dotfiles of this machine's: they would set their own PATH.
    HOME: dir,
    TMUX_TMPDIR: dir,
    SHELL: '/bin/sh',
  };
  const tmuxBin = execFileSync('sh', ['-c', 'command -v tmux'], {
    encoding: 'utf8',
  }).trim();

  beforeAll(() => {
    execFileSync(
      tmuxBin,
      ['-f', '/dev/null', 'new-session', '-d', '-s', 'ann-own'],
      {
        env: serverEnv,
      }
    );
  });

  afterAll(() => {
    execFileSync(tmuxBin, ['kill-server'], { env: serverEnv });
    ['TMUX_TMPDIR', 'LAMBDA_APP_BUNDLE', 'PLAYWRIGHT_BROWSERS_PATH'].forEach(
      (key) => delete process.env[key]
    );
    Object.assign(process.env, {
      PATH: saved.PATH,
      ...(saved.TMUX === undefined ? {} : { TMUX: saved.TMUX }),
      ...(saved.TMUX_TMPDIR === undefined
        ? {}
        : { TMUX_TMPDIR: saved.TMUX_TMPDIR }),
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("gets the app's PATH and bundle, not the server's", async () => {
    const out = path.join(dir, 'env');
    Object.assign(process.env, {
      TMUX_TMPDIR: dir,
      PATH: `${path.dirname(tmuxBin)}:/usr/bin:/bin`,
      LAMBDA_APP_BUNDLE: '/Applications/Lambda.app',
      PLAYWRIGHT_BROWSERS_PATH: '/home/ann/.lambda/browsers',
    });
    // Not from inside another tmux: that would pick its socket instead.
    delete process.env.TMUX;

    newWindow({
      session: 'lambda-pod-ann',
      window: 'dev',
      cwd: dir,
      command: `printf 'PATH=%s\\nLAMBDA_APP_BUNDLE=%s\\nPLAYWRIGHT_BROWSERS_PATH=%s\\n' "$PATH" "$LAMBDA_APP_BUNDLE" "$PLAYWRIGHT_BROWSERS_PATH" > ${out}.tmp && mv ${out}.tmp ${out}`,
    });

    const deadline = Date.now() + 5000;

    while (!fs.existsSync(out) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const lines = fs.readFileSync(out, 'utf8').split('\n');

    expect(lines).toContain(`PATH=${path.dirname(tmuxBin)}:/usr/bin:/bin`);
    expect(lines).toContain('LAMBDA_APP_BUNDLE=/Applications/Lambda.app');
    expect(lines).toContain(
      'PLAYWRIGHT_BROWSERS_PATH=/home/ann/.lambda/browsers'
    );
  });
});
