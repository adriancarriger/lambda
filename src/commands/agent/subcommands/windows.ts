import * as path from 'path';

import { SCRATCH_WINDOW, findProjectRoot } from '../../../config/projectConfig';

/**
 * A scratch window: the project's shell, or another one named after it
 * (`scratchPad`, `scratchPad-2`, …). Agent commands never clear or compact one.
 */
export const isScratchWindow = (windowName: string | undefined): boolean =>
  windowName !== undefined && windowName.startsWith(SCRATCH_WINDOW);

/** The env variable that points `lambda agent context` at a window map. */
export const WINDOW_MAP_ENV = 'LAMBDA_WINDOW_MAP';

/** Where a project's window map lives when nothing says otherwise. */
export const DEFAULT_WINDOW_MAP = path.join('.lambda', 'window-map.json');

/**
 * The window map `lambda agent context` reads: `--map`, else
 * LAMBDA_WINDOW_MAP, else `.lambda/window-map.json` in the project. `null`
 * outside a project with neither set.
 */
export const windowMapPath = ({
  map,
  env = process.env,
  cwd = process.cwd(),
}: {
  map?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
}): string | null => {
  const chosen = map ?? env[WINDOW_MAP_ENV];

  if (chosen !== undefined && chosen !== '') {
    return path.resolve(cwd, chosen);
  }

  const project = findProjectRoot(cwd);

  return project === null ? null : path.join(project.root, DEFAULT_WINDOW_MAP);
};
