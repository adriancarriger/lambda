import { type Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

import { type Project } from '../config/projectConfig';

/** Built into this version, in the order `--help` lists them. */
export const BUILT_IN_COMMANDS = [
  { name: 'init', description: 'Write lambda.json for this codebase' },
  { name: 'doctor', description: 'Show where each command comes from' },
  { name: 'tmux', description: "Send to or read an agent's window" },
  { name: 'await', description: "Wait until an agent's window is done" },
  { name: 'agent', description: 'Compact, clear or inspect an agent' },
  { name: 'e2e', description: 'Run Playwright tests (traces kept on failure)' },
  { name: 'trace', description: "Read a failed test's trace" },
  { name: 'tickets', description: "Read and change the codebase's tickets" },
  { name: 'planning', description: "Show this codebase's planning process" },
  { name: 'building', description: "Show this codebase's building process" },
  {
    name: 'pod',
    description: 'Run planning pods: a planning manager and a dev',
  },
  { name: 'knowledge', description: 'Keep lasting judgements and copy rules' },
  { name: 'start', description: "Start this codebase's services and Lambda" },
  { name: 'stop', description: "Stop this codebase's services and pods" },
  { name: 'open', description: 'Open Lambda in your browser, signed in' },
  { name: 'join', description: 'Make this computer part of your Lambda' },
  { name: 'leave', description: 'Take this computer out of your Lambda' },
  { name: 'status', description: 'What this computer is doing for Lambda' },
  {
    name: 'computer',
    description: 'Debug another computer: read it, pause or talk to its pods',
  },
  { name: 'event', description: 'Record an event for the Analytics page' },
  { name: 'account', description: 'The logins that count as you' },
  {
    name: 'verdict',
    description: "Record or read a ticket's check-ticket verdict",
  },
  { name: 'ship', description: 'Ship a ticket behind its verdict' },
  { name: 'design', description: 'Render Claude Design artboards to PNGs' },
  { name: 'shot', description: 'Photograph the app in a screenshot scenario' },
  { name: 'connect', description: 'Connect Claude, Linear or Jira' },
  { name: 'upgrade', description: 'Update Lambda to the newest version' },
  { name: 'internal', description: "Lambda's own plumbing (not for people)" },
] as const;

/**
 * Core commands can't be replaced by a drop-in, including the ones a later
 * version adds: a drop-in can never hijack them, and `ship` always runs
 * behind its verdict gate (`verdict` writes what that gate reads).
 */
export const CORE_COMMANDS = [
  'pod',
  'tickets',
  'start',
  'join',
  'ship',
  'verdict',
  'knowledge',
  'doctor',
  'init',
  'stop',
  'open',
  'event',
  'status',
  'leave',
  'account',
  'planning',
  'building',
  'connect',
  'upgrade',
  'internal',
] as const;

/** `lambda.json` `commands.<name>` replaces these. */
export const CONFIG_OVERRIDABLE = ['e2e', 'test'] as const;

export const DROP_IN_DIR = path.join('.lambda', 'commands');

/** When two drop-ins share a name, the first extension here wins. */
export const DROP_IN_EXTENSIONS = ['.ts', '.js', '.cjs', '.mjs'] as const;

const builtInNames: readonly string[] = BUILT_IN_COMMANDS.map(
  (command) => command.name
);

const coreNames: readonly string[] = CORE_COMMANDS;

export const isBuiltIn = (name: string): boolean => builtInNames.includes(name);

export const isCore = (name: string): boolean => coreNames.includes(name);

export type Resolution =
  | { kind: 'built-in'; name: string }
  /** A core name that isn't built in this version. */
  | { kind: 'unavailable'; name: string }
  /** A drop-in with a core command's name: never loaded. */
  | { kind: 'refused'; name: string; file: string }
  | { kind: 'drop-in'; name: string; file: string }
  | { kind: 'config'; name: string; key: string; command: string }
  | { kind: 'project-cli'; name: string; cli: string }
  /** Not ours, and no project CLI to hand it to. */
  | { kind: 'unknown'; name: string };

/** A name a drop-in file can give a command. */
const DROP_IN_NAME = /^[a-z0-9][a-z0-9-]*$/i;

/** The drop-in file for `name`, as a path from the project root. */
export const findDropIn = (
  project: Project | null,
  name: string
): string | undefined => {
  if (project === null || !DROP_IN_NAME.test(name)) {
    return undefined;
  }

  return DROP_IN_EXTENSIONS.map((extension) =>
    path.join(DROP_IN_DIR, `${name}${extension}`)
  ).find((file) => fs.existsSync(path.join(project.root, file)));
};

/** A drop-in file's command name, when `findDropIn` could ever find it. */
const dropInName = (file: string): string | undefined => {
  const extension = DROP_IN_EXTENSIONS.find(
    (ext) => path.extname(file) === ext
  );

  if (extension === undefined) {
    return undefined;
  }

  const name = file.slice(0, file.length - extension.length);

  return DROP_IN_NAME.test(name) ? name : undefined;
};

/**
 * Every drop-in's command name in the project's `.lambda/commands/`. Throws
 * `Can't read <dir>: <reason>` when that path isn't a readable folder.
 */
export const listDropInNames = (project: Project | null): string[] => {
  if (project === null) {
    return [];
  }

  const dir = path.join(project.root, DROP_IN_DIR);

  if (!fs.existsSync(dir)) {
    return [];
  }

  const files = readDropInDir(dir);
  const names = files.flatMap((file) => dropInName(file) ?? []);

  return Array.from(new Set(names)).sort();
};

const readDropInDir = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : errorMessage(error);

    throw new Error(`Can't read ${DROP_IN_DIR}: ${code}`);
  }
};

