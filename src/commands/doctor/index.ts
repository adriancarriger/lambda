/**
 * Doctor command - Show where each command comes from.
 *
 * Every command shows which source wins (built in, a drop-in, lambda.json or
 * the project CLI), so a drop-in or override is never a surprise. It always
 * exits 0, even when a settings file is invalid, and never prints a token.
 */
import { Command } from 'commander';
import * as os from 'os';
import * as path from 'path';

import {
  loadMachineConfig,
  machineConfigPath,
} from '../../config/machineConfig';
import { type Project, loadProjectConfig } from '../../config/projectConfig';
import { appBundle, browsersDir } from '../../desktop/appPaths';
import {
  BUILT_IN_COMMANDS,
  type Resolution,
  isBuiltIn,
  listDropInNames,
  loadDropIn,
  resolveCommand,
} from '../../dispatch/resolve';
import { chromiumInstalled } from '../../setup/chromium';
import { expiresOn, expiryDay, renewalState } from '../../setup/tokenExpiry';
import { onPath } from '../../utils/onPath';
import { processLines } from './process';

export interface DoctorOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

const TOOLS = ['tmux', 'git', 'node', 'claude'];

const tildePath = (file: string): string => {
  const home = os.homedir();

  return file === home || file.startsWith(`${home}${path.sep}`)
    ? `~${file.slice(home.length)}`
    : file;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const loadProject = (
  cwd: string
): { project: Project | null; line: string } => {
  try {
    const project = loadProjectConfig(cwd);

    if (project === null) {
      return { project, line: 'none (run lambda init)' };
    }

    const source =
      project.file === undefined ? 'TASKS.md, no lambda.json' : 'lambda.json';

    return {
      project,
      line: `${tildePath(project.root).padEnd(25)} (${source})`,
    };
  } catch (error) {
    return { project: null, line: errorMessage(error) };
  }
};

const youLine = (env: NodeJS.ProcessEnv): string => {
  const file = tildePath(machineConfigPath(env));

  try {
    const config = loadMachineConfig(env);

    if (config === null) {
      return `none (no ${file}; run lambda init --name "<your name>")`;
    }

    return `${(config.owner?.name ?? '(no owner.name)').padEnd(25)} ${file}`;
  } catch (error) {
    return errorMessage(error);
  }
};

/** The Claude sign-in and when it runs out (never the token). */
export const claudeLine = (
  env: NodeJS.ProcessEnv,
  now: number = Date.now(),
  /** The clock's time zone (an IANA name, for tests); default: here. */
  zone?: string
): string => {
  try {
    const token = loadMachineConfig(env)?.tokens?.claude;

    if (token === undefined || token.value === '') {
      return 'not connected (run lambda connect claude)';
    }

    if (token.createdAt === undefined) {
      return 'connected (no date: run lambda connect claude to see when it runs out)';
    }

    const expires = expiresOn(token.createdAt);
    const day = expiryDay(expires, zone);

    switch (renewalState(expires, now)) {
      case 'fine':
        return `connected · runs out on ${day}`;
      case 'soon':
        return `connected · runs out on ${day}: run lambda connect claude soon`;
      case 'expired':
        return `ran out on ${day}: run lambda connect claude`;
    }
  } catch (error) {
    return errorMessage(error);
  }
};

/** Where Playwright keeps browsers: the app's folder, the env, or its own cache. */
const playwrightBrowsers = (env: NodeJS.ProcessEnv): string => {
  const fromEnv = env.PLAYWRIGHT_BROWSERS_PATH;

  if (fromEnv !== undefined && fromEnv !== '' && fromEnv !== '0') {
    return fromEnv;
  }

  if (appBundle(env) !== null) {
    return browsersDir();
  }

  return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
    : path.join(os.homedir(), '.cache', 'ms-playwright');
};

/** Why a drop-in failed to load, without the `Drop-in <file>` prefix. */
const loadFailure = async (
  project: Project,
  file: string
): Promise<string | undefined> => {
  try {
    await loadDropIn(project, file);

    return undefined;
  } catch (error) {
    return errorMessage(error).replace(`Drop-in ${file} failed to load: `, '');
  }
};

const describeSource = async (
  resolution: Resolution,
  project: Project | null
): Promise<string[]> => {
  switch (resolution.kind) {
    case 'built-in':
      return ['built in'];
    case 'refused':
      return [
        `refused drop-in: ${resolution.file}`,
        `(${resolution.name} is a core command and can't be replaced)`,
      ];
    case 'drop-in': {
      const failure =
        project === null
          ? undefined
          : await loadFailure(project, resolution.file);

      return [
        failure === undefined
          ? `drop-in: ${resolution.file}`
          : `broken drop-in: ${resolution.file} (${failure})`,
      ];
    }
    case 'config':
      return [`lambda.json: ${resolution.key}`];
    case 'project-cli':
      return [`codebase CLI: ${resolution.cli}`];
    case 'unavailable':
      return ['not available in this version'];
    case 'unknown':
      return ['not set'];
  }
};

/** Drop-in names, or the reason the folder can't be read (shown, not thrown). */
const dropIns = (
  project: Project | null
): { names: string[]; error?: string } => {
  try {
    return { names: listDropInNames(project) };
  } catch (error) {
    return { names: [], error: errorMessage(error) };
  }
};

const commandNames = (
  project: Project | null,
  dropInNames: string[]
): string[] => {
  const builtIns = BUILT_IN_COMMANDS.map((command) => command.name);
  const extras = [
    ...(project?.config.commands?.test === undefined ? [] : ['test']),
    ...dropInNames.filter((name) => !isBuiltIn(name)),
  ];

  return [...builtIns, ...Array.from(new Set(extras))];
};

const playwrightFound = (from: string): boolean => {
  try {
    require.resolve('@playwright/test', { paths: [from] });

    return true;
  } catch {
    return false;
  }
};

export const runDoctor = async (options: DoctorOptions): Promise<string[]> => {
  const env = options.env ?? process.env;
  const { project, line: projectLine } = loadProject(options.cwd);
  const dropInList = dropIns(project);

  const commandLines = await Promise.all(
    commandNames(project, dropInList.names).map(async (name) => {
      const [first, ...rest] = await describeSource(
        resolveCommand(name, project),
        project
      );

      return [
        `  ${name.padEnd(8)} ${first ?? ''}`,
        ...rest.map((line) => `  ${''.padEnd(8)} ${line}`),
      ];
    })
  );

  const cli = project?.config.cli;
  const tools = [
    ...TOOLS.map((tool) => `${onPath(tool, env) ? '✓' : '✗'} ${tool}`),
    `${playwrightFound(project?.root ?? options.cwd) ? '✓' : '✗'} Playwright`,
    `${
      chromiumInstalled(playwrightBrowsers(env)) ? '✓' : '✗'
    } Playwright's browser`,
  ];

  return [
    `Codebase ${projectLine}`,
    `You      ${youLine(env)}`,
    `Claude   ${claudeLine(env)}`,
    '',
    'Commands',
    ...(dropInList.error === undefined ? [] : [`  ${dropInList.error}`]),
    ...commandLines.flat(),
    `  ${'*'.padEnd(8)} ${
      cli === undefined
        ? 'no codebase CLI (set "cli" in lambda.json)'
        : `codebase CLI: ${cli}`
    }`,
    ...(project === null ? [] : ['', ...processLines(project.root)]),
    '',
    'Tools',
    `  ${tools.join('   ')}`,
  ];
};

export const registerDoctorCommand = (program: Command): void => {
  program
    .command('doctor')
    .description('Show where each command comes from')
    .action(async () => {
      const lines = await runDoctor({ cwd: process.cwd() });
      lines.forEach((line) => console.log(line));
      process.exitCode = 0;
    });
};
