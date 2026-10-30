/**
 * `lambda doctor`'s process section: how the project's planning and building
 * processes differ from Lambda's standard, and where each step's and role's
 * instructions come from (Lambda, the project, or Lambda's plus the project's
 * addendum).
 */
import * as fs from 'fs';
import * as path from 'path';

import { loadProjectConfig } from '../../config/projectConfig';
import { ourCommandFiles } from '../../pod/base';
import {
  PROCESS_NAMES,
  type ProcessName,
  type ResolvedProcess,
  type ResolvedStep,
  addendumFile,
  lambdaPackageDir,
  loadProcess,
  readWorkflowFile,
  resolveInstructions,
  roleInstructionNames,
} from '../../process/workflow-file';

const stepsOf = (process: ResolvedProcess): ResolvedStep[] =>
  Array.from(
    new Map(
      Object.values(process.tracks)
        .flat()
        .flatMap((stage) => stage.steps)
        .map((step) => [step.id, step] as const)
    ).values()
  );

/** lambda.json `name` (`Pawnee`), else "project". */
const projectName = (root: string): string =>
  loadProjectConfig(root)?.config.name ?? 'project';

const byWhom = (root: string): string => {
  const who = projectName(root);

  return who === 'project' ? 'the project' : who;
};

/** `Lambda's standard · 7 added, 1 dropped, 1 on by Pawnee`. */
const summaryLine = (root: string, process: ResolvedProcess): string => {
  const file = readWorkflowFile(root, process.name);
  const steps = stepsOf(process);
  const changes = [
    `${steps.filter((step) => step.added === true).length} added`,
    `${file?.drop?.length ?? 0} dropped`,
    `${file?.move?.length ?? 0} moved`,
    // A step that starts off (QA's review) is the standard while it's off.
    `${
      steps.filter((step) => step.off === true && step.offByDefault !== true)
        .length
    } off`,
    `${
      steps.filter((step) => step.off !== true && step.offByDefault === true)
        .length
    } on`,
  ].filter((change) => !change.startsWith('0 '));

  return changes.length === 0
    ? "Lambda's standard"
    : `Lambda's standard · ${changes.join(', ')} by ${byWhom(root)}`;
};

const relative = (root: string, file: string): string =>
  path.relative(root, file);

/** Where one instruction file comes from, with its addendum if any. */
const sourceText = (
  root: string,
  name: ProcessName,
  instructions: string
): string => {
  const own =
    name === 'building' &&
    (loadProjectConfig(root)?.config.building?.ownCommands ?? []).includes(
      instructions
    )
      ? path.join(root, '.claude', 'commands', `${instructions}.md`)
      : undefined;
  // Lambda's own written copies in the project's commands aren't overrides.
  const passOver = ourCommandFiles(root).map((written) =>
    path.join(root, '.claude', 'commands', written)
  );
  const file =
    own !== undefined && fs.existsSync(own)
      ? own
      : resolveInstructions(root, name, instructions, passOver);
  const who = projectName(root);
  const base = file.startsWith(`${lambdaPackageDir()}${path.sep}`)
    ? 'Lambda default'
    : `${who} override (${relative(root, file)})`;
  const addendum = addendumFile(root, name, instructions);

  return fs.existsSync(addendum)
    ? `${base} + ${who} addendum (${relative(root, addendum)})`
    : base;
};

const instructionLines = (root: string, process: ResolvedProcess): string[] => {
  const names = [
    ...stepsOf(process).flatMap((step) =>
      step.command === undefined ? [] : [step.command]
    ),
    ...roleInstructionNames(process.name),
  ];
  const unique = Array.from(new Set(names)).map(
    (instructions) =>
      [
        `${process.name}/${instructions}`,
        sourceText(root, process.name, instructions),
      ] as const
  );
  const width = Math.max(...unique.map(([label]) => label.length));

  return unique.map(([label, source]) => `  ${label.padEnd(width)}  ${source}`);
};

/** The Process section's lines; a process that won't load lists its errors. */
export const processLines = (root: string): string[] => {
  const loaded = PROCESS_NAMES.map((name) => {
    try {
      return { name, process: loadProcess(root, name), errors: [] };
    } catch (error) {
      return {
        name,
        process: null,
        errors: (error instanceof Error ? error.message : String(error)).split(
          '\n'
        ),
      };
    }
  });
  const errors = loaded.flatMap((entry) => entry.errors);

  return [
    'Process',
    ...loaded.map(
      ({ name, process }) =>
        `  ${`${name} steps`.padEnd(14)} ${
          process === null ? "won't load (below)" : summaryLine(root, process)
        }`
    ),
    '',
    'Instructions',
    ...loaded.flatMap(({ process }) =>
      process === null ? [] : instructionLines(root, process)
    ),
    ...(errors.length === 0
      ? ['✓ No errors']
      : errors.map((error) => `✗ ${error}`)),
  ];
};
