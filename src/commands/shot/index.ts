/**
 * `lambda shot`: a photo of the project's own app in one exact situation (a
 * scenario), taken by the project's photo hook, lambda.json `commands.shot`.
 *
 *   lambda shot <id> --out <png>      run the hook for one scenario
 *   lambda shot search <words…>       find scenarios (every word must match)
 *   lambda shot check <file>          validate a scenario file
 *   lambda shot before <slug> <screen-dir> --situation <name>=<id>…
 *                                     a screen's before pictures, for design
 *
 * Exit codes: 0 done; 1 a bad or unknown id, a broken file or a failed hook
 * (its last 20 lines shown); 2 the project has no photo hook.
 */
import chalk from 'chalk';
import { type Command } from 'commander';
import * as path from 'path';

import { type Project, loadProjectConfig } from '../../config/projectConfig';
import { type BeforeSituation, takeBeforeShots } from '../../design/beforeShot';
import { assertScreenDir } from '../../design/screenDir';
import {
  NO_PHOTO_HOOK,
  type ShotDeps,
  checkoutRootOf,
  runShot,
  runShotCheck,
  runShotSearch,
  shootScenario,
} from '../../shot';

const loadDeps = (): ShotDeps => {
  const project: Project | null = loadProjectConfig(process.cwd());

  if (project === null) {
    throw new Error('No codebase here: run lambda init first.');
  }

  return {
    project,
    checkout: checkoutRootOf(process.cwd(), project.root),
    env: process.env,
    print: (line) => console.log(line),
    printError: (line) => console.error(line),
  };
};

const collect = (value: string, previous: string[] = []): string[] => [
  ...previous,
  value,
];

/** `closed=trail-closed` → the situation and its scenario. */
export const parseSituation = (value: string): BeforeSituation => {
  const at = value.indexOf('=');

  if (at <= 0 || at === value.length - 1) {
    throw new Error(
      `--situation "${value}" must be <situation>=<scenario id>.`
    );
  }

  return { situation: value.slice(0, at), scenarioId: value.slice(at + 1) };
};

export const NO_HOOK_BEFORES = (slug: string): string =>
  `${NO_PHOTO_HOOK} Design ${slug} with no before pictures, and set noPhotoHook: true on its ux screen.`;

/**
 * `lambda shot before`: 0 with every before taken (one path per line), 1
 * with the `DESIGN FAILED …` line (the screen ends there), 2 with no photo
 * hook (design without befores).
 */
export const runShotBefore = async (
  slug: string,
  screenDir: string,
  situations: BeforeSituation[],
  deps: ShotDeps
): Promise<number> => {
  const result = await takeBeforeShots({
    slug,
    screenDir,
    situations,
    shoot: (scenarioId, out) => shootScenario(scenarioId, out, deps),
  });

  if (result.kind === 'failed') {
    deps.print(result.line);

    return 1;
  }

  if (result.kind === 'no-hook') {
    deps.print(NO_HOOK_BEFORES(slug));

    return 2;
  }

  result.befores.forEach((one) =>
    deps.print(`${one.situation}  ${one.scenarioId}  ${one.file}`)
  );

  return 0;
};

export const registerShotCommand = (
  program: Command,
  deps: () => ShotDeps = loadDeps
): void => {
  const shot = program
    .command('shot')
    .description(
      "Photograph the codebase's app in one scenario (its photo hook)"
    )
    .argument('[id]', 'The scenario id')
    .option('--out <png>', 'Where the PNG goes')
    .addHelpText(
      'after',
      `
${chalk.bold('Examples:')}
  lambda shot trail-closed --out /tmp/trail-closed.png
  lambda shot search trail map
  lambda shot check .lambda/scenarios/trail-closed.scenario.json
`
    )
    .action(async (id: string | undefined, options: { out?: string }) => {
      if (id === undefined || options.out === undefined) {
        shot.help({ error: true });

        return;
      }

      // Where the command was run, not the checkout root.
      process.exitCode = await runShot(
        id,
        { out: path.resolve(options.out) },
        deps()
      );
    });

  shot
    .command('search <words...>')
    .description(
      'Find scenarios by id, title, description and tags (every word must match)'
    )
    .action((words: string[]) => {
      process.exitCode = runShotSearch(words, deps());
    });

  shot
    .command('check <file>')
    .description('Check a scenario file and name each problem')
    .action((file: string) => {
      const print = {
        print: (line: string) => console.log(line),
        printError: (line: string) => console.error(line),
      };
      process.exitCode = runShotCheck(file, print);
    });

  shot
    .command('before <slug> <screen-dir>')
    .description(
      "A screen's before pictures: <screen-dir>/<situation>.before.png each"
    )
    .requiredOption(
      '--situation <name=id>',
      'A situation and its scenario id (repeatable)',
      collect
    )
    .action(
      async (
        slug: string,
        screenDir: string,
        options: { situation: string[] }
      ) => {
        process.exitCode = await runShotBefore(
          slug,
          assertScreenDir(screenDir),
          options.situation.map(parseSituation),
          deps()
        );
      }
    );
};
