import * as fs from 'fs';
import * as path from 'path';

import { ID_PATTERN } from '../pod-store/schemas';
import { podsRoot } from '../pod/context';
import { DESIGN_SLUG } from './loop';

/**
 * A screen's design folder, `<pods root>/<pod>/designs/<screen-slug>/`, by
 * realpath: a symlink out of the pod's `designs/` is refused, as is a pod id
 * outside ID_PATTERN or a slug outside DESIGN_SLUG. Returns the realpath.
 */
export const assertScreenDir = (dir: string): string => {
  if (!fs.existsSync(dir)) {
    throw new Error(`Screen dir ${dir} does not exist.`);
  }

  const real = fs.realpathSync(dir);
  const root = fs.realpathSync(podsRoot());
  const [pod, designs, slug, ...rest] = path
    .relative(root, real)
    .split(path.sep);

  if (
    pod === undefined ||
    pod === '..' ||
    !ID_PATTERN.test(pod) ||
    designs !== 'designs' ||
    slug === undefined ||
    !DESIGN_SLUG.test(slug) ||
    rest.length > 0
  ) {
    throw new Error(
      `Refusing screen dir ${dir} (${real}): it must be <pods root>/<pod>/designs/<screen-slug> under ${root}, the slug matching ${DESIGN_SLUG}.`
    );
  }

  return real;
};
