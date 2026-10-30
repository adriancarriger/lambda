import { createRequire } from 'module';
import * as path from 'path';

/**
 * Load a package by name, looking in `NODE_PATH` as well as beside this
 * file. The Mac app carries Kokoro outside app.asar and names its folder in
 * `NODE_PATH`; a native `import()` never reads `NODE_PATH`, so the worker
 * loads its libraries through this instead.
 */
export const requireFromNodePath = (
  name: string,
  env: Record<string, string | undefined> = process.env
): unknown => createRequire(__filename)(resolveFromNodePath(name, env));

/** Where `requireFromNodePath` would load `name` from; throws when nowhere. */
export const resolveFromNodePath = (
  name: string,
  env: Record<string, string | undefined> = process.env
): string => {
  const dirs = (env.NODE_PATH ?? '')
    .split(path.delimiter)
    .filter((dir) => dir !== '');

  return createRequire(__filename).resolve(name, {
    paths: [...dirs, __dirname],
  });
};

/**
 * kokoro-js can be loaded here: the Mac app's Kokoro folder, or a checkout
 * that installed Lambda's own dependencies (kokoro-js is one).
 */
export const kokoroInstalled = (
  env: Record<string, string | undefined> = process.env
): boolean => {
  try {
    resolveFromNodePath('kokoro-js', env);

    return true;
  } catch {
    return false;
  }
};
