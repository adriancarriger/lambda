import * as fs from 'fs';
import * as path from 'path';

import { ID_PATTERN } from '../../pod-store';

/**
 * `GET /api/pod-file/<pod>/<designs|shots|screenshots>/<path>`: the UX
 * review's pictures, screenshots a pod took for the chat (`shots/`), and a
 * building pod's test screenshots (`screenshots/<ticket>/<attempt>/`, with
 * that folder's `manifest.json`). `GET /api/pod/<pod>/visual/<path>`: the
 * visual check's rounds (`visual/<ticket>/<round>/`, with each round's
 * `manifest.json`). Only a PNG, or one of those manifests, inside one of
 * those folders of that pod is served (symlinks resolved, and never through
 * a folder that is itself a symlink), so questions, thread and intent stay
 * unreachable. The runner holding the pod answers; the mothership never
 * reads them.
 */

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FOLDERS = ['designs', 'shots', 'screenshots', 'visual'];
/** The folders whose `manifest.json` is served beside their pictures. */
const MANIFEST_FOLDERS = ['screenshots', 'visual'];
export const MANIFEST = 'manifest.json';

/** The 8 bytes every PNG starts with, whatever its name. */
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** The one PNG check: what qa records and what the runner serves. */
export const isPng = (file: string): boolean => {
  const handle = fs.openSync(file, 'r');

  try {
    const head = Buffer.alloc(PNG_SIGNATURE.length);
    const read = fs.readSync(handle, head, 0, head.length, 0);

    return read === head.length && head.equals(PNG_SIGNATURE);
  } finally {
    fs.closeSync(handle);
  }
};

/** The file's absolute path, or null when it isn't one we serve. */
export const podFilePath = (
  root: string,
  podId: string,
  rest: string
): string | null => {
  const segments = rest.split('/');

  if (
    !ID_PATTERN.test(podId) ||
    !FOLDERS.includes(segments[0] ?? '') ||
    segments.length < 2 ||
    !segments.every((segment) => SEGMENT.test(segment)) ||
    !(
      rest.endsWith('.png') ||
      (MANIFEST_FOLDERS.includes(segments[0] ?? '') &&
        segments.at(-1) === MANIFEST)
    )
  ) {
    return null;
  }

  const file = path.join(root, podId, ...segments);
  const folderPath = path.join(root, podId, segments[0] ?? '');

  // A served folder that is itself a symlink could point anywhere.
  if (!fs.existsSync(file) || fs.lstatSync(folderPath).isSymbolicLink()) {
    return null;
  }

  // Inside the pod's own folder, never the folder a symlink resolves to.
  const folder = path.join(
    fs.realpathSync(path.join(root, podId)),
    segments[0] ?? ''
  );
  const real = fs.realpathSync(file);

  return real.startsWith(`${folder}${path.sep}`) && fs.statSync(real).isFile()
    ? real
    : null;
};
