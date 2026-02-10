/**
 * Tmux command - Send commands to and read output from tmux panes.
 *
 * Usage:
 *   lambda tmux <pane> [command]       Send command to lambda:<pane>
 *   lambda tmux <pane>                 Capture output from lambda:<pane>
 *   lambda tmux <pane> <<'EOF' ...     Read command from stdin (shell-safe)
 *   lambda tmux <pane> wait [pattern]  Wait on lambda:<pane> (peek-then-block)
 */
import { execFileSync, execSync } from "child_process";
import { Command } from "commander";

import { AGENT_PANES, SESSION_NAME } from "../../config";
import {
  clearReceiptsForPane,
  createSendReceipt,
  runWaitCommand,
} from "../wait";
import { getPaneStatusTag } from "./pane-status";

/* eslint-disable no-restricted-syntax, @typescript-eslint/consistent-type-assertions -- push() and Buffer cast needed for stdin stream reading */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks).toString("utf-8");
}
/* eslint-enable no-restricted-syntax, @typescript-eslint/consistent-type-assertions -- re-enable after stdin block */

export const TMUX_KEY_PATTERN =
  /^(Enter|Escape|BSpace|BTab|Space|Tab|Home|End|PageUp|PageDown|Up|Down|Left|Right|F\d+|C-[a-z])$/;

export function tmuxTarget(pane: string): string {
  return `${SESSION_NAME}:${pane}`;
}

