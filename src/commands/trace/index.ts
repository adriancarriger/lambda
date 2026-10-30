import chalk from 'chalk';
import { Command } from 'commander';

import {
  type TracePatternConfig,
  loadProjectConfig,
} from '../../config/projectConfig';
import {
  DEFAULT_ERROR_PATTERNS,
  type ErrorPattern,
  runTraceCommand,
} from './trace-debug';

export {
  buildSummary,
  DEFAULT_ERROR_PATTERNS,
  type DiagnoseResults,
  type ErrorPattern,
  findTestResultsDir,
  getDiagnoseResults,
  getTraceDir,
  parseTrace,
  type TraceSummary,
} from './trace-debug';

export interface TraceCommandOptions {
  /** A project's own error patterns, checked after the defaults. */
  extraPatterns?: ErrorPattern[];
  /** Where lambda.json is looked for; the current folder when unset. */
  cwd?: string;
}

/**
 * `patterns` with lambda.json's `trace.patterns` placed in: each one ahead of
 * the first pattern of its `before` category, the rest at the end, in the
 * order the file gives them. Throws on a `before` no pattern has.
 */
export const withProjectPatterns = (
  patterns: ErrorPattern[],
  project: TracePatternConfig[]
): ErrorPattern[] => {
  const categories = patterns.map((entry) => entry.category);
  const unknown = project.find(
    (entry) => entry.before !== undefined && !categories.includes(entry.before)
  );

  if (unknown !== undefined) {
    throw new Error(
      `lambda.json trace.patterns: "${unknown.category}" goes before "${unknown.before}", and no pattern has that category.`
    );
  }

  const toPattern = (entry: TracePatternConfig): ErrorPattern => ({
    pattern: new RegExp(entry.pattern, entry.flags),
    category: entry.category,
    explanation: entry.explanation,
    solution: entry.solution,
  });
  const placedBefore = (entry: ErrorPattern, index: number): ErrorPattern[] =>
    categories.indexOf(entry.category) === index
      ? project.filter((one) => one.before === entry.category).map(toPattern)
      : [];

  return [
    ...patterns.flatMap((entry, index) => [
      ...placedBefore(entry, index),
      entry,
    ]),
    ...project.filter((one) => one.before === undefined).map(toPattern),
  ];
};

export const registerTraceCommand = (
  program: Command,
  options: TraceCommandOptions = {}
): void => {
  const extra = options.extraPatterns ?? [];
  // Read when a subcommand runs, so a bad lambda.json never breaks the CLI.
  // `trace.builtIn: false` leaves Lambda's own patterns out.
  const patterns = (): ErrorPattern[] => {
    const trace = loadProjectConfig(options.cwd)?.config.trace;

    return withProjectPatterns(
      trace?.builtIn === false ? extra : [...DEFAULT_ERROR_PATTERNS, ...extra],
      trace?.patterns ?? []
    );
  };

  const trace = program
    .command('trace')
    .description("Read a failed test's trace")
    .addHelpText(
      'after',
      `
${chalk.bold('Subcommands:')}
  summary [trace-path]            Overview of test run
  errors [trace-path]             Error details with screenshots
  actions [trace-path]            High-level action sequence
  screenshots [trace-path]        List all screenshots
  screenshot [trace-path]         Get specific screenshot + neighbors
  console [trace-path]            Filter console logs
  around [trace-path]             Events around a timestamp
  timeline [trace-path]           Chronological event view
  diagnose [trace-path]           Error scan against known patterns
  diagnose-all                    Batch diagnose all traces

${chalk.bold('Examples:')}
  lambda trace diagnose-all
  lambda trace summary test-results/some-test/trace.zip
  lambda trace errors
  lambda trace console --type error --limit 50
`
    );

  // summary
  trace
    .command('summary [trace-path]')
    .description(
      'Overview: status, failed action, console errors, screenshot, counts'
    )
    .action(async (tracePath?: string) => {
      await runTraceCommand('summary', tracePath, {}, patterns());
    });

  // errors
  trace
    .command('errors [trace-path]')
    .description('Error details with 2 screenshots before/after')
    .action(async (tracePath?: string) => {
      await runTraceCommand('errors', tracePath, {}, patterns());
    });

  // actions
  trace
    .command('actions [trace-path]')
    .description('High-level action sequence (goto, click, fill)')
    .action(async (tracePath?: string) => {
      await runTraceCommand('actions', tracePath, {}, patterns());
    });

  // screenshots
  trace
    .command('screenshots [trace-path]')
    .description('List all screenshots with index numbers')
    .action(async (tracePath?: string) => {
      await runTraceCommand('screenshots', tracePath, {}, patterns());
    });

  // screenshot
  trace
    .command('screenshot [trace-path]')
    .description('Get specific screenshot + neighbors')
    .option(
      '--at <index|error>',
      'Screenshot index or "error" for error time',
      'error'
    )
    .option('--context <n>', 'Number of screenshots before/after', '2')
    .action(async (tracePath: string | undefined, opts) => {
      await runTraceCommand(
        'screenshot',
        tracePath,
        { at: opts.at, context: opts.context },
        patterns()
      );
    });

  // console
  trace
    .command('console [trace-path]')
    .description('Filter console logs')
    .option(
      '--type <type>',
      'Filter by type (log, info, warning, error, debug)'
    )
    .option('--filter <regex>', 'Filter by regex pattern')
    .option('--limit <n>', 'Maximum messages to show', '100')
    .action(async (tracePath: string | undefined, opts) => {
      await runTraceCommand(
        'console',
        tracePath,
        { type: opts.type, filter: opts.filter, limit: opts.limit },
        patterns()
      );
    });

  // around
  trace
    .command('around [trace-path]')
    .description('Events around a timestamp')
    .requiredOption('--time <ms>', 'Target timestamp in milliseconds')
    .option('--window <ms>', 'Window size (±ms)', '500')
    .action(async (tracePath: string | undefined, opts) => {
      await runTraceCommand(
        'around',
        tracePath,
        { time: opts.time, window: opts.window },
        patterns()
      );
    });

  // timeline
  trace
    .command('timeline [trace-path]')
    .description('Condensed chronological event view')
    .action(async (tracePath?: string) => {
      await runTraceCommand('timeline', tracePath, {}, patterns());
    });

  // diagnose
  trace
    .command('diagnose [trace-path]')
    .description("Error scan against known patterns (plus the codebase's own)")
    .action(async (tracePath?: string) => {
      await runTraceCommand('diagnose', tracePath, {}, patterns());
    });

  // diagnose-all
  trace
    .command('diagnose-all')
    .description('Batch diagnose all traces in test-results/')
    .option('--verbose', 'Show clean traces too')
    .action(async (opts) => {
      await runTraceCommand(
        'diagnose-all',
        undefined,
        { verbose: opts.verbose === true },
        patterns()
      );
    });
};
