import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  type MachineConfig,
  loadMachineConfig,
  writeMachineConfig,
} from '../config/machineConfig';
import { LAMBDA_GITIGNORE, PROJECT_CONFIG_FILE } from '../config/projectConfig';
import { HttpError } from '../mothership/relay';
import { readRunnerState } from '../runner/localFiles';
import { checkProjectName, folderInsideHome } from './folders';

/**
 * First run: Connect Claude, pick or make a project folder, choose where its
 * tickets live. Where it stopped lives in `~/.lambda/config.json`
 * (`firstRun`) and the project's lambda.json, never in the browser, so
 * quitting half-way resumes at the first unfinished step in any window.
 */

type Env = Record<string, string | undefined>;

export type SetupStep = 'claude' | 'project' | 'tickets';

/** New projects go here: `~/Lambda/<name>`. */
export const PROJECTS_FOLDER = 'Lambda';

/** What a project folder that has no .gitignore gets. */
export const DEFAULT_GITIGNORE = [
  'node_modules/',
  '.env*',
  '.DS_Store',
  'dist/',
];

/** The first commit in a folder Lambda put under git. */
export const FIRST_COMMIT_AUTHOR = {
  name: 'Lambda',
  email: 'lambda@localhost',
};

/** Read, change and write `~/.lambda/config.json`. */
export const updateMachineConfig = (
  change: (config: MachineConfig) => MachineConfig,
  env: Env = process.env
): MachineConfig => {
  const next = change(loadMachineConfig(env) ?? {});
  writeMachineConfig(next, env);

  return next;
};

const projectsOf = (config: MachineConfig | null) =>
  config?.firstRun?.projects ?? {};

/**
 * The project setup is working on: the newest one whose tickets step isn't
 * done, else the newest one picked. A folder that no longer exists is
 * skipped, so a deleted one never holds the Tickets step.
 */
export const currentProject = (config: MachineConfig | null): string | null => {
  const entries = Object.entries(projectsOf(config)).filter(
    ([root, state]) => state.project && fs.existsSync(root)
  );
  const unfinished = entries.filter(([, state]) => !state.tickets);

  return (unfinished.at(-1) ?? entries.at(-1))?.[0] ?? null;
};

export interface StepsDone {
  claude: boolean;
  project: boolean;
  tickets: boolean;
}

export const stepsDone = (
  config: MachineConfig | null,
  env: Env = process.env
): StepsDone => {
  // A computer set up before first run existed has no `firstRun`: a saved
  // token, and a project it is on that has a lambda.json, count as done.
  const claude =
    config?.firstRun?.claude ?? (config?.tokens?.claude?.value ?? '') !== '';
  const registered = readRunnerState(env).current;
  const project = currentProject(config) ?? registered;
  const state = project === null ? undefined : projectsOf(config)[project];

  if (state !== undefined || project === null) {
    return {
      claude,
      project: state?.project === true,
      tickets: state?.tickets === true,
    };
  }

  const setUp = fs.existsSync(path.join(project, PROJECT_CONFIG_FILE));

  return { claude, project: setUp, tickets: setUp };
};

/** Where setup resumes: the first unfinished step, or null when all are done. */
export const resumeStep = (
  config: MachineConfig | null,
  env: Env = process.env
): SetupStep | null => {
  const done = stepsDone(config, env);

  return (
    (['claude', 'project', 'tickets'] as const).find((step) => !done[step]) ??
    null
  );
};

export const markProject = (
  root: string,
  change: Partial<{ project: boolean; tickets: boolean }>,
  env: Env = process.env
): MachineConfig =>
  updateMachineConfig((config) => {
    const projects = projectsOf(config);
    const { [root]: existing, ...others } = projects;

    return {
      ...config,
      firstRun: {
        ...config.firstRun,
        // Re-added last, so it is the newest.
        projects: {
          ...others,
          [root]: {
            project: existing?.project ?? false,
            tickets: existing?.tickets ?? false,
            ...change,
          },
        },
      },
    };
  }, env);

export interface ProjectDeps {
  home: string;
  env: Env;
  /** Runs (bundled) git in `cwd`; answers stdout, rejects on failure. */
  git: (args: string[], cwd: string) => string | Promise<string>;
  /** `lambda init` in `cwd`, which never prompts. */
  init: (
    cwd: string
  ) =>
    | { code: number; error?: string }
    | Promise<{ code: number; error?: string }>;
}

/** A git step taking longer than this is stuck, not slow. */
export const PROJECT_GIT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The real git for the Project step: in a child process the mothership
 * doesn't wait on, so `git add -A` on a big folder never stops its other
 * requests.
 */
export const projectGit =
  (env: Env) =>
  (args: string[], cwd: string): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        {
          cwd,
          env,
          encoding: 'utf8',
          timeout: PROJECT_GIT_TIMEOUT_MS,
          maxBuffer: 64 * 1024 * 1024,
        },
        (error, stdout) => (error === null ? resolve(stdout) : reject(error))
      );
    });

