import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Small git repos for the design system tests. Not a test file: jest only
 * runs `*.test.ts`.
 */

export const tmpDir = (prefix: string): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

export const run = (cwd: string, args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

export const put = (root: string, rel: string, body: string): void => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};

/** A fresh repo on `main` with a local identity. */
export const initRepo = (dir: string = tmpDir('lambda-ds-repo-')): string => {
  run(dir, ['init', '-q', '-b', 'main']);
  run(dir, ['config', 'user.name', 'Leslie Knope']);
  run(dir, ['config', 'user.email', 'leslie@pawnee.gov']);
  run(dir, ['config', 'commit.gpgsign', 'false']);

  return dir;
};

export const commitAll = (root: string, message: string): string => {
  run(root, ['add', '-A']);
  run(root, ['commit', '-q', '--allow-empty', '-m', message]);

  return run(root, ['rev-parse', 'HEAD']);
};

/**
 * An upstream repo with `files` committed on main, and a clone of it, so the
 * clone has `origin/main`. Returns both.
 */
export const cloneOfUpstream = (
  files: Record<string, string>
): { upstream: string; clone: string } => {
  const upstream = initRepo();
  Object.entries(files).forEach(([rel, body]) => put(upstream, rel, body));
  commitAll(upstream, 'Pawnee parks map');
  const clone = path.join(tmpDir('lambda-ds-clone-'), 'checkout');
  run(path.dirname(clone), ['clone', '-q', upstream, clone]);
  run(clone, ['config', 'user.name', 'Leslie Knope']);
  run(clone, ['config', 'user.email', 'leslie@pawnee.gov']);
  run(clone, ['config', 'commit.gpgsign', 'false']);

  return { upstream, clone };
};
