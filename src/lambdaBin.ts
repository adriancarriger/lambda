import * as path from 'path';

import { lambdaPackageDir } from './process/workflow-file';

/**
 * The `lambda` a child process runs: bin/lambda, the script that calls
 * `run(process.argv)`. Never dist/cli.js, which only exports `run`, so
 * running it does nothing and exits 0. The Mac app ships bin/ in app.asar,
 * as its own shim runs it.
 */
export const lambdaBin = (): string =>
  path.join(lambdaPackageDir(), 'bin', 'lambda');
