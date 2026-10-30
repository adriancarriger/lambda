/**
 * `lambda design` — draw Claude Design artboards to PNGs on this machine, and
 * run the bookkeeping of planning's design loop.
 *
 * ⚠️ RENDERING IS ASKED FOR. The Design type's instructions tell an agent
 * never to render or screenshot a canvas unless the user asked. Lambda's
 * planning renders every design it makes, because the owner set the project
 * up to plan with Claude Design: an agent running `lambda design render` for
 * that work is doing what the user asked, not breaking the type's rule.
 *
 * `render` works offline from a cached copy of the type's runtime, one folder
 * per release under `<pods root>/_design-runtime/`. A canvas folder pins its
 * release in `design.json`; when that release is not cached, `render` exits 3
 * and says what to fetch and the `runtime import` to run.
 */
import chalk from 'chalk';
import { type Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';

import { loadMachineConfig } from '../../config/machineConfig';
import { ensureCanvasDir, ensureDesignGitignore } from '../../design/canvasDir';
import {
  capabilityLine,
  resolveTypeUrl,
  setCapability,
} from '../../design/capability';
import { parseWalkPath } from '../../design/loop';
import { RuntimeNotCachedError, renderArtboard } from '../../design/render';
import { archiveDesignRounds, recordDesignRound } from '../../design/round';
import {
  importRuntime,
  runtimeReleaseDir,
  runtimeStatus,
} from '../../design/runtime';
import { snapshotPrototype } from '../../design/snapshot';
import { walkPrototype, walkStills } from '../../design/walk';
import { registerSystemCommands } from './system';

/** Print the error and set the exit code: 3 for an uncached release, else 1. */
const fail = (error: unknown): void => {
  console.error(
    chalk.red(error instanceof Error ? error.message : String(error))
  );
  process.exitCode =
    error instanceof RuntimeNotCachedError ? error.exitCode : 1;
};

// Shown on `lambda design` and `lambda design render`: Commander prints a
// parent's 'after' text only for the parent's own --help.
const RENDERING_IS_ASKED_FOR = `
${chalk.bold('Rendering is asked for:')}
  The Design type's instructions say never to render or screenshot a canvas
  unless the user asked. The owner asked: this project plans with Claude
  Design, and planning renders every design it makes. Running this command for
  that work is allowed.
`;

export const registerDesignCommand = (program: Command): void => {
  const design = program
    .command('design')
    .description('Render Claude Design artboards to PNGs, offline')
    .addHelpText(
      'after',
      `${RENDERING_IS_ASKED_FOR}
${chalk.bold('A canvas folder:')}
  <canvas-dir>/design.json   { url, typeUrl, release } — local only; rewrite it
                             from every publish or read result for the canvas
  <canvas-dir>/project/…     canvas.json, the *.dc.html artboards, anything else
                             (what the Artifact tool publishes with root = <canvas-dir>)
  A screen's canvas is <pod working folder>/.lambda/design/<screen-slug>/canvas/;
  its pictures and records are <pods root>/<pod>/designs/<screen-slug>/.

${chalk.bold('Exit codes (render):')}
  0  the PNG was written
  3  the canvas's release is not cached: fetch it, then lambda design runtime import
  1  anything else (a runtime error, no ready signal within 20 s, a bad path)

${chalk.bold('Examples:')}
  lambda design capability                     available <type url> | unavailable <reason> | unknown
  lambda design canvas festival-schedule       makes .lambda/design/festival-schedule/canvas/ and prints it
  lambda design runtime import ~/scratchpad/artifact-files/<id> --release 1792416507-85b2
  lambda design runtime status 1792416507-85b2
  lambda design render .lambda/design/bench-list/canvas Main.dc.html --out /tmp/bench-list.png
  lambda design walk .lambda/design/festival-schedule/canvas Prototype.dc.html --brief <designs>/festival-schedule/brief.json --out-dir <designs>/festival-schedule/walk/round-1
  lambda design walk .lambda/design/festival-schedule/canvas Prototype.dc.html --brief <designs>/festival-schedule/brief.json --stills --marks <designs>/festival-schedule/marks.json
  lambda design round <designs>/festival-schedule --judge /tmp/judge.json   records a round: prints STOP <reason> or CONTINUE
  lambda design snapshot .lambda/design/festival-schedule/canvas <designs>/festival-schedule   keep this version for the inbox; prints its chat line
  lambda design system install <built folder> .lambda/design/festival-schedule/canvas   copy the design system onto a canvas
  lambda design system prepare .lambda/design/festival-schedule/canvas   build main's design system (outside this worktree) and install it
  lambda design system detect | build [--check] [--from <ref>] | changed | round record | manifest write | publish
`
    );

  design
    .command('capability')
    .description(
      'Print whether Claude Design works with this Claude account; --set records a check'
    )
    .option('--set <state>', 'Record a check: available or unavailable')
    .option(
      '--type-url <url>',
      'With --set available: the Design type the listing showed'
    )
    .option(
      '--system-type-url <url>',
      'With --set available: the Design System type, when the listing showed one'
    )
    .option('--reason <text>', 'With --set unavailable: why, in a sentence')
    .addHelpText(
      'after',
      `
Prints one line: available <type url>, unavailable <reason>, or unknown (never
checked). The check itself is the planning dev's: ToolSearch select:Artifact,
then Artifact list scope "types" for a Design type.
`
    )
    .action(
      (options: {
        set?: string;
        typeUrl?: string;
        systemTypeUrl?: string;
        reason?: string;
      }) => {
        try {
          if (options.set === undefined) {
            console.log(capabilityLine(loadMachineConfig()?.design));

            return;
          }

          if (options.set === 'available') {
            if (options.typeUrl === undefined) {
              throw new Error('--set available needs --type-url <url>.');
            }

            console.log(
              capabilityLine(
                setCapability({
                  available: true,
                  typeUrl: options.typeUrl,
                  ...(options.systemTypeUrl === undefined
                    ? {}
                    : { systemTypeUrl: options.systemTypeUrl }),
                })
              )
            );

            return;
          }

          if (options.set === 'unavailable') {
            if (options.reason === undefined) {
              throw new Error('--set unavailable needs --reason <text>.');
            }

            console.log(
              capabilityLine(
                setCapability({ available: false, reason: options.reason })
              )
            );

            return;
          }

          throw new Error(
            `--set must be available or unavailable, not ${options.set}.`
          );
        } catch (error) {
          fail(error);
        }
      }
    );

  design
    .command('canvas <screen-slug>')
    .description(
      "Make a screen's canvas folder, .lambda/design/<screen-slug>/canvas/ (gitignored), and print it"
    )
    .option('--dir <work-dir>', "The pod's working folder (default: here)")
    .action((slug: string, options: { dir?: string }) => {
      try {
        console.log(ensureCanvasDir(options.dir ?? process.cwd(), slug));
      } catch (error) {
        fail(error);
      }
    });

  design
    .command('render <canvas-dir> <artboard>')
    .description(
      'Draw one artboard (a file name under <canvas-dir>/project/) to a PNG'
    )
    .requiredOption('--out <png>', 'Where to write the PNG')
    .option('--scale <n>', 'Device pixel ratio', '1')
    .addHelpText('after', RENDERING_IS_ASKED_FOR)
    .action(
      async (
        canvasDir: string,
        artboard: string,
        options: { out: string; scale: string }
      ) => {
        try {
          const scale = Number(options.scale);

          if (!Number.isFinite(scale) || scale <= 0) {
            throw new Error(
              `--scale must be a positive number, not ${options.scale}`
            );
          }

          ensureDesignGitignore(canvasDir);
          const result = await renderArtboard({
            canvasDir,
            artboard,
            out: options.out,
            scale,
          });
          console.log(
            `${chalk.green('Rendered')} ${artboard} (${result.width}×${
              result.height
            }, scale ${scale}) → ${result.out}`
          );
        } catch (error) {
          fail(error);
        }
      }
    );

  design
    .command('walk <canvas-dir> <artboard>')
    .description(
      "Photograph a prototype's walk path and every situation (a round), or with --stills its final pictures"
    )
    .requiredOption('--brief <file>', "The screen's brief.json")
    .option(
      '--out-dir <dir>',
      "Where the photos go (a round: …/walk/round-<n>; --stills: the screen's designs/<slug>/, default the brief's folder)"
    )
    .option(
      '--stills',
      'Only the situations: plain, annotated and legend per situation'
    )
    .option('--marks <file>', 'With --stills: the screen-wide marks.json')
    .addHelpText('after', RENDERING_IS_ASKED_FOR)
    .action(
      async (
        canvasDir: string,
        artboard: string,
        options: {
          brief: string;
          outDir?: string;
          stills?: boolean;
          marks?: string;
        }
      ) => {
        try {
          ensureDesignGitignore(canvasDir);

          if (options.stills === true) {
            if (options.marks === undefined) {
              throw new Error('--stills needs --marks <marks.json>.');
            }

            const files = await walkStills({
              canvasDir,
              artboard,
              briefFile: options.brief,
              marksFile: options.marks,
              screenDir: options.outDir ?? path.dirname(options.brief),
            });
            files.forEach((file) => console.log(file));
            console.log(`${chalk.green('Stills')} ${files.length} files`);

            return;
          }

          if (options.outDir === undefined) {
            throw new Error('A round walk needs --out-dir <dir>.');
          }

          const files = await walkPrototype({
            canvasDir,
            artboard,
            briefFile: options.brief,
            outDir: options.outDir,
          });
          files.forEach((file) => console.log(file));
          console.log(`${chalk.green('Walked')} ${files.length} photos`);
        } catch (error) {
          fail(error);
        }
      }
    );

  design
    .command('snapshot <canvas-dir> <screen-dir>')
    .description(
      "Keep the published prototype in the pod (the next version, if it changed) so the owner can try it in Lambda's inbox; prints the chat line that shows it"
    )
    .addHelpText(
      'after',
      `
Run it after every publish, once the stills are photographed. Put the line it
prints on its own in your message (lambda pod reply) and the chat shows a card:
the picture, the boards, and Try it, which opens the working prototype.

  <screen-dir> is <pods root>/<pod>/designs/<slug>/ (a freeform pod picks a slug,
  e.g. designs/home/). Several boards: a board's photos are read from
  <screen-dir>/<letter>/<situation>.png; one board: <screen-dir>/<situation>.png.
  A board with none gets a poster drawn here.
`
    )
    .option(
      '--note <text>',
      'What this version changed from the last one, in a sentence (shown on its card)'
    )
    .action(
      async (
        canvasDir: string,
        screenDir: string,
        options: { note?: string }
      ) => {
        try {
          ensureDesignGitignore(canvasDir);
          const result = await snapshotPrototype({
            canvasDir,
            screenDir,
            note: options.note,
          });
          const { manifest } = result;
          console.log(
            result.unchanged
              ? `${chalk.yellow('Unchanged')} — v${
                  manifest.version
                } is already this codebase.`
              : `${chalk.green('Saved')} v${manifest.version} of ${
                  manifest.slug
                } (${manifest.boards.length} board${
                  manifest.boards.length === 1 ? '' : 's'
                }, ${manifest.situations.length} situation${
                  manifest.situations.length === 1 ? '' : 's'
                }).`
          );
          console.log(
            'Put this line on its own in your message to show it in the chat:'
          );
          console.log(result.line);
        } catch (error) {
          fail(error);
        }
      }
    );

  design
    .command('round <screen-dir>')
    .description(
      "Record one judged round of a screen's prototype in rounds.jsonl; prints STOP <reason> or CONTINUE"
    )
    .requiredOption('--judge <file>', "The judge's reply: {issues: [...]}")
    .addHelpText(
      'after',
      `
${chalk.bold('Refuses (exit 1, rounds.jsonl unchanged):')}
  round 8; a last round that already said STOP; judge JSON that does not parse;
  a broken line in rounds.jsonl; a screen dir outside <pods root>/<pod>/designs/.
`
    )
    .action((screenDir: string, options: { judge: string }) => {
      try {
        console.log(
          recordDesignRound({ screenDir, judgeFile: options.judge }).line
        );
      } catch (error) {
        fail(error);
      }
    });

  design
    .command('brief <brief-json>')
    .description(
      "Check a screen's brief.json (situations and walk path); print what it walks, or exit 1 naming the problem"
    )
    .action((briefFile: string) => {
      try {
        if (!fs.existsSync(briefFile)) {
          throw new Error(`${briefFile} does not exist.`);
        }

        const { steps, states } = parseWalkPath(
          JSON.parse(fs.readFileSync(briefFile, 'utf8'))
        );
        console.log(`Situations: ${states.join(', ')}`);
        steps.forEach(({ n, step, action }) =>
          console.log(
            `Step ${n} (${step}): ${
              action.kind === 'click'
                ? `click ${action.target}`
                : `state ${action.slug}`
            }`
          )
        );
        console.log(chalk.green('Brief OK'));
      } catch (error) {
        fail(error);
      }
    });

  design
    .command('redesign <screen-dir>')
    .description(
      'Start a re-design: move rounds.jsonl and walk/ aside (rounds.<time>.jsonl, walk.<time>/) so the new design gets its own 7 rounds'
    )
    .action((screenDir: string) => {
      try {
        const moved = archiveDesignRounds({ screenDir });
        console.log(
          moved.length === 0
            ? 'Nothing to move: no rounds.jsonl or walk/ yet.'
            : `${chalk.green('Moved aside')} ${moved.join(', ')}`
        );
      } catch (error) {
        fail(error);
      }
    });

  const runtime = design
    .command('runtime')
    .description(
      'Manage the cached Design type runtime, one folder per release'
    );

  runtime
    .command('import <dir>')
    .description(
      "Copy the type's files fetched with Artifact read (at their published paths) into the cache"
    )
    .requiredOption(
      '--release <release>',
      "The type's release, from the read or publish result"
    )
    .option(
      '--type-url <url>',
      'The Design type (default: the one lambda design capability recorded)'
    )
    .action((dir: string, options: { release: string; typeUrl?: string }) => {
      try {
        const typeUrl = resolveTypeUrl(options.typeUrl, loadMachineConfig());
        const manifest = importRuntime(dir, options.release, typeUrl);
        console.log(
          `${chalk.green('Imported')} ${
            manifest.files.length
          } files for release ${manifest.release} → ${runtimeReleaseDir(
            manifest.release
          )}`
        );
      } catch (error) {
        fail(error);
      }
    });

  runtime
    .command('status <release>')
    .description('Print ready, missing or incomplete; exit 0 only on ready')
    .action((release: string) => {
      try {
        const status = runtimeStatus(release);
        console.log(status);
        process.exitCode = status === 'ready' ? 0 : 1;
      } catch (error) {
        fail(error);
      }
    });

  registerSystemCommands(design);
};
