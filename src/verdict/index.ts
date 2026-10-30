/**
 * `lambda verdict record|show`: the check-ticket step's verdicts, which
 * `lambda ship` gates on. The latest recorded verdict wins, so a later
 * INCOMPLETE closes the gate again.
 *
 * A `--deviation` is a requirement whose letter shifted while its outcome
 * landed (the ticket named a file that moved). Deviations never gate: they
 * are notes on a passing verdict, kept where a person can read them.
 */
import { type Command } from 'commander';

import { copyRoundToPod } from '../building/visualPictures';
import { loadMachineConfig } from '../config/machineConfig';
import { loadProjectConfig, resolvePodsRoot } from '../config/projectConfig';
import { createPodStore } from '../pod-store';
import { type Verdict } from '../pod-store/schemas';
import { callerPodId } from '../pod/context';
import { openTicketSource } from '../tickets/context';
import { assertTicketId } from '../tickets/source';
import { headShaOf, readVerdict, recordVerdict, verdictPath } from './store';
import { postVisualMisses } from './visualMisses';
import { recordVisualRound } from './visualRecord';
import { type VisualRoundRecord, type VisualVerdict } from './visualStore';

export interface VerdictDeps {
  projectRoot: string;
  print: (line: string) => void;
  printError: (line: string) => void;
}

const loadDeps = (): VerdictDeps => {
  const project = loadProjectConfig(process.cwd());

  if (project === null) {
    throw new Error('No project here: run lambda init first.');
  }

  return {
    projectRoot: project.root,
    print: (line) => console.log(line),
    printError: (line) => console.error(line),
  };
};

interface RecordOptions {
  complete?: boolean;
  incomplete?: boolean;
  failed?: string;
  deviation?: string[];
}

const splitList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');

/** The verdict to record, or why it can't be. */
export const buildVerdict = (
  ticketId: string,
  options: RecordOptions,
  provenance: { recordedAt: string; headSha: string | undefined }
): Verdict => {
  if (options.complete === true && options.incomplete === true) {
    throw new Error('Pass --complete or --incomplete, not both.');
  }

  if (options.complete !== true && options.incomplete !== true) {
    throw new Error('Pass --complete or --incomplete.');
  }

  const failedDimensions = splitList(options.failed);

  if (options.complete === true && failedDimensions.length > 0) {
    throw new Error(
      `A COMPLETE verdict has no failed dimensions (got ${failedDimensions.join(
        ', '
      )}).`
    );
  }

  return {
    ticketId: assertTicketId(ticketId),
    verdict: options.complete === true ? 'COMPLETE' : 'INCOMPLETE',
    failedDimensions,
    deviations: (options.deviation ?? [])
      .map((note) => note.trim())
      .filter((note) => note !== ''),
    recordedAt: provenance.recordedAt,
    ...(provenance.headSha === undefined
      ? {}
      : { headSha: provenance.headSha }),
  };
};

const failWith = (deps: VerdictDeps, error: unknown): void => {
  deps.printError(
    `Error: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
};

export const runVerdictRecord = (
  ticketId: string,
  options: RecordOptions,
  deps: VerdictDeps
): void => {
  try {
    const verdict = buildVerdict(ticketId, options, {
      recordedAt: new Date().toISOString(),
      headSha: headShaOf(deps.projectRoot),
    });
    const file = recordVerdict(deps.projectRoot, verdict);

    deps.print(
      verdict.verdict === 'COMPLETE'
        ? `✓ ${verdict.ticketId}: COMPLETE recorded`
        : `✗ ${verdict.ticketId}: INCOMPLETE recorded`
    );

    if (verdict.failedDimensions.length > 0) {
      deps.print(`  Failed: ${verdict.failedDimensions.join(', ')}`);
    }

    verdict.deviations.forEach((note) => deps.print(`  Deviation: ${note}`));
    deps.print(`  ${file}`);

    if (verdict.verdict === 'INCOMPLETE') {
      deps.print('  lambda ship refuses this ticket until it is COMPLETE.');
    }
  } catch (error) {
    failWith(deps, error);
  }
};

export const runVerdictShow = (ticketId: string, deps: VerdictDeps): void => {
  try {
    const lookup = readVerdict(deps.projectRoot, ticketId);

    if (lookup.kind === 'missing') {
      deps.printError(
        `No verdict recorded for ${ticketId}. Run the check-ticket step first.`
      );
      deps.printError(
        `  Expected at: ${verdictPath(deps.projectRoot, ticketId)}`
      );
      process.exitCode = 1;

      return;
    }

    if (lookup.kind === 'unreadable') {
      deps.printError(
        `The verdict for ${ticketId} couldn't be read: ${lookup.reason}`
      );
      process.exitCode = 1;

      return;
    }

    deps.print(JSON.stringify(lookup.verdict, null, 2));
  } catch (error) {
    failWith(deps, error);
  }
};