const configOverride = (
  project: Project | null,
  name: string
): string | undefined => {
  const commands = project?.config.commands;

  if (name === 'e2e') {
    return commands?.e2e;
  }

  return name === 'test' ? commands?.test : undefined;
};

/**
 * Which source runs `lambda <name>`: core built-ins, then a drop-in from
 * `.lambda/commands/`, then a `lambda.json` override (`e2e`/`test`), then the
 * built-in default, then the project's own CLI.
 */
export const resolveCommand = (
  name: string,
  project: Project | null
): Resolution => {
  const dropIn = findDropIn(project, name);

  if (isCore(name)) {
    if (dropIn !== undefined) {
      return { kind: 'refused', name, file: dropIn };
    }

    return isBuiltIn(name)
      ? { kind: 'built-in', name }
      : { kind: 'unavailable', name };
  }

  if (dropIn !== undefined) {
    return { kind: 'drop-in', name, file: dropIn };
  }

  const override = configOverride(project, name);

  if (override !== undefined) {
    return { kind: 'config', name, key: `commands.${name}`, command: override };
  }

  if (isBuiltIn(name)) {
    return { kind: 'built-in', name };
  }

  const cli = project?.config.cli;

  return cli === undefined
    ? { kind: 'unknown', name }
    : { kind: 'project-cli', name, cli };
};

export const refusedMessage = (file: string, name: string): string =>
  `Refused drop-in ${file}: ${name} is a core command and can't be replaced.`;

export const unavailableMessage = (name: string): string =>
  `lambda ${name} isn't available in this version.`;

/** A thrown value's message, even from another realm (jiti, vm). */
const errorMessage = (error: unknown): string =>
  typeof error === 'object' &&
  error !== null &&
  'message' in error &&
  typeof error.message === 'string'
    ? error.message
    : String(error);

export type RegisterCommand = (program: Command) => void;

const nativeImport = async (file: string): Promise<unknown> =>
  import(pathToFileURL(file).href);

const importDropIn = async (file: string): Promise<unknown> => {
  if (file.endsWith('.ts')) {
    const { createJiti } = await import('jiti');

    return createJiti(__filename).import(file);
  }

  return nativeImport(file);
};

const registerExport = (loaded: unknown): RegisterCommand | undefined => {
  if (typeof loaded !== 'object' || loaded === null) {
    return undefined;
  }

  if ('register' in loaded && typeof loaded.register === 'function') {
    const { register } = loaded;

    return (program) => register(program);
  }

  return 'default' in loaded ? registerExport(loaded.default) : undefined;
};

/**
 * Load one drop-in and return its `register(program)`. Throws
 * `Drop-in <file> failed to load: <reason>`.
 */
export const loadDropIn = async (
  project: Project,
  file: string
): Promise<RegisterCommand> => {
  const loaded = await importDropIn(path.join(project.root, file)).catch(
    (error: unknown) => {
      throw new Error(`Drop-in ${file} failed to load: ${errorMessage(error)}`);
    }
  );
  const register = registerExport(loaded);

  if (register === undefined) {
    throw new Error(`Drop-in ${file} failed to load: no register export`);
  }

  return register;
};
