import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { folderSlug } from '../app/shared/folderSlug';
import { runInit, writeLambdaGitignore } from '../commands/init';
import {
  PROJECT_CONFIG_FILE,
  type Project,
  loadProjectConfig,
} from '../config/projectConfig';
import { isGitRepo } from '../pod/base';
import { lambdaPackageDir } from '../process/workflow-file';

/**
 * Add a project / New project, run on the runner of the computer hosting
 * the mothership: the folder is a path on that computer.
 */

export interface ProjectIdentity {
  name: string;
  description: string | null;
  ticketPrefix: string | null;
}

/** `lambda.json` `name`, else `package.json` `name`, else the folder's name. */
export const projectName = (project: Project): string => {
  if (project.config.name !== undefined && project.config.name !== '') {
    return project.config.name;
  }

  try {
    const pkg: unknown = JSON.parse(
      fs.readFileSync(path.join(project.root, 'package.json'), 'utf8')
    );

    if (
      typeof pkg === 'object' &&
      pkg !== null &&
      'name' in pkg &&
      typeof pkg.name === 'string'
    ) {
      return pkg.name;
    }
  } catch {
    // No package.json: the folder's name.
  }

  return path.basename(project.root);
};

export const projectIdentity = (project: Project): ProjectIdentity => ({
  name: projectName(project),
  description: project.config.description ?? null,
  ticketPrefix: project.config.tickets.prefix ?? null,
});

/** `~/x` → the home folder's x. */
export const expandHome = (
  typed: string,
  home: string = os.homedir()
): string =>
  typed === '~'
    ? home
    : typed.startsWith('~/')
    ? path.join(home, typed.slice(2))
    : path.resolve(typed);

export { folderSlug };

/**
 * A folder that isn't in a git repository is set up quietly. Answers whether
 * it made one, so the caller commits once the folder's files are in place.
 */
const ensureGit = (folder: string): boolean => {
  if (isGitRepo(folder)) {
    return false;
  }

  execFileSync('git', ['init', '--quiet'], { cwd: folder, stdio: 'ignore' });

  return true;
};

/** What Lambda writes in a folder it adds: all its first commit may hold. */
const LAMBDA_FILES = [PROJECT_CONFIG_FILE, '.lambda'];

/**
 * The repository's first commit: pods are worktrees at HEAD, which a
 * repository with no commit doesn't have. Only `paths` go in: a folder that
 * was added keeps its own files (`.env`, `node_modules`) out of git.
 */
const commitStart = (folder: string, paths: string[]): void => {
  execFileSync('git', ['add', '--', ...paths], {
    cwd: folder,
    stdio: 'ignore',
  });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Lambda',
      '-c',
      'user.email=lambda@localhost',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'Start',
    ],
    { cwd: folder, stdio: 'ignore' }
  );
};

const loadIdentity = (folder: string): ProjectIdentity => {
  const project = loadProjectConfig(folder);

  if (project === null) {
    throw new Error(`There's no ${PROJECT_CONFIG_FILE} at ${folder}.`);
  }

  return projectIdentity(project);
};

/**
 * Add a project: `lambda init` on the folder (unless it already has a
 * lambda.json, which is registered as it is), plus `git init` when needed.
 */
export const addProject = (options: {
  typed: string;
  /** Folders this runner already holds. */
  known: string[];
  computer: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}): ProjectIdentity & { folder: string } => {
  const folder = expandHome(options.typed.trim(), options.home);

  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    throw new Error(
      `There's no folder at ${options.typed.trim()} on ${options.computer}.`
    );
  }

  if (options.known.map((known) => path.resolve(known)).includes(folder)) {
    throw new Error(`${options.typed.trim()} is already a codebase.`);
  }

  const madeGit = ensureGit(folder);

  if (!fs.existsSync(path.join(folder, PROJECT_CONFIG_FILE))) {
    const result = runInit({ cwd: folder, env: options.env });

    if (result.code !== 0) {
      throw new Error(result.error ?? `lambda init failed in ${folder}.`);
    }
  }

  if (madeGit) {
    commitStart(
      folder,
      LAMBDA_FILES.filter((name) => fs.existsSync(path.join(folder, name)))
    );
  }

  return { ...loadIdentity(folder), folder };
};

export const starterDir = (): string =>
  path.join(lambdaPackageDir(), 'templates', 'starter');

const copyDir = (from: string, to: string): void => {
  fs.mkdirSync(to, { recursive: true });
  fs.readdirSync(from, { withFileTypes: true }).forEach((entry) => {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);

    if (entry.isDirectory()) {
      copyDir(source, target);

      return;
    }

    fs.copyFileSync(source, target);
  });
};

/**
 * New project: `~/Lambda/<name as a slug>` with the starter (a small web
 * app on Node's http, one passing `node --test` test, and its lambda.json).
 * Nothing to install.
 */
export const newProject = (options: {
  name: string;
  home?: string;
  template?: string;
}): ProjectIdentity & { folder: string } => {
  const name = options.name.trim();
  const slug = folderSlug(name);

  if (slug === '') {
    throw new Error('Give the codebase a name.');
  }

  const display = `~/Lambda/${slug}`;
  const folder = path.join(options.home ?? os.homedir(), 'Lambda', slug);

  if (fs.existsSync(folder)) {
    throw new Error(`${display} already exists. Pick another name.`);
  }

  copyDir(options.template ?? starterDir(), folder);
  fs.writeFileSync(
    path.join(folder, PROJECT_CONFIG_FILE),
    `${JSON.stringify(
      {
        name,
        app: { start: 'node server.mjs', url: 'http://localhost:3000' },
        commands: { test: 'node --test' },
        tickets: { source: 'markdown' },
      },
      null,
      2
    )}\n`
  );
  writeLambdaGitignore(folder);

  // Every file here is the starter's, so all of it goes in.
  if (ensureGit(folder)) {
    commitStart(folder, ['.']);
  }

  return { ...loadIdentity(folder), folder };
};
