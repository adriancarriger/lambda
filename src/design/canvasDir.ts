import * as fs from 'fs';
import * as path from 'path';

import { DESIGN_SLUG } from './loop';

/**
 * Where a screen's canvas source lives: `<pod working folder>/.lambda/design/
 * <screen-slug>/canvas/`, inside the folder the Artifact tool publishes from.
 * Lambda writes `.lambda/design/.gitignore` = `*` wherever it creates or
 * writes into that folder, so a canvas never ships with the project and the
 * project's own `.gitignore` needs no change.
 *
 * Pictures and records are elsewhere, on the pods root:
 * `<pods root>/<pod-id>/designs/<screen-slug>/` (see screenDir.ts).
 */

export const DESIGN_FOLDER = path.join('.lambda', 'design');

/** The canvas folder for one screen under a pod's working folder. */
export const canvasDirFor = (workDir: string, slug: string): string => {
  if (!DESIGN_SLUG.test(slug)) {
    throw new Error(
      `Screen slug ${JSON.stringify(slug)} must match ${DESIGN_SLUG}.`
    );
  }

  return path.join(path.resolve(workDir), DESIGN_FOLDER, slug, 'canvas');
};

/**
 * The `.lambda/design/` folder `dir` sits in, or null when it isn't inside
 * one (a canvas kept somewhere else is left alone).
 */
export const designFolderOf = (dir: string): string | null => {
  const parts = path.resolve(dir).split(path.sep);
  const at = parts.findIndex(
    (part, index) => part === '.lambda' && parts[index + 1] === 'design'
  );

  return at === -1 ? null : parts.slice(0, at + 2).join(path.sep) || null;
};

/** Write `.lambda/design/.gitignore` = `*` for a canvas inside one, if missing. */
export const ensureDesignGitignore = (canvasDir: string): void => {
  const folder = designFolderOf(canvasDir);

  if (folder === null) {
    return;
  }

  const file = path.join(folder, '.gitignore');

  if (!fs.existsSync(file)) {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(file, '*\n');
  }
};

/** Make a screen's canvas folder (and the `.gitignore` beside it); returns it. */
export const ensureCanvasDir = (workDir: string, slug: string): string => {
  const dir = canvasDirFor(workDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  ensureDesignGitignore(dir);

  return dir;
};
