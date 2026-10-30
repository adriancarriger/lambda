/**
 * Imported by every pod suite: a temp project to run in (pod commands
 * read lambda.json from the current folder) and a temp LAMBDA_HOME, so no
 * suite ever reads this machine's ~/.lambda/config.json.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmp = (name: string): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));

export const LAMBDA_HOME = tmp('lambda-home-');
process.env.LAMBDA_HOME = LAMBDA_HOME;

/** A project folder with a lambda.json; the current folder from now on. */
export const usePodProject = (config: Record<string, unknown> = {}): string => {
  const root = tmp('pawnee-parks-');
  fs.writeFileSync(
    path.join(root, 'lambda.json'),
    `${JSON.stringify({ name: 'pawnee-parks', ...config }, null, 2)}\n`
  );
  process.chdir(root);

  return root;
};

/** Set `owner.name` in this run's machine settings (undefined: none). */
export const setOwnerName = (name: string | undefined): void => {
  fs.writeFileSync(
    path.join(LAMBDA_HOME, 'config.json'),
    `${JSON.stringify(name === undefined ? {} : { owner: { name } })}\n`
  );
};

usePodProject();