export type ProjectRequest = { folder: string } | { name: string };

/** A repo of its own: not merely a folder inside some other repo (a home under git). */
const isRepo = async (deps: ProjectDeps, root: string): Promise<boolean> => {
  try {
    const top = (await deps.git(['rev-parse', '--show-toplevel'], root)).trim();

    return fs.realpathSync(top) === fs.realpathSync(root);
  } catch {
    return false;
  }
};

/** Does the repo have a commit? A `git init`ed one may not, and pods need one. */
const hasCommit = async (deps: ProjectDeps, root: string): Promise<boolean> => {
  try {
    await deps.git(['rev-parse', '--verify', '--quiet', 'HEAD'], root);

    return true;
  } catch {
    return false;
  }
};

/**
 * Lambda's first commit, authored by Lambda on that one command (the
 * person's own git config is never changed). With `only`, just those paths,
 * for a repo the person made: whatever else they staged stays theirs.
 */
const firstCommit = (
  deps: ProjectDeps,
  root: string,
  only?: string[]
): string | Promise<string> =>
  deps.git(
    [
      '-c',
      `user.name=${FIRST_COMMIT_AUTHOR.name}`,
      '-c',
      `user.email=${FIRST_COMMIT_AUTHOR.email}`,
      '-c',
      'commit.gpgsign=false',
      // The person's hooks are for their own commits, not this one.
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'First commit',
      ...(only === undefined ? [] : ['--only', '--', ...only]),
    ],
    root
  );

/**
 * A folder that wasn't under git: a default .gitignore if it has none, and
 * one first commit of everything in it (`lambda init`'s files included).
 */
const commitNewRepo = async (
  deps: ProjectDeps,
  root: string
): Promise<void> => {
  const gitignore = path.join(root, '.gitignore');

  if (!fs.existsSync(gitignore)) {
    fs.writeFileSync(gitignore, `${DEFAULT_GITIGNORE.join('\n')}\n`);
  }

  await deps.git(['add', '-A'], root);
  await firstCommit(deps, root);
};

/** A repo the person made with no commit yet: only Lambda's own files. */
const commitLambdaFiles = async (
  deps: ProjectDeps,
  root: string
): Promise<void> => {
  const own = [PROJECT_CONFIG_FILE, LAMBDA_GITIGNORE].filter((file) =>
    fs.existsSync(path.join(root, file))
  );

  await deps.git(['add', '--', ...own], root);
  await firstCommit(deps, root, own);
};

/** `lambda init` once: a folder that has a lambda.json keeps it. */
const initProject = async (deps: ProjectDeps, root: string): Promise<void> => {
  if (fs.existsSync(path.join(root, PROJECT_CONFIG_FILE))) {
    return;
  }

  const result = await deps.init(root);

  if (result.code !== 0) {
    throw new Error(result.error ?? `lambda init failed in ${root}`);
  }
};

/**
 * The project folder for a request: a chosen one, or a new `~/Lambda/<name>`
 * (`created`), made only once `~/Lambda` is known to be inside home.
 */
const projectFolder = (
  request: ProjectRequest,
  deps: ProjectDeps
): { root: string; created: boolean } => {
  if ('folder' in request) {
    return {
      root: folderInsideHome(request.folder, deps.home),
      created: false,
    };
  }

  const name = checkProjectName(request.name);
  const parent = path.join(deps.home, PROJECTS_FOLDER);
  const folder = path.join(parent, name);

  if (fs.existsSync(parent)) {
    folderInsideHome(parent, deps.home);
  }

  if (fs.existsSync(folder)) {
    throw new HttpError(409, `~/${PROJECTS_FOLDER}/${name} already exists.`);
  }

  fs.mkdirSync(parent, { recursive: true });
  fs.mkdirSync(folder);

  return { root: folderInsideHome(folder, deps.home), created: true };
};

/** The Project step: the folder, under git, with a lambda.json. */
export const setupProject = async (
  request: ProjectRequest,
  deps: ProjectDeps
): Promise<{ root: string }> => {
  const { root, created } = projectFolder(request, deps);

  try {
    const repo = await isRepo(deps, root);
    const committed = repo && (await hasCommit(deps, root));

    if (!repo) {
      await deps.git(['init', '-q'], root);
    }

    // Before the first commit, so `lambda init`'s files are in it: left out,
    // they were uncommitted changes that held every first pick-up.
    await initProject(deps, root);

    if (!repo) {
      await commitNewRepo(deps, root);
    } else if (!committed) {
      await commitLambdaFiles(deps, root);
    }
  } catch (error) {
    // A new folder whose setup failed is removed, so the name can be tried
    // again; a folder the person chose is never touched.
    if (created) {
      fs.rmSync(root, { recursive: true, force: true });
    }

    throw error;
  }

  markProject(root, { project: true }, deps.env);

  return { root };
};
