import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { lambdaHome } from '../../config/machineConfig';
import {
  PROJECT_CONFIG_FILE,
  type Project,
  ProjectConfigSchema,
} from '../../config/projectConfig';
import { readConfigFile } from '../../config/readConfigFile';
import {
  type BuildResult,
  NoDesignSystemError,
  TAILWIND_NO_CLI,
  buildSystem,
  noDesignSystemMessage,
  notInstalledMessage,
} from './build';
import { workspaceDirs } from './detect';
import { git } from './git';
import { readManifestAt } from './manifest';
import { readProjectId } from './projectId';

/**
 * `lambda design system build --from <ref>`: the design system as committed
 * at a ref, built on this computer without touching the project's own
 * checkout (which may be on another branch, or hold uncommitted edits) and
 * without installing anything. Planning uses it: a pod worktree has no
 * packages installed, so it never builds there.
 *
 *   ~/.lambda/cache/design-system/<project id>/
 *     checkout/        a detached `git worktree` of the project, moved to the
 *                      sha before each build; its node_modules folders are
 *                      symlinks to the project checkout's
 *     checkout.lock    held while a build runs (one build at a time)
 *     <sha>/           one built folder per sha, written to a temporary
 *                      sibling and renamed into place only when it passes
 *     <sha>.not-installed-<token>/  a build made before the project's
 *                      packages (or its Tailwind CLI) were installed here:
 *                      never reused, each in a folder of its own so a later
 *                      build never removes one a pod is still reading; swept
 *                      once a day old
 */

export const LOCK_WAIT_MS = 10 * 60_000;
const LOCK_POLL_MS = 250;
/** How long a look-only build is kept for whoever it was returned to. */
export const LOOK_ONLY_KEEP_MS = 24 * 60 * 60_000;

/** The project's cache folder, under Lambda's id for it. */
export const cacheDirOf = (project: Project, projectName: string): string =>
  path.join(
    lambdaHome(),
    'cache',
    'design-system',
    readProjectId(project, projectName)
  );

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

const codeOf = (error: unknown): unknown =>
  typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;

/** The lock's holder, or null when nobody holds it. */
const readHolder = (lock: string): string | null => {
  try {
    return fs.readFileSync(lock, 'utf8').trim();
  } catch (error) {
    if (codeOf(error) === 'ENOENT') {
      return null;
    }

    throw error;
  }
};

/**
 * Remove a dead holder's lock, unless another waiter has already taken it
 * over: the check and the removal happen under `<lock>.takeover`, which only
 * one waiter can create.
 */
const removeStale = (lock: string, stale: string): boolean => {
  const guard = `${lock}.takeover`;

  try {
    fs.writeFileSync(guard, String(process.pid), { flag: 'wx' });
  } catch (error) {
    if (codeOf(error) !== 'EEXIST') {
      throw error;
    }

    // Another waiter is taking it over; a guard whose taker died goes too.
    const taker = Number(readHolder(guard));

    if (!pidAlive(taker)) {
      fs.rmSync(guard, { force: true });
    }

    return false;
  }

  try {
    if (readHolder(lock) !== stale) {
      return false;
    }

    fs.rmSync(lock, { force: true });

    return true;
  } finally {
    fs.rmSync(guard, { force: true });
  }
};

/** Take the lock file, waiting while a live process holds it. */
export const takeLock = async (
  lock: string,
  projectName: string,
  waitMs: number
): Promise<() => void> => {
  const deadline = Date.now() + waitMs;
  // `<pid>:<token>`: the pid says whether the holder is alive, the token
  // which build holds it (one process can run several).
  const mine = `${process.pid}:${randomUUID()}`;
  const release = (): void => {
    if (readHolder(lock) === mine) {
      fs.rmSync(lock, { force: true });
    }
  };

  const attempt = async (): Promise<() => void> => {
    try {
      fs.writeFileSync(lock, mine, { flag: 'wx' });

      return release;
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') {
        throw error;
      }

      const holder = readHolder(lock);

      // Released between the refused write and the read.
      if (holder === null) {
        return attempt();
      }

      // A build that died leaves its lock behind. An empty lock is held: its
      // taker created it and hasn't written its pid yet.
      if (
        holder !== '' &&
        !pidAlive(Number(holder.split(':')[0])) &&
        removeStale(lock, holder)
      ) {
        return attempt();
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `Another design system build is running for ${projectName}.`
        );
      }

      await sleep(LOCK_POLL_MS);

      return attempt();
    }
  };

  return attempt();
};

/**
 * Remove the half-built `<sha>.building-<pid>` folders of builds that died,
 * and look-only builds over a day old (`<sha>.not-installed` is an older
 * Lambda's name for one).
 */
