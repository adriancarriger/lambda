import * as fs from 'fs';
import * as path from 'path';

/** Whether an executable called `name` is on the env's PATH. */
export const onPath = (
  name: string,
  env: NodeJS.ProcessEnv = process.env
): boolean =>
  (env.PATH ?? '')
    .split(path.delimiter)
    .filter((dir) => dir !== '')
    .some((dir) => {
      try {
        fs.accessSync(path.join(dir, name), fs.constants.X_OK);

        return true;
      } catch {
        return false;
      }
    });