function getPanePwd(target: string): string | null {
  try {
    return (
      execSync(`tmux display -t "${target}" -p '#{pane_current_path}'`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function outputWithPwd(target: string, output: string): void {
  const pwd = getPanePwd(target);
  const status = getPaneStatusTag(target);

  if (pwd) {
    console.log(`[${pwd}] ${status}`);
  } else {
    console.log(status);
  }
  console.log(output);
}

function capturePane(target: string): string {
  return execSync(`tmux capture-pane -t "${target}" -p -S -40`, {
    encoding: "utf-8",
    timeout: 5000,
  }).trimEnd();
}

function sendKeys(target: string, ...keys: string[]): void {
  execFileSync("tmux", ["send-keys", "-t", target, ...keys], {
    timeout: 5000,
  });
}

export function isAgentPane(pane: string): boolean {
  return AGENT_PANES.includes(pane);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Switch a Claude Code agent pane to the target mode by cycling BTab.
 * Returns true if mode was found, false if it failed after max attempts.
 */
async function switchMode(target: string, pattern: string): Promise<boolean> {
  // eslint-disable-next-line no-restricted-syntax -- for loop with await needed for sequential mode cycling
  for (let attempt = 0; attempt < 6; attempt++) {
    const output = capturePane(target);

    if (output.includes(pattern)) {
      return true;
    }
    sendKeys(target, "BTab");
    await sleep(300);
  }

  return false;
}

/**
 * Ensure a Claude Code agent pane is in "accept edits" mode before sending.
 * Silently falls back if mode switching fails.
 */
async function ensureAcceptEdits(target: string): Promise<void> {
  await switchMode(target, "accept edits on");
}

interface SendTextOpts {
  target: string;
  pane: string;
  text: string;
  agent: boolean;
  enter: boolean;
  raw: boolean;
}

/**
 * Send text to a tmux pane, handling agent mode switching, slash commands,
 * and Enter key behavior. Shared by both the args path and the stdin path.
 */
export async function sendText(opts: SendTextOpts): Promise<void> {
  const { target, text, agent, enter, raw } = opts;

  // Warn if text contains \! which likely means zsh mangled an exclamation mark
  if (text.includes("\\!")) {
    console.error(
      "Warning: text contains '\\!' which may be shell-mangled. " +
        "Consider using stdin instead: lambda tmux <pane> <<'EOF'\\n...\\nEOF",
    );
  }

  // For agent panes, ensure "accept edits" mode before sending text
  if (agent && !raw) {
    await ensureAcceptEdits(target);
  }

  const isSlashCommand = agent && text.startsWith("/");

  if (isSlashCommand && enter) {
    // Slash commands trigger Claude Code's autocomplete menu.
    // Send text, wait for autocomplete to render, Escape to dismiss, then Enter.
    sendKeys(target, text);
    await sleep(500);
    sendKeys(target, "Escape");
    await sleep(100);
    sendKeys(target, "Enter");
  } else if (agent && enter) {
    // Agent panes need a delay between text and Enter to avoid
    // Enter being swallowed or interpreted as a newline.
    // 500ms handles large pastes where the terminal needs time to buffer.
    sendKeys(target, text);
    await sleep(500);
    sendKeys(target, "Enter");
  } else if (enter) {
    sendKeys(target, text, "Enter");
  } else {
    sendKeys(target, text);
  }
  clearReceiptsForPane(target);

  // Auto-read: wait briefly, capture output, and create send receipt
  // so the next `lambda tmux <pane> wait` goes straight to blocking mode.
  await sleep(500);
  const output = capturePane(target);
  outputWithPwd(target, output);
  createSendReceipt(target);
}

export const registerTmuxCommand = (program: Command): void => {
  program
    .command("tmux <pane> [args...]")
    .description("Send commands to or read output from tmux panes")
    .allowUnknownOption(true)
    .option("-n, --no-enter", "Send text without pressing Enter")
    .option("--raw", "Skip agent mode switching")
    .option("--plan", "Switch agent pane to plan mode (no message sent)")
    .option("--long", "Use long timeout for wait (10min timeout, 60s idle)")
    .option("--stdin", "Read command text from stdin (shell-safe)")
    .addHelpText(
      "after",
      `
Agent panes (${AGENT_PANES.join(", ")}):
  Automatically switches to "accept edits" mode before sending.
  Use --raw to skip mode switching, --plan to switch to plan mode.

Shell-safe stdin mode (preserves !, $, backticks, etc.):
  $ lambda tmux scratchPad --stdin <<'EOF'
  gcloud ... | jq 'select(.message != null)'
  EOF

Examples:
  $ lambda tmux scratchPad "echo hello"   Send command + Enter
  $ lambda tmux scratchPad                Capture current output
  $ lambda tmux john C-c                  Send Ctrl+C
  $ lambda tmux john "text" -n            Type text without Enter
  $ lambda tmux john Enter                Send Enter key
  $ lambda tmux john --plan               Switch john to plan mode
  $ lambda tmux john --raw "y"            Send without mode switching
  $ lambda tmux john wait                 Wait on john pane (peek-then-block)
  $ lambda tmux john wait "pattern"       Wait for pattern on john pane
`,
    )
    .action(
      async (
        pane: string,
        args: string[],
        opts: {
          enter: boolean;
          raw: boolean;
          plan: boolean;
          long: boolean;
          stdin: boolean;
        },
      ) => {
        const target = tmuxTarget(pane);
        const agent = isAgentPane(pane);

        // --plan flag -> switch to plan mode and exit
        if (opts.plan) {
          if (!agent) {
            console.error(
              `--plan only works on agent panes (${AGENT_PANES.join(", ")})`,
            );
            process.exit(1);
          }
          const ok = await switchMode(target, "plan mode on");

          if (ok) {
            console.log("Switched to plan mode");
          } else {
            console.error("Failed to switch to plan mode after 6 attempts");
            process.exit(1);
          }

          return;
        }

        // --stdin flag -> read command from stdin
        if (opts.stdin) {
          const rawInput = await readStdin();
          const text = rawInput.replace(/\n+$/, "");

          if (!text) {
            console.error("Error: empty stdin");
            process.exit(1);
          }

          await sendText({
            target,
            pane,
            text,
            agent,
            enter: opts.enter,
            raw: opts.raw,
          });

          return;
        }

        // No args -> capture mode
        if (args.length === 0) {
          const output = capturePane(target);
          outputWithPwd(target, output);

          return;
        }

        // "wait" subcommand -> delegate to wait logic
        if (args[0] === "wait") {
          const [, pattern] = args;

          const idleSec = agent ? 3 : opts.long ? 60 : 15;
          const waitOpts = {
            idleSec,
            ...(opts.long ? { timeoutSec: 600 } : {}),
          };

          await runWaitCommand({
            pattern,
            pane: target,
            ...waitOpts,
          });

          return;
        }

        // Single arg that's a known tmux key -> send as raw key (no mode switching)
        if (args.length === 1 && TMUX_KEY_PATTERN.test(args[0])) {
          sendKeys(target, args[0]);
          clearReceiptsForPane(target);

          return;
        }

        // Command string -> send text via shared helper
        const text = args.join(" ");
        await sendText({
          target,
          pane,
          text,
          agent,
          enter: opts.enter,
          raw: opts.raw,
        });
      },
    );
};
