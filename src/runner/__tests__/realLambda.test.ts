/**
 * The `lambda` the runner, `lambda start` and agents' shells run as a child
 * process, for real: no stubbed spawn. Runs the built package (bin/lambda
 * requires dist/cli.js), so `npm run build` comes first.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { VERSION } from '../../cli';
import { lambdaPackageDir } from '../../process/workflow-file';
import { realLambda } from '../runtime';

describe('the lambda a child process runs', () => {
  it('runs a command for real, not a module that only exports one', async () => {
    const built = path.join(lambdaPackageDir(), 'dist', 'cli.js');

    if (!fs.existsSync(built)) {
      throw new Error(`${built} is missing: run npm run build first.`);
    }

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-real-'));

    // dist/cli.js run directly printed nothing and exited 0.
    await expect(realLambda().run(['--version'], { cwd })).resolves.toBe(
      VERSION
    );
  });
});
