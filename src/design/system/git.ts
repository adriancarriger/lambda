import { execFileSync } from 'child_process';

/** Git's trimmed output, or undefined when the command fails. */
export const gitOk = (cwd: string, args: string[]): string | undefined => {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return undefined;
  }
};

/** Git's trimmed output; throws with git's own message on failure. */
export const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

/**
 * The paths a `-z` git listing (`diff --name-only -z`, `ls-files -z`) names,
 * spelled as stored: no quoting of unusual names. Throws like `git`.
 */
export const gitPaths = (cwd: string, args: string[]): string[] =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .split('\0')
    .filter((file) => file !== '');

const hasRef = (cwd: string, ref: string): boolean =>
  gitOk(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !==
  undefined;

/**
 * `origin/<default branch>` as last fetched: origin's HEAD when git knows it,
 * else `origin/main` or `origin/master`. A checkout with no origin reads its
 * own `HEAD`. Nothing is fetched here.
 */
export const defaultBranchRef = (cwd: string): string => {
  const head = gitOk(cwd, [
    'symbolic-ref',
    '--quiet',
    'refs/remotes/origin/HEAD',
  ]);

  if (head !== undefined && head.startsWith('refs/remotes/')) {
    return head.slice('refs/remotes/'.length);
  }

  return (
    ['origin/main', 'origin/master'].find((ref) => hasRef(cwd, ref)) ?? 'HEAD'
  );
};
