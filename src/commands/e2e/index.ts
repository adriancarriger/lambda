/**
 * E2E command - Run Playwright tests, keeping a trace of every failure.
 *
 * Finds the Playwright config from the current folder upward (stopping at the
 * project root) and runs `npx playwright test` there. lambda.json
 * `commands.e2e` replaces all of this with the project's own command.
 */
import chalk from 'chalk';
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';

import {
  loadProjectConfig,
  mainCheckoutFolder,
} from '../../config/projectConfig';
import { runInherited, shellQuote } from '../../utils/run';

export const PLAYWRIGHT_CONFIGS = [
  'playwright.config.ts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
];

export const NO_PLAYWRIGHT_CONFIG =
  'No Playwright config found. Set commands.e2e in lambda.json.';

/**
 * The folder holding the nearest Playwright config, from `cwd` upward. The
 * search stops at `stopAt` (the project root) when there is one.
 */
export const findPlaywrightDir = (
  cwd: string,
  stopAt: string | undefined
): string | undefined => {
  const hasConfig = (dir: string): boolean =>
    PLAYWRIGHT_CONFIGS.some((name) => fs.existsSync(path.join(dir, name)));
  const search = (dir: string): string | undefined => {
    if (hasConfig(dir)) {
      return dir;
    }

    const parent = path.dirname(dir);

    return dir === stopAt || parent === dir ? undefined : search(parent);
  };

  return search(path.resolve(cwd));
};

/**
 * Where the config search stops: the project root, or, in a linked worktree
 * (whose project root is the main checkout), the same folder in the worktree,
 * so the worktree's own tests run and nothing above it is used.
 */
export const searchStop = (cwd: string, root: string): string => {
  const below = path.relative(root, mainCheckoutFolder(cwd));

  if (below === '' || below.startsWith('..') || path.isAbsolute(below)) {
    return root;
  }

  return path.resolve(cwd, ...below.split(path.sep).map(() => '..'));
};

const passesTrace = (args: string[]): boolean =>
  args.some((arg) => arg === '--trace' || arg.startsWith('--trace='));

/** `npx` argv: Playwright's, plus `--trace retain-on-failure` unless given. */
export const playwrightArgs = (args: string[]): string[] => [
  'playwright',
  'test',
  ...args,
  ...(passesTrace(args) ? [] : ['--trace', 'retain-on-failure']),
];

/**
 * A lambda.json command template with the args in: `{spec}` takes them
 * shell-quoted (empty when there are none); without `{spec}` they're appended.
 */
export const fillCommandTemplate = (
  template: string,
  args: string[]
): string => {
  const quoted = args.map(shellQuote).join(' ');

  if (template.includes('{spec}')) {
    return template.split('{spec}').join(quoted);
  }

  return quoted === '' ? template : `${template} ${quoted}`;
};

/** Run a lambda.json `commands.<name>` through the shell, from the project root. */
export const runCommandTemplate = (
  template: string,
  args: string[],
  root: string
): Promise<number> =>
  runInherited(fillCommandTemplate(template, args), [], {
    cwd: root,
    shell: true,
  });

const runE2E = async (args: string[]): Promise<number> => {
  const project = loadProjectConfig(process.cwd());
  const override = project?.config.commands?.e2e;

  if (project !== null && override !== undefined) {
    return runCommandTemplate(override, args, project.root);
  }

  const dir = findPlaywrightDir(
    process.cwd(),
    project === null ? undefined : searchStop(process.cwd(), project.root)
  );

  if (dir === undefined) {
    console.error(NO_PLAYWRIGHT_CONFIG);

    return 1;
  }

  return runInherited('npx', playwrightArgs(args), { cwd: dir });
};

export const registerE2ECommand = (program: Command): void => {
  program
    .command('e2e')
    .description('Run Playwright tests (traces kept on failure)')
    .allowUnknownOption()
    .helpOption(false)
    .argument('[args...]', 'Arguments passed to Playwright')
    .addHelpText(
      'after',
      `
${chalk.bold('Examples:')}
  lambda e2e budget.spec.ts           Run one spec
  lambda e2e --headed                 Run with a visible browser
  lambda e2e --trace on               Choose the trace mode yourself
`
    )
    .action(async (args: string[]) => {
      process.exitCode = await runE2E(args);
    });
};
