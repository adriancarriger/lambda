import * as fs from 'fs';
import * as path from 'path';

import { HttpError } from '../mothership/relay';

/**
 * Setup only ever uses folders inside the home folder of the person running
 * the mothership. Every path is checked after `fs.realpath`, so `~/../` and a
 * symlink out of home are refused like `/etc`. The folder list in a browser
 * and the project POST use the same check, so one can't get past the other.
 */

export const HOME_ONLY = 'Lambda can only use folders inside your home folder.';
export const NO_SUCH_FOLDER = "That folder doesn't exist.";
export const CANT_OPEN = "Lambda can't open that folder.";
export const HIDDEN_FOLDER = "Lambda can't use hidden folders.";
export const NOT_ALL_OF_HOME =
  "Lambda can't use your whole home folder: pick a folder inside it.";

const codeOf = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : '';

const isWithin = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(`${parent}${path.sep}`);

/** `~` and `~/x` from home; anything relative is relative to home too. */
const expand = (requested: string, home: string): string => {
  if (requested === '' || requested === '~') {
    return home;
  }

  if (requested.startsWith('~/')) {
    return path.join(home, requested.slice(2));
  }

  return path.resolve(home, requested);
};

/**
 * The real path of `requested`, which must be an existing folder inside
 * `home`. Throws a 403 (outside home, unreadable) or a 404 (missing, a file).
 */
export const folderInsideHome = (
  requested: string,
  home: string,
  /** The folder list starts at home; a project never is home itself. */
  options: { allowHome?: boolean } = {}
): string => {
  const realHome = fs.realpathSync(home);
  const wanted = expand(requested, home);

  const real = ((): string => {
    try {
      return fs.realpathSync(wanted);
    } catch (error) {
      // Unreadable or missing: say so only when it would have been inside home.
      const lexical = path.resolve(wanted);

      if (!isWithin(lexical, home) && !isWithin(lexical, realHome)) {
        throw new HttpError(403, HOME_ONLY);
      }

      throw codeOf(error) === 'EACCES'
        ? new HttpError(403, CANT_OPEN)
        : new HttpError(404, NO_SUCH_FOLDER);
    }
  })();

  if (!isWithin(real, realHome)) {
    throw new HttpError(403, HOME_ONLY);
  }

  // The list leaves dot-folders out; a path posted or typed can't get to one
  // (`~/.ssh`, or a link to it) either.
  if (
    path
      .relative(realHome, real)
      .split(path.sep)
      .some((part) => part.startsWith('.'))
  ) {
    throw new HttpError(403, HIDDEN_FOLDER);
  }

  // Never all of home: `git add -A` there would take in .ssh and the rest.
  if (real === realHome && options.allowHome !== true) {
    throw new HttpError(403, NOT_ALL_OF_HOME);
  }

  if (!fs.statSync(real).isDirectory()) {
    throw new HttpError(404, NO_SUCH_FOLDER);
  }

  return real;
};

/** A name under home the person may pick for "Start something new". */
export const checkProjectName = (name: string): string => {
  const trimmed = name.trim();

  // A leading dot covers `.` and `..`, and a hidden folder the list leaves out.
  if (
    trimmed === '' ||
    trimmed.startsWith('.') ||
    trimmed.includes('/') ||
    trimmed.includes('\0')
  ) {
    throw new HttpError(400, "That name can't be a folder name.");
  }

  return trimmed;
};

export interface FolderListing {
  /** The listed folder's real path. */
  path: string;
  /** Its parent, while that is still inside home; null at home itself. */
  parent: string | null;
  home: string;
  /** Child folder names, sorted, without hidden ones. */
  folders: string[];
}

/** A folder, or a symlink to one that is still inside home (else picking it is refused). */
const isFolder = (dir: string, entry: fs.Dirent, realHome: string): boolean => {
  if (entry.isDirectory()) {
    return true;
  }

  if (!entry.isSymbolicLink()) {
    return false;
  }

  try {
    const target = fs.realpathSync(path.join(dir, entry.name));

    return isWithin(target, realHome) && fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
};

/** The folders in `requested` (default: home), for the browser's picker. */
export const listFolders = (requested: string, home: string): FolderListing => {
  const realHome = fs.realpathSync(home);
  const real = folderInsideHome(requested, home, { allowHome: true });

  const entries = ((): fs.Dirent[] => {
    try {
      return fs.readdirSync(real, { withFileTypes: true });
    } catch (error) {
      if (codeOf(error) === 'EACCES' || codeOf(error) === 'EPERM') {
        throw new HttpError(403, CANT_OPEN);
      }

      throw error;
    }
  })();

  return {
    path: real,
    parent: real === realHome ? null : path.dirname(real),
    home: realHome,
    folders: entries
      .filter((entry) => !entry.name.startsWith('.'))
      .filter((entry) => isFolder(real, entry, realHome))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b)),
  };
};
