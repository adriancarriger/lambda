/**
 * Await command - Full wait loop in a single process.
 *
 * Combines peek + poll into one blocking call, designed to be delegated
 * to a Haiku sub-agent so the calling agent burns zero tokens waiting.
 *
 * Exit codes:
 *   0 = done (pattern matched, shell idle, or idle timeout)
 *   1 = error (pane not found, tmux not running)
 *   2 = internal timeout (still running — caller should re-run)
 */
import { Command } from "commander";

import { AGENT_PANES } from "../../config";
import { tmuxTarget } from "../tmux";
import { isShellIdle } from "../tmux/pane-status";
import { capturePaneOutput } from "../wait";

const POLL_INTERVAL_MS = 1000;
const INTERNAL_TIMEOUT_MS = 540_000; // 9 minutes (under 10 min Bash tool limit)

interface AwaitOptions {
  pane: string;
  pattern?: string;
  long: boolean;
}

function getIdleThresholdMs(pane: string, long: boolean): number {
  // Agent panes (Claude Code) have a constantly-changing status bar,
  // so idle detection must use a short threshold regardless of --long.
  if (AGENT_PANES.includes(pane)) {
    return long ? 5_000 : 3_000;
  }

  if (long) {
    return 60_000;
  }

  return 15_000;
}

function buildRegex(pattern: string): RegExp | undefined {
  try {
    // Clean backslash-escaped pipes (common shell escaping mistake)
    const cleaned = pattern.replace(/\\\|/g, "|");

    return new RegExp(cleaned);
  } catch {
    console.error(`Error: Invalid regex pattern: "${pattern}"`);
    process.exit(1);
  }
}

function tailLines(output: string, n: number): string {
  const lines = output.split("\n");

  return lines.slice(-n).join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runAwait(opts: AwaitOptions): Promise<void> {
  const { pane, pattern, long } = opts;
  const target = tmuxTarget(pane);
  const regex = pattern ? buildRegex(pattern) : undefined;
  const idleThresholdMs = getIdleThresholdMs(pane, long);

  // Phase 1: Peek (1s delay, check if already done)
  await sleep(1000);

  // eslint-disable-next-line no-restricted-syntax -- reassigned in poll loop
  let lastOutput = "";

  try {
    lastOutput = capturePaneOutput(target);
  } catch {
    process.exit(1);
  }

  // Check if already done after peek
  if (regex && regex.test(lastOutput)) {
    console.log(`=== DONE (pattern matched) ===`);
    console.log(tailLines(lastOutput, 40));
    process.exit(0);
  }

  if (isShellIdle(target)) {
    console.log(`=== DONE (shell idle) ===`);
    console.log(tailLines(lastOutput, 40));
    process.exit(0);
  }

  // Phase 2: Poll loop
  // eslint-disable-next-line no-restricted-syntax -- reassigned in poll loop
  let elapsed = 1000; // account for peek sleep
  // eslint-disable-next-line no-restricted-syntax -- reassigned in poll loop
  let idleMs = 0;

  while (elapsed < INTERNAL_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
    elapsed += POLL_INTERVAL_MS;

    // eslint-disable-next-line no-restricted-syntax -- assigned in try, used after
    let output: string;

    try {
      output = capturePaneOutput(target);
    } catch {
      process.exit(1);
    }

    // Pattern match
    if (regex && regex.test(output)) {
      console.log(`=== DONE (pattern matched) ===`);
      console.log(tailLines(output, 40));
      process.exit(0);
    }

    // Shell idle (command exited)
    if (isShellIdle(target)) {
      console.log(`=== DONE (shell idle) ===`);
      console.log(tailLines(output, 40));
      process.exit(0);
    }

    // Idle detection (output unchanged)
    if (output === lastOutput) {
      idleMs += POLL_INTERVAL_MS;

      if (idleMs >= idleThresholdMs) {
        console.log(`=== DONE (idle ${idleThresholdMs / 1000}s) ===`);
        console.log(tailLines(output, 40));
        process.exit(0);
      }
    } else {
      idleMs = 0;
      lastOutput = output;
    }
  }

  // Internal timeout — exit 2 so caller can re-run
  const finalOutput = capturePaneOutput(target);
  console.log(
    `=== TIMEOUT (${INTERNAL_TIMEOUT_MS / 1000}s elapsed, still running) ===`,
  );
  console.log(tailLines(finalOutput, 40));
  process.exit(2);
}

export const registerAwaitCommand = (program: Command): void => {
  program
    .command("await <pane> [pattern]")
    .description(
      "Block until pane is done (pattern match, shell idle, or output idle)",
    )
    .option("--long", "Use long idle threshold (60s) for CI/long operations")
    .action(
      async (
        pane: string,
        pattern: string | undefined,
        opts: { long: boolean },
      ) => {
        await runAwait({ pane, pattern, long: opts.long ?? false });
      },
    );
};
