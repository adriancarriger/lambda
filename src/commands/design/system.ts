import chalk from 'chalk';
import { type Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';

import { loadMachineConfig } from '../../config/machineConfig';
import { type Project, loadProjectConfig } from '../../config/projectConfig';
import {
  DEFAULT_BUILD_OUT,
  buildSystem,
  noDesignSystemMessage,
} from '../../design/system/build';
import { buildFromRef } from '../../design/system/cache';
import {
  componentsLine,
  detectStack,
  lookLine,
  stackLine,
} from '../../design/system/detect';
import { defaultBranchRef, git, gitOk } from '../../design/system/git';
import { installSystem } from '../../design/system/install';
import { parseJsonText, readManifestAt } from '../../design/system/manifest';
import { writeSetupManifest } from '../../design/system/manifestWrite';
import { publishPlan } from '../../design/system/publish';
import {
  type PreparedSystemRound,
  SystemRoundRefusal,
  prepareSystemRound,
  roundCompositePath,
  saveSystemRound,
  writeRoundComposites,
} from '../../design/system/round';
import {
  designChanges,
  formatDesignChanges,
  readSourceMap,
  ticketChanges,
} from '../../design/system/sources';
import { prepareDesignSystem } from '../../pod/designSystem';
import { projectName } from '../../runner/projectsSetup';
import { scenarioIdsIn } from '../../shot/lookup';
import { checkoutRootOf } from '../../shot/shoot';
import { openTicketSource } from '../../tickets/context';

/**
 * `lambda design system …`: a project's design system as committed source,
 * built locally. `detect` reads the code, `build` makes the bundle, `changed`
 * tells the building pod which copies a ticket must update, and the setup
 * ticket's `round record` and `manifest write` make it the first time.
 * `install` and `prepare` put it on a planning canvas; `publish` only prints
 * the Artifact calls to browse it in Claude Design.
 */

const fail = (error: unknown): void => {
  console.error(
    chalk.red(error instanceof Error ? error.message : String(error))
  );
  process.exitCode = 1;
};

const requireProject = (cwd: string): Project => {
  const project = loadProjectConfig(cwd);

  if (project === null) {
    throw new Error(
      'Not inside a Lambda codebase (no lambda.json or TASKS.md above this folder).'
    );
  }

  return project;
};

/** The project as checked out here: a pod's worktree, or the project itself. */
const here = (): { project: Project; checkout: string; name: string } => {
  const cwd = process.cwd();
  const project = requireProject(cwd);

  return {
    project,
    checkout: checkoutRootOf(cwd, project.root),
    name: projectName(project),
  };
};

/** The project's config as written in `checkout` (a worktree's own lambda.json). */
const inCheckout = (project: Project, checkout: string): Project => ({
  ...project,
  root: checkout,
});

export const registerSystemCommands = (design: Command): void => {
  const system = design
    .command('system')
    .description(
      "The codebase's design system: committed source, built locally"
    );

  system
    .command('detect')
    .description("Read the app's code: its stack, look and components")
    .option('--json', 'Print the result as JSON')
    .action((options: { json?: boolean }) => {
      try {
        const { project, checkout } = here();
        const detected = detectStack(checkout, project.config);

        if (options.json === true) {
          console.log(JSON.stringify(detected, null, 2));

          return;
        }

        const shot = project.config.commands?.shot;
        const scenarios = scenarioIdsIn(
          path.join(checkout, project.config.design.scenarios),
          project.config.design.scenarioExt
        ).length;
        const { system: found } = detected;
        console.log(`Stack:      ${stackLine(detected)}`);
        console.log(`Look:       ${lookLine(detected)}`);
        console.log(`Components: ${componentsLine(detected)}`);
        console.log(
          `Photos:     ${
            shot === undefined
              ? 'no photo hook (commands.shot in lambda.json)'
              : `commands.shot is set · ${scenarios} screenshot scenario${
                  scenarios === 1 ? '' : 's'
                }`
          }`
        );
        console.log(
          `System:     ${
            found === null
              ? `none yet (${project.config.design.system.dir})`
              : [
                  found.dir,
                  ...(found.version === undefined
                    ? ['made by hand']
                    : [`version ${found.version}`]),
                  ...(found.builtFrom === undefined
                    ? []
                    : [`from main@${found.builtFrom.slice(0, 7)}`]),
                ].join(' · ')
          }`
        );
      } catch (error) {
        fail(error);
      }
    });

  system
    .command('build')
    .description(
      'Build the design system as committed into a gitignored folder; prints the folder on its last line'
    )
    .option('--out <dir>', `Where to (default <checkout>/${DEFAULT_BUILD_OUT})`)
    .option(
      '--working-tree',
      'Build what is on disk, uncommitted edits included'
    )
    .option(
      '--check',
      'Also check: app runtime, every component draws, the source map (implies --working-tree)'
    )
    .option(
      '--from <ref>',
      "Build that commit in Lambda's build checkout, into ~/.lambda/cache/design-system/"
    )
    .addHelpText(
      'after',
      `
Never run it in a planning pod's worktree: it has no packages installed.
Planning builds with --from (or lambda design system prepare), outside it.
`
    )
    .action(
      async (options: {
        out?: string;
        workingTree?: boolean;
        check?: boolean;
        from?: string;
      }) => {
        try {
          const { project, checkout, name } = here();
          const log = (line: string): void => console.error(line);

          if (options.from !== undefined) {
            if (
              options.out !== undefined ||
              options.workingTree === true ||
              options.check === true
            ) {
              throw new Error(
                "--from builds the commit as committed, into Lambda's cache: it takes no --out, --working-tree or --check."
              );
            }

            const { folder, built, result } = await buildFromRef({
              project,
              projectName: name,
              ref: options.from,
              log,
            });
            [...(result?.warnings ?? []), ...(result?.notes ?? [])].forEach(
              (line) => console.error(chalk.yellow(line))
            );
            console.error(built ? 'Built.' : 'Already built for that commit.');
            console.log(folder);

            return;
          }

          const result = await buildSystem({
            project: inCheckout(project, checkout),
            projectName: name,
            checkout,
            out: options.out ?? path.join(checkout, DEFAULT_BUILD_OUT),
            workingTree: options.workingTree,
            check: options.check,
            log,
          });
          [...result.warnings, ...result.notes].forEach((line) =>
            console.error(chalk.yellow(line))
          );

          if (result.problems.length > 0) {
            result.problems.forEach((line) => console.error(chalk.red(line)));
            process.exitCode = 1;
          }

          console.log(result.out);
        } catch (error) {
          fail(error);
        }
      }
    );

  system
    .command('changed')
    .description(
      "Which of this ticket's files change the design system (read off sources.json)"
    )
    .option(
      '--base <ref>',
      "The branch the ticket forks from (default origin's default branch)"
    )
    .action((options: { base?: string }) => {
      try {
        const { project, checkout } = here();
        const { dir, manifest } = project.config.design.system;
        const base = options.base ?? defaultBranchRef(checkout);

        if (
          gitOk(checkout, [
            'rev-parse',
            '--verify',
            '--end-of-options',
            `${base}^{commit}`,
          ]) === undefined
        ) {
          throw new Error(
            `--base ${base} is not a commit in this checkout (a typo, or not fetched?).`
          );
        }

        const forkPoint = git(checkout, ['merge-base', base, 'HEAD']);

        if (readManifestAt(checkout, forkPoint, manifest) === null) {
          console.log(noDesignSystemMessage(manifest));

          return;
        }

        formatDesignChanges(
          designChanges(
            readSourceMap(checkout, dir),
            ticketChanges(checkout, base)
          )
        ).forEach((line) => console.log(line));
      } catch (error) {
        fail(error);
      }
    });

  system
    .command('install <built-dir> <canvas-dir>')
    .description(
      "Copy a built design system onto a canvas: project/ds/<namespace>/ + canvas.json's designSystems record"
    )
    .option('--namespace <name>', 'Refuse a built folder of another namespace')
    .addHelpText(
      'after',
      `
<built-dir> is a design system built from main (its design-system.json names
the namespace). Never build one in a pod worktree: it has no dependencies.
`
    )
    .action(
      (
        builtDir: string,
        canvasDir: string,
        options: { namespace?: string }
      ) => {
        try {
          const { files, record } = installSystem({
            builtDir,
            canvasDir,
            namespace: options.namespace,
          });
          console.log(
            `${chalk.green('Installed')} ${files.length} files of ${
              record.title
            } → ${path.join(canvasDir, 'project', 'ds', record.namespace)}`
          );
        } catch (error) {
          fail(error);
        }
      }
    );

  system
    .command('prepare <canvas-dir>')
    .description(
      "Planning's step 0: build main's design system at the pod's base (outside this worktree) and install it on the canvas"
    )
    .option(
      '--base <sha>',
      "The pod's base (default: where HEAD forks from main)"
    )
    .action(async (canvasDir: string, options: { base?: string }) => {
      try {
        const cwd = process.cwd();
        const project = requireProject(cwd);
        const result = await prepareDesignSystem({
          project,
          projectName: projectName(project),
          base: options.base,
          worktree: cwd,
          canvasDir,
          listTickets: () =>
            openTicketSource(project, loadMachineConfig()).list(),
        });

        if (result.installed !== null) {
          console.log(
            `${chalk.green('Installed')} the design system from ${
              result.builtDir
            } on ${result.installed}`
          );
        }

        if (result.summary !== null) {
          console.log(result.summary);
        }
      } catch (error) {
        fail(error);
      }
    });

  system
    .command('round')
    .description("The setup ticket's design loop")
    .command('record')
    .description(
      'Record one round of photo | drawn pairs; prints SYSTEM: CONTINUE, MATCH, CLOSE or BLOCKED, then one photo | drawn composite per screen'
    )
    .requiredOption(
      '--round <file>',
      '{ pictures: [{ scenarioId, photo, drawn, issues }] }'
    )
    .addHelpText(
      'after',
      `
Then prints one line per screen, "Composite: <path>": the photo | drawn
composite in <pods root>/<pod>/design-system/round-<n>/composite-<scenario id>.png.

Refuses ("Refused: <reason>", exit 1, nothing written): round 8, a round
after the loop ended, a round whose scenarioIds differ from round 1's, a
missing picture, one that isn't a PNG or is outside
<pods root>/<pod>/design-system/, or a file that isn't a round. Fix the
round file and record it again.

Prints "SYSTEM: ERROR — <reason>" (exit 1, nothing written) when the
judge's issues fail its format, or when a composite can't be drawn.
`
    )
    .action(async (options: { round: string }) => {
      const messageOf = (error: unknown): string =>
        error instanceof Error ? error.message : String(error);
      const prepared = ((): PreparedSystemRound | null => {
        try {
          return prepareSystemRound(options.round);
        } catch (error) {
          console.log(
            error instanceof SystemRoundRefusal
              ? `Refused: ${messageOf(error)}`
              : `SYSTEM: ERROR — ${messageOf(error)}`
          );
          process.exitCode = 1;

          return null;
        }
      })();

      if (prepared === null) {
        return;
      }

      // The composites are drawn before the round is saved, so a round that
      // can't be drawn records nothing and is repeated like any other ERROR.
      const dir = path.dirname(prepared.file);
      const composites = await writeRoundComposites(prepared.record, dir).catch(
        (error: unknown) => {
          prepared.record.pictures.forEach(({ scenarioId }) =>
            fs.rmSync(
              roundCompositePath(dir, prepared.record.round, scenarioId),
              { force: true }
            )
          );
          console.log(
            `SYSTEM: ERROR — The round's composites couldn't be drawn: ${messageOf(
              error
            )}`
          );
          process.exitCode = 1;

          return null;
        }
      );

      if (composites === null) {
        return;
      }

      saveSystemRound(prepared);
      console.log(prepared.line);
      composites.forEach((file) => console.log(`Composite: ${file}`));
    });

  system
    .command('manifest')
    .description("The setup ticket's manifest")
    .command('write')
    .description(
      'Write the manifest once the loop ends in MATCH or CLOSE (or could not be checked)'
    )
    .requiredOption('--ticket <id>', 'The setup ticket')
    .option('--rounds <file>', "The pod's design-system/rounds.json")
    .option(
      '--not-checked <reason>',
      'Why there were no rounds (never with --rounds)'
    )
    .option(
      '--base <ref>',
      "The setup's base commit (default: where HEAD forks from main)"
    )
    .option('--left-out <file>', 'JSON: [{ name, why }]')
    .action(
      async (options: {
        ticket: string;
        rounds?: string;
        notChecked?: string;
        base?: string;
        leftOut?: string;
      }) => {
        try {
          const { project, checkout, name } = here();
          const main = defaultBranchRef(checkout);
          // With no origin, `main` is HEAD itself: never a base to check from.
          const forkPoint =
            main === 'HEAD'
              ? undefined
              : gitOk(checkout, ['merge-base', 'HEAD', main]);
          const base = options.base ?? forkPoint;

          if (base === undefined) {
            throw new Error(
              "Can't tell where this branch forks from the default branch: pass --base <commit>, the commit the setup started from."
            );
          }
          const leftOut: unknown =
            options.leftOut === undefined
              ? undefined
              : parseJsonText(
                  fs.readFileSync(options.leftOut, 'utf8'),
                  options.leftOut
                );

          if (
            leftOut !== undefined &&
            (!Array.isArray(leftOut) ||
              !leftOut.every(
                (one: unknown) =>
                  typeof one === 'object' &&
                  one !== null &&
                  'name' in one &&
                  typeof one.name === 'string' &&
                  'why' in one &&
                  typeof one.why === 'string'
              ))
          ) {
            throw new Error('--left-out must be a JSON list of { name, why }.');
          }

          const { file } = await writeSetupManifest({
            project: inCheckout(project, checkout),
            projectName: name,
            checkout,
            base,
            ticketId: options.ticket,
            roundsFile: options.rounds,
            notChecked: options.notChecked,
            leftOut,
          });
          console.log(`${chalk.green('Wrote')} ${file}`);
        } catch (error) {
          fail(error);
        }
      }
    );

  system
    .command('publish')
    .description(
      'Print the Artifact calls that show the built design system in Claude Design (optional; writes nothing)'
    )
    .option('--url <url>', 'Publish to this Design System artifact')
    .option(
      '--built <dir>',
      `The built folder (default <checkout>/${DEFAULT_BUILD_OUT})`
    )
    .action((options: { url?: string; built?: string }) => {
      try {
        const { checkout, name } = here();
        const plan = publishPlan({
          builtDir: options.built ?? path.join(checkout, DEFAULT_BUILD_OUT),
          url: options.url,
          typeUrl: loadMachineConfig()?.design?.systemTypeUrl,
          title: name,
        });
        plan.calls.forEach((call, index) =>
          console.log(
            `Artifact call ${index + 1} of ${
              plan.calls.length
            }:\n${JSON.stringify(call, null, 2)}`
          )
        );
        plan.notes.forEach((line) => console.log(line));
      } catch (error) {
        fail(error);
      }
    });
};
