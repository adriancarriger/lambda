import { Command } from "commander";

import { runTraceCommand } from "./trace-debug";

import chalk from "chalk";

export const registerTraceCommand = (program: Command): void => {
  const trace = program
    .command("trace")
    .description("Debug Playwright E2E test traces")
    .addHelpText(
      "after",
      `
${chalk.bold("Subcommands:")}
  summary [trace-path]            Overview of test run
  errors [trace-path]             Error details with screenshots
  actions [trace-path]            High-level action sequence
  screenshots [trace-path]        List all screenshots
  screenshot [trace-path]         Get specific screenshot + neighbors
  console [trace-path]            Filter console logs
  around [trace-path]             Events around a timestamp
  timeline [trace-path]           Chronological event view
  diagnose [trace-path]           Comprehensive error scan
  diagnose-all                    Batch diagnose all traces

${chalk.bold("Examples:")}
  lambda trace diagnose-all
  lambda trace summary test-results/some-test/trace.zip
  lambda trace errors
  lambda trace console --type error --limit 50
  lambda trace diagnose --verbose
`,
    );

  // summary
  trace
    .command("summary [trace-path]")
    .description("Overview of test run (duration, status, counts)")
    .action(async (tracePath?: string) => {
      await runTraceCommand("summary", tracePath, {});
    });

  // errors
  trace
    .command("errors [trace-path]")
    .description("Error details with 2 screenshots before/after")
    .action(async (tracePath?: string) => {
      await runTraceCommand("errors", tracePath, {});
    });

  // actions
  trace
    .command("actions [trace-path]")
    .description("High-level action sequence (goto, click, fill)")
    .action(async (tracePath?: string) => {
      await runTraceCommand("actions", tracePath, {});
    });

  // screenshots
  trace
    .command("screenshots [trace-path]")
    .description("List all screenshots with index numbers")
    .action(async (tracePath?: string) => {
      await runTraceCommand("screenshots", tracePath, {});
    });

  // screenshot
  trace
    .command("screenshot [trace-path]")
    .description("Get specific screenshot + neighbors")
    .option(
      "--at <index|error>",
      'Screenshot index or "error" for error time',
      "error",
    )
    .option("--context <n>", "Number of screenshots before/after", "2")
    .action(
      async (
        tracePath: string | undefined,
        options: Record<string, string>,
      ) => {
        await runTraceCommand("screenshot", tracePath, {
          at: options.at,
          context: options.context,
        });
      },
    );

  // console
  trace
    .command("console [trace-path]")
    .description("Filter console logs")
    .option(
      "--type <type>",
      "Filter by type (log, info, warning, error, debug)",
    )
    .option("--filter <regex>", "Filter by regex pattern")
    .option("--limit <n>", "Maximum messages to show", "100")
    .action(
      async (
        tracePath: string | undefined,
        options: Record<string, string>,
      ) => {
        await runTraceCommand("console", tracePath, {
          type: options.type,
          filter: options.filter,
          limit: options.limit,
        });
      },
    );

  // around
  trace
    .command("around [trace-path]")
    .description("Events around a timestamp")
    .requiredOption("--time <ms>", "Target timestamp in milliseconds")
    .option("--window <ms>", "Window size (ms)", "500")
    .action(
      async (
        tracePath: string | undefined,
        options: Record<string, string>,
      ) => {
        await runTraceCommand("around", tracePath, {
          time: options.time,
          window: options.window,
        });
      },
    );

  // timeline
  trace
    .command("timeline [trace-path]")
    .description("Condensed chronological event view")
    .action(async (tracePath?: string) => {
      await runTraceCommand("timeline", tracePath, {});
    });

  // diagnose
  trace
    .command("diagnose [trace-path]")
    .description("Comprehensive error scan")
    .option("--verbose", "Show recovered issues and more detail")
    .action(
      async (
        tracePath: string | undefined,
        options: Record<string, boolean>,
      ) => {
        await runTraceCommand("diagnose", tracePath, {
          verbose: options.verbose === true,
        });
      },
    );

  // diagnose-all
  trace
    .command("diagnose-all")
    .description("Batch diagnose all traces in test-results/")
    .option("--verbose", "Show clean traces and more detail")
    .action(async (options: Record<string, boolean>) => {
      await runTraceCommand("diagnose-all", undefined, {
        verbose: options.verbose === true,
      });
    });
};
