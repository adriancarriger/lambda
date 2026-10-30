/**
 * `lambda shot <id> --out <png>`, `lambda shot search <words…>` and
 * `lambda shot check <file>`: the photo hook run for one scenario, and the
 * file-only ways to find and check scenarios.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { type Project, mainCheckoutFolder } from '../config/projectConfig';
import { NO_PHOTO_HOOK, PNG_SIGNATURE, runPhotoHook } from './hook';
import { findScenario, listScenarioEntries, scenarioRootsFor } from './lookup';
import {
  assertScenarioId,
  checkScenarioFile,
  searchScenarios,
} from './scenario';

type Env = Record<string, string | undefined>;

export interface ShotDeps {
  project: Project;
  /** The root of the checkout the command runs in (a pod's worktree, say). */
  checkout: string;
  env: Env;
  print: (line: string) => void;
  printError: (line: string) => void;
  /** The hook's output as it runs; stderr by default. */
  showOutput?: (chunk: string) => void;
  timeoutMs?: number;
}

const realpath = (file: string): string => {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
};

/**
 * The project's folder in the checkout `cwd` is in (a pod's worktree, say):
 * its git toplevel plus where the project sits below the main checkout's, so
 * a project below the toplevel reads its own `design.*` folders. Not in git:
 * the project root.
 */
export const checkoutRootOf = (cwd: string, projectRoot: string): string => {
  const toplevel = (() => {
    try {
      return execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  })();

  if (toplevel === null) {
    return projectRoot;
  }

  const below = path.relative(
    realpath(mainCheckoutFolder(toplevel)),
    realpath(projectRoot)
  );

  return below.startsWith('..') || path.isAbsolute(below)
    ? toplevel
    : path.join(toplevel, below);
};

/** Does the file start with the PNG signature? (A missing one doesn't.) */
const startsAsPng = (file: string): boolean => {
  try {
    const head = Buffer.alloc(PNG_SIGNATURE.length);
    const fd = fs.openSync(file, 'r');

    try {
      fs.readSync(fd, head, 0, head.length, 0);

      return head.equals(PNG_SIGNATURE);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
};

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export type ShotOutcome =
  | { kind: 'shot'; out: string }
  /** The project has no `commands.shot`. */
  | { kind: 'no-hook' }
  /** A bad or unknown id, a broken scenario, or a failed hook. */
  | { kind: 'failed'; reason: string; tail: string[] };

const failed = (reason: string, tail: string[] = []): ShotOutcome => ({
  kind: 'failed',
  reason,
  tail,
});

/** Photograph one scenario to `out`; never throws. */
export const shootScenario = async (
  rawId: string,
  rawOut: string,
  deps: Omit<ShotDeps, 'print' | 'printError'>
): Promise<ShotOutcome> => {
  const id = (() => {
    try {
      return assertScenarioId(rawId);
    } catch (error) {
      return new Error(message(error));
    }
  })();

  if (id instanceof Error) {
    return failed(id.message);
  }

  const template = deps.project.config.commands?.shot;

  if (template === undefined) {
    return { kind: 'no-hook' };
  }

  const found = (() => {
    try {
      return findScenario(
        id,
        scenarioRootsFor(deps.project, deps.checkout, deps.env)
      );
    } catch (error) {
      return new Error(message(error));
    }
  })();

  if (found instanceof Error) {
    return failed(found.message);
  }

  const { scenario, problems } = checkScenarioFile(found.file);

  if (scenario === null) {
    return failed(
      `${found.file} isn't a valid scenario: ${problems.join(' ')}`
    );
  }

  const out = path.resolve(deps.checkout, rawOut);

  // Only an earlier picture is replaced: a typo must never delete a file.
  if (fs.existsSync(out) && fs.statSync(out).isFile() && !startsAsPng(out)) {
    return failed(
      `${out} already exists and isn't a PNG, so Lambda won't overwrite it. Pick another --out.`
    );
  }

  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    // A picture left from an earlier run must never pass for this one.
    fs.rmSync(out, { force: true });
  } catch (error) {
    return failed(
      `Can't write the picture to ${out}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const result = await runPhotoHook(
    template,
    { scenario: found.file, id, viewport: scenario.viewport, out },
    {
      cwd: deps.checkout,
      timeoutMs: deps.timeoutMs,
      showOutput: deps.showOutput ?? ((chunk) => process.stderr.write(chunk)),
    }
  );

  return result.ok ? { kind: 'shot', out } : failed(result.reason, result.tail);
};

/**
 * `lambda shot <id> --out <png>`. 0 with the PNG written (its path printed);
 * 1 for a bad or unknown id or a failed hook (with its last 20 lines); 2 when
 * the project has no photo hook.
 */
export const runShot = async (
  rawId: string,
  options: { out: string },
  deps: ShotDeps
): Promise<number> => {
  const outcome = await shootScenario(rawId, options.out, deps);

  if (outcome.kind === 'no-hook') {
    deps.printError(NO_PHOTO_HOOK);

    return 2;
  }

  if (outcome.kind === 'failed') {
    deps.printError(outcome.reason);

    if (outcome.tail.length > 0) {
      deps.printError("The hook's last lines:");
      outcome.tail.forEach((line) =>
        deps.printError(line.trim() === '' ? '' : `  ${line}`)
      );
    }

    return 1;
  }

  deps.print(outcome.out);

  return 0;
};

/** Every scenario matching all the words, title and tag hits first. */
export const runShotSearch = (words: string[], deps: ShotDeps): number => {
  const { entries, broken } = listScenarioEntries(
    scenarioRootsFor(deps.project, deps.checkout, deps.env)
  );
  const found = searchScenarios(entries, words);
  // Said, never hidden: a planner would otherwise write a duplicate.
  const sayBroken = () =>
    broken.forEach(({ file }) =>
      deps.printError(
        `${file} isn't a valid scenario, so search skipped it: run \`lambda shot check ${file}\`.`
      )
    );

  if (found.length === 0) {
    deps.print(`No scenario matches ${words.join(' ')}.`);
    sayBroken();

    return 0;
  }

  found.forEach((entry) =>
    deps.print(
      `${entry.id}  [${entry.source}]  ${entry.title}${
        entry.tags.length > 0 ? `  (${entry.tags.join(', ')})` : ''
      }`
    )
  );
  sayBroken();

  return 0;
};

/** Check one file: 0 when valid, else 1 with each problem named. */
export const runShotCheck = (
  file: string,
  deps: Pick<ShotDeps, 'print' | 'printError'>
): number => {
  const { scenario, problems } = checkScenarioFile(file);

  if (scenario === null) {
    deps.printError(`✗ ${file}`);
    problems.forEach((problem) => deps.printError(`  ${problem}`));

    return 1;
  }

  deps.print(`✓ ${file}: ${scenario.id} (${scenario.viewport})`);

  return 0;
};
