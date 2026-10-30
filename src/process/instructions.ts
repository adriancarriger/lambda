import * as path from 'path';

import { lambdaPackageDir } from './workflow-file';

/**
 * The design judge's severity scale, Lambda's own and never a project's.
 * design-screen names it as `{severityFile}`: a dev whose dev.md the project
 * overrode can't work out where Lambda's package is.
 */
export const severityFile = (): string =>
  path.join(lambdaPackageDir(), 'instructions', 'design', 'visual-severity.md');

/**
 * Lambda's planning and building instructions name the person who runs the
 * project as `{owner}`. Whoever writes the files out for a pod fills it from
 * `owner.name` in `~/.lambda/config.json`. `{severityFile}` becomes the
 * absolute path of the severity scale.
 */
export const fillInstructions = (
  text: string,
  values: { owner: string }
): string =>
  text
    .split('{owner}')
    .join(values.owner)
    .split('{severityFile}')
    .join(severityFile());
