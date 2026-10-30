/**
 * Scenarios that travel on their ticket. `lambda tickets scenarios pull`
 * (run at pick-up) downloads a ticket's scenarios into
 * `<design.pendingDir>/<ticket>/`, never committed; the ticket's default ship
 * moves them into the tracked library (`design.scenarios`), add-only, where
 * later plans find them.
 */
import * as fs from 'fs';
import * as path from 'path';

import type { Project } from '../config/projectConfig';
import { assertTicketId } from '../tickets/source';
import { scenarioFileParts } from './scenario';

export const pendingRootOf = (project: Project, checkout: string): string =>
  path.resolve(checkout, project.config.design.pendingDir);

export const pendingDirOf = (
  project: Project,
  checkout: string,
  ticketId: string
): string =>
  path.join(pendingRootOf(project, checkout), assertTicketId(ticketId));

export const trackedDirOf = (project: Project, checkout: string): string =>
  path.resolve(checkout, project.config.design.scenarios);

/**
 * The pending folder, with its `.gitignore` of `*` written the first time
 * Lambda writes there, so pending files never ship by accident.
 */
export const ensurePendingDir = (
  project: Project,
  checkout: string,
  ticketId: string
): string => {
  const root = pendingRootOf(project, checkout);
  const ignore = path.join(root, '.gitignore');
  fs.mkdirSync(root, { recursive: true });

  if (!fs.existsSync(ignore)) {
    fs.writeFileSync(ignore, '*\n');
  }

  const dir = pendingDirOf(project, checkout, ticketId);
  fs.mkdirSync(dir, { recursive: true });

  return dir;
};

/** Remove what a move added, so the tree is back as it was. */
export const undoScenarioMove = (added: string[]): void => {
  added.forEach((file) => fs.rmSync(file, { force: true }));
};

export interface ScenarioMove {
  /** The library paths the move added. */
  added: string[];
  /** True when an I/O error stopped it: the pending folder must be kept. */
  failed: boolean;
}

/**
 * Copy a ticket's pending scenarios into the library before its commit is
 * staged. Add-only: a file already in the library is left untouched and
 * reported. Never throws: an I/O error is reported, nothing is added, and
 * `failed` says so.
 */
export const moveScenariosForShip = (
  project: Project,
  checkout: string,
  ticketId: string,
  log: (line: string) => void
): ScenarioMove => {
  const pending = pendingDirOf(project, checkout, ticketId);
  const library = trackedDirOf(project, checkout);

  if (!fs.existsSync(pending)) {
    return { added: [], failed: false };
  }

  const names = fs
    .readdirSync(pending)
    .filter(
      (name) =>
        scenarioFileParts(name)?.ext === project.config.design.scenarioExt
    )
    .sort();
  // What has been copied so far, for the undo if a later one fails.
  const added: { files: string[] } = { files: [] };

  try {
    names.forEach((name) => {
      const target = path.join(library, name);
      const id = scenarioFileParts(name)?.id ?? name;

      if (fs.existsSync(target)) {
        log(`Scenarios: ${id} already in the library — left as is`);

        return;
      }

      fs.mkdirSync(library, { recursive: true });
      fs.copyFileSync(path.join(pending, name), target);
      added.files = [...added.files, target];
    });
  } catch (error) {
    undoScenarioMove(added.files);
    log(
      `Scenarios: ${ticketId}'s pending scenarios skipped (${
        error instanceof Error ? error.message : String(error)
      }).`
    );

    return { added: [], failed: true };
  }

  if (added.files.length > 0) {
    log(
      `Scenarios: adding ${added.files.length} screenshot scenario${
        added.files.length === 1 ? '' : 's'
      } to the library.`
    );
  }

  return { added: added.files, failed: false };
};

/** Delete the ticket's pending folder once its commit has landed. */
export const discardPending = (
  project: Project,
  checkout: string,
  ticketId: string
): void => {
  try {
    fs.rmSync(pendingDirOf(project, checkout, ticketId), {
      recursive: true,
      force: true,
    });
  } catch {
    // A leftover folder only re-reports its ids as already in the library.
  }
};
