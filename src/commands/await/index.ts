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
import { Command } from 'commander';

import {
  TMUX_NOT_FOUND,
  type TmuxSettings,
  currentTmuxSettings,
  tmuxAvailable,
  tmuxTarget,
} from '../tmux';
import { isShellIdle } from '../tmux/pane-status';
import { capturePaneOutput } from '../wait';

const POLL_INTERVAL_MS = 1000;
const INTERNAL_TIMEOUT_MS = 540_000; // 9 minutes (under 10 min Bash tool limit)

interface AwaitOptions {
  pane: string;
  settings: TmuxSettings;
  pattern?: string;
  long: boolean;
}

function getIdleThresholdMs(
  pane: string,
  long: boolean,
  settings: TmuxSettings
): number {
  // Agent panes (Claude Code) have a constantly-changing status bar,
  // so idle detection must use a short threshold regardless of --long.
  if (settings.agentWindows.includes(pane)) {
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
    const cleaned = pattern.replace(/\\\|/g, '|');

    return new RegExp(cleaned);
  } catch {
    console.error(`Error: Invalid regex pattern: "${pattern}"`);
    process.exit(1);
  }
}

function tailLines(output: string, n: number): string {
  const lines = output.split('\n');

  return lines.slice(-n).join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runAwait(opts: AwaitOptions): Promise<void> {
  const { pane, pattern, long, settings } = opts;
  const target = tmuxTarget(pane, settings);
  const regex = pattern ? buildRegex(pattern) : undefined;
  const idleThresholdMs = getIdleThresholdMs(pane, long, settings);

  // Phase 1: Peek (1s delay, check if already done)
  await sleep(1000);

  const capture = (): string => {
    try {
      return capturePaneOutput(target);
    } catch {
      return process.exit(1);
    }
  };

  const peeked = capture();

  // Check if already done after peek
  if (regex && regex.test(peeked)) {
    console.log(`=== DONE (pattern matched) ===`);
    console.log(tailLines(peeked, 40));
    process.exit(0);
  }

  if (isShellIdle(target)) {
    console.log(`=== DONE (shell idle) ===`);
    console.log(tailLines(peeked, 40));
    process.exit(0);
  }

  // Phase 2: Poll loop. Each round carries the time spent so far, the last
  // capture and how long it has stayed unchanged.
  const poll = async (
    elapsed: number,
    lastOutput: string,
    idleMs: number
  ): Promise<void> => {
    if (elapsed >= INTERNAL_TIMEOUT_MS) {
      return;
    }

    await sleep(POLL_INTERVAL_MS);
    const output = capture();

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
    if (output !== lastOutput) {
      return poll(elapsed + POLL_INTERVAL_MS, output, 0);
    }

    const idleNow = idleMs + POLL_INTERVAL_MS;

    if (idleNow >= idleThresholdMs) {
      console.log(`=== DONE (idle ${idleThresholdMs / 1000}s) ===`);
      console.log(tailLines(output, 40));
      process.exit(0);
    }

    return poll(elapsed + POLL_INTERVAL_MS, lastOutput, idleNow);
  };

  // 1000: the peek's sleep already counts toward the timeout.
  await poll(1000, peeked, 0);

  // Internal timeout — exit 2 so caller can re-run
  const finalOutput = capturePaneOutput(target);
  console.log(
    `=== TIMEOUT (${INTERNAL_TIMEOUT_MS / 1000}s elapsed, still running) ===`
  );
  console.log(tailLines(finalOutput, 40));
  process.exit(2);
}

export const registerAwaitCommand = (program: Command): void => {
  program
    .command('await <pane> [pattern]')
    .description(
      'Block until pane is done (pattern match, shell idle, or output idle)'
    )
    .option('--long', 'Use long idle threshold (60s) for CI/long operations')
    .action(
      async (
        pane: string,
        pattern: string | undefined,
        opts: { long: boolean }
      ) => {
        if (!tmuxAvailable()) {
          console.error(TMUX_NOT_FOUND);
          process.exit(1);
        }

        await runAwait({
          pane,
          pattern,
          long: opts.long ?? false,
          settings: currentTmuxSettings(),
        });
      }
    );
};
