/**
 * Agent Clear - Clear context and send handoff message
 *
 * Clears the calling agent's own context and sends a handoff message
 * as the first prompt in the fresh session.
 *
 * Usage:
 *   lambda-demo agent clear --self "Pick up DEMO-3: filter bar. The checkbox test was a timing issue."
 *
 * Must be called directly (not via tmux) so TMUX_PANE is available.
 */
import { execFileSync } from "child_process";

const MAX_WAIT_MS = 30000;
const POLL_INTERVAL_MS = 1000;
const MIN_WAIT_MS = 2000;

/**
 * Poll tmux pane output until clear completes (prompt is ready again).
 */
async function waitForClear(target: string): Promise<boolean> {
  const startTime = Date.now();

  await new Promise((resolve) => setTimeout(resolve, MIN_WAIT_MS));

  while (Date.now() - startTime < MAX_WAIT_MS) {
    try {
      const output = execFileSync(
        "tmux",
        ["capture-pane", "-t", target, "-p", "-S", "-5"],
        { encoding: "utf-8" },
      );

      if (output.includes("accept edits on")) {
        return true;
      }
    } catch {
      // Ignore capture errors, keep polling
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    process.stdout.write(".");
  }

  return false;
}

/**
 * Resolve the caller's own tmux window from TMUX_PANE.
 */
function resolveOwnWindow(): string {
  const tmuxPane = process.env.TMUX_PANE;

  if (!tmuxPane) {
    console.error("Error: Not running in tmux. --self requires TMUX_PANE.");
    process.exit(1);
  }

  return execFileSync(
    "tmux",
    ["display-message", "-t", tmuxPane, "-p", "#{session_name}:#{window_name}"],
    { encoding: "utf-8" },
  ).trim();
}

export async function runClear(selfMessage: string): Promise<void> {
  try {
    const target = resolveOwnWindow();
    const [, windowName] = target.split(":");

    if (windowName === "scratchPad") {
      console.error("Error: Cannot clear the scratchPad window.");
      process.exit(1);
    }

    console.log(`Clearing: ${target}`);
    console.log(
      `Handoff: ${selfMessage.slice(0, 80)}${
        selfMessage.length > 80 ? "..." : ""
      }`,
    );
    console.log("");

    // Send /clear and confirm autocomplete
    execFileSync("tmux", ["send-keys", "-t", target, "/clear", "C-m"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    execFileSync("tmux", ["send-keys", "-t", target, "C-m"]);

    // Poll for clear completion
    const completed = await waitForClear(target);

    if (!completed) {
      console.log("");
      console.error("Warning: Timed out waiting for /clear to complete.");
    }

    // Send the handoff message as a user prompt
    await new Promise((resolve) => setTimeout(resolve, 500));
    execFileSync("tmux", ["send-keys", "-t", target, selfMessage, "C-m"]);

    console.log("Context cleared. Handoff sent.");
  } catch (error) {
    console.error(
      "Error:",
      error instanceof Error ? error.message : "Unknown error",
    );
    process.exit(1);
  }
}