const removeDeadBuilds = (base: string): void => {
  fs.readdirSync(base).forEach((name) => {
    const at = path.join(base, name);
    const pid = /\.building-(\d+)$/.exec(name)?.[1];

    if (pid !== undefined && !pidAlive(Number(pid))) {
      fs.rmSync(at, { recursive: true, force: true });

      return;
    }

    if (
      /\.not-installed(-[\w-]+)?$/.test(name) &&
      Date.now() - fs.statSync(at).mtimeMs > LOOK_ONLY_KEEP_MS
    ) {
      fs.rmSync(at, { recursive: true, force: true });
    }
  });
};

/** Point each `node_modules` the project checkout has at the build checkout. */
const linkNodeModules = (root: string, checkout: string): void => {
  ['', ...workspaceDirs(root)].forEach((dir) => {
    const from = path.join(root, dir, 'node_modules');
    const to = path.join(checkout, dir, 'node_modules');

    if (!fs.existsSync(from) || !fs.existsSync(path.dirname(to))) {
      return;
    }

    const current = fs.lstatSync(to, { throwIfNoEntry: false });

    if (current?.isSymbolicLink() === true && fs.readlinkSync(to) === from) {
      return;
    }

    fs.rmSync(to, { recursive: true, force: true });
    fs.symlinkSync(from, to, 'dir');
  });
};

/** The build checkout, at `sha`; made the first time. */
const checkoutAt = (root: string, checkout: string, sha: string): void => {
  if (!fs.existsSync(path.join(checkout, '.git'))) {
    fs.rmSync(checkout, { recursive: true, force: true });
    git(root, ['worktree', 'prune']);
    git(root, ['worktree', 'add', '--detach', '--force', checkout, sha]);

    return;
  }

  git(checkout, ['checkout', '--detach', '--force', sha]);
  // Ignored files too, so nothing an earlier build left carries into this
  // one; the node_modules symlinks stay (linkNodeModules keeps them right).
  git(checkout, ['clean', '-ffdx', '-e', 'node_modules']);
};

export interface FromRefResult {
  folder: string;
  /** False when the folder for that sha was already there. */
  built: boolean;
  result?: BuildResult;
}

/**
 * Build `ref` of the project into the cache and return the built folder.
 * Throws NoDesignSystemError when the ref has no manifest.
 */
export const buildFromRef = async ({
  project,
  projectName,
  ref,
  waitMs = LOCK_WAIT_MS,
  log,
}: {
  project: Project;
  projectName: string;
  ref: string;
  waitMs?: number;
  log?: (line: string) => void;
}): Promise<FromRefResult> => {
  const { root } = project;
  const sha = git(root, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${ref}^{commit}`,
  ]);
  const { manifest } = project.config.design.system;

  if (readManifestAt(root, sha, manifest) === null) {
    throw new NoDesignSystemError(noDesignSystemMessage(manifest));
  }

  const base = cacheDirOf(project, projectName);
  const folder = path.join(base, sha);

  if (fs.existsSync(folder)) {
    return { folder, built: false };
  }

  fs.mkdirSync(base, { recursive: true });
  const release = await takeLock(
    path.join(base, 'checkout.lock'),
    projectName,
    waitMs
  );
  const temp = path.join(base, `${sha}.building-${process.pid}`);

  try {
    removeDeadBuilds(base);

    // Another build may have finished it while this one waited.
    if (fs.existsSync(folder)) {
      return { folder, built: false };
    }

    const checkout = path.join(base, 'checkout');
    checkoutAt(root, checkout, sha);
    linkNodeModules(root, checkout);
    const configFile = path.join(checkout, PROJECT_CONFIG_FILE);
    const atRef: Project = {
      root: checkout,
      file: fs.existsSync(configFile) ? configFile : undefined,
      config: fs.existsSync(configFile)
        ? readConfigFile(configFile, ProjectConfigSchema)
        : ProjectConfigSchema.parse({}),
    };
    const result = await buildSystem({
      project: atRef,
      projectName,
      checkout,
      out: temp,
      log,
    });
    // Look only, or esbuild's CSS, because this computer hasn't installed the
    // packages or the Tailwind CLI: true of this computer now, not of the
    // sha. Not kept under it, so the next build after an install is whole.
    const kept =
      result.notes.includes(notInstalledMessage(projectName)) ||
      result.notes.includes(TAILWIND_NO_CLI)
        ? path.join(base, `${sha}.not-installed-${randomUUID()}`)
        : folder;
    fs.renameSync(temp, kept);

    return { folder: kept, built: true, result: { ...result, out: kept } };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    release();
  }
};