export interface VisualRecordCommandDeps {
  projectRoot: string;
  print: (line: string) => void;
  printError: (line: string) => void;
  /** Posts the SHIPPED_WITH_MISSES comment (`postVisualMisses`). */
  postMisses: (verdict: VisualVerdict) => Promise<void>;
  /** Copies the round for the building pod's Workflow rail; absent outside a pod. */
  copyRound?: (ticketId: string, record: VisualRoundRecord) => void;
}

export const loadVisualDeps = (): VisualRecordCommandDeps => {
  const project = loadProjectConfig(process.cwd());

  if (project === null) {
    throw new Error('No project here: run lambda init first.');
  }

  const warn = (line: string) => console.error(line);
  const podId = callerPodId();

  return {
    projectRoot: project.root,
    print: (line) => console.log(line),
    printError: warn,
    postMisses: (verdict) =>
      postVisualMisses(verdict, {
        projectRoot: project.root,
        source: openTicketSource(project, loadMachineConfig()),
        info: (line) => console.log(line),
        warn,
      }),
    ...(podId === undefined || podId === ''
      ? {}
      : {
          copyRound: (ticketId: string, record: VisualRoundRecord) => {
            copyRoundToPod({
              store: createPodStore(resolvePodsRoot(project, process.env)),
              podId,
              projectRoot: project.root,
              ticketId,
              record,
            });
          },
        }),
  };
};

/**
 * `lambda verdict visual record` — prints the `VISUAL:` line `/visual-check`
 * passes on verbatim (and, on CONTINUE, the `Expected: …, actual: …` lines);
 * a refusal exits 1 having written nothing.
 */
export const runVisualRecord = async (
  ticketId: string,
  roundFile: string,
  deps: VisualRecordCommandDeps
): Promise<void> => {
  try {
    const { lines } = await recordVisualRound(ticketId, roundFile, {
      projectRoot: deps.projectRoot,
      postMisses: deps.postMisses,
      copyRound: deps.copyRound,
      warn: deps.printError,
    });
    lines.forEach((line) => deps.print(line));
  } catch (error) {
    deps.printError(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
};

export const registerVerdictCommand = (
  program: Command,
  deps: () => VerdictDeps = loadDeps,
  visualDeps: () => VisualRecordCommandDeps = loadVisualDeps
): void => {
  const verdict = program
    .command('verdict')
    .description(
      "Record or read a ticket's check-ticket verdict, or record a visual check round"
    );

  verdict
    .command('visual')
    .description("The build's visual check of a ticket's design pictures")
    .command('record <ticket-id>')
    .description(
      'Record one /visual-check round and decide for the whole set: CONTINUE, MATCH, SHIPPED_WITH_MISSES or BLOCKED'
    )
    .requiredOption(
      '--round <file>',
      'The round file: { pictures: [{ scenarioId, situation, expected, actual, issues }] }'
    )
    .action(async (ticketId: string, options: { round: string }) =>
      runVisualRecord(ticketId, options.round, visualDeps())
    );

  verdict
    .command('record <ticket-id>')
    .description(
      'Record a check-ticket verdict (the latest wins; lambda ship needs COMPLETE)'
    )
    .option('--complete', 'Every acceptance criterion is met')
    .option('--incomplete', 'Something is not met yet')
    .option('--failed <dimensions>', 'Comma-separated failed dimensions')
    .option(
      '--deviation <note>',
      'A requirement whose letter shifted while its outcome landed (repeatable; never gates)',
      // Collected, never comma-split: a note is a sentence, and has commas.
      (note: string, previous: string[] = []) => [...previous, note],
      []
    )
    .action((ticketId: string, options: RecordOptions) =>
      runVerdictRecord(ticketId, options, deps())
    );

  verdict
    .command('show <ticket-id>')
    .description("Print a ticket's recorded verdict")
    .action((ticketId: string) => runVerdictShow(ticketId, deps()));
};
