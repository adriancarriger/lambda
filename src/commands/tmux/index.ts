/**
 * Tmux command - Send commands to and read output from tmux panes.
 *
 * Usage:
 *   lambda tmux <pane> [command]       Send command to <session>:<pane>
 *   lambda tmux <pane>                 Capture output from <session>:<pane>
 *   lambda tmux <pane> <<'EOF' ...     Read command from stdin (shell-safe)
 *   lambda tmux <pane> wait [pattern]  Wait on <session>:<pane> (peek-then-block)
 *
 * The session and the agent windows come from lambda.json `tmux` (`lambda`,
 * `manager`/`dev`/`qa` by default). Inside a planning pod (`POD_ID` set) they
 * are the pod's own: session `lambda-pod-<POD_ID>`, windows `manager`, `dev`.
 * A building pod's windows are `manager` (its Engineering manager), `qa` and
 * `dev`, in its own session or in lambda.json's `tmux.session` when that was
 * set.
 */
import { execFileSync, execSync } from 'child_process';
import { Command } from 'commander';
import { text as readText } from 'stream/consumers';

import {
  DEFAULT_AGENT_WINDOWS,
  DEFAULT_TMUX_SESSION,
  type Project,
  loadProjectConfig,
  resolvePodsRoot,
} from '../../config/projectConfig';
import { createPodStore } from '../../pod-store';
import { onPath } from '../../utils/onPath';
import {
  detectAgent,
  extractTicketId,
  logCommand,
} from '../agent/agent-logger';
import {
  clearReceiptsForPane,
  createSendReceipt,
  runWaitCommand,
} from '../wait';
import { getPaneStatusTag } from './pane-status';

/** All of stdin, as UTF-8 text. */
const readStdin = (): Promise<string> => readText(process.stdin);

export const TMUX_KEY_PATTERN =
  /^(Enter|Escape|BSpace|BTab|Space|Tab|Home|End|PageUp|PageDown|Up|Down|Left|Right|F\d+|C-[a-z])$/;

export interface TmuxSettings {
  session: string;
  /** Claude Code agent windows: sends switch them to auto mode first. */
  agentWindows: string[];
}

/** A planning pod's windows. */
export const POD_AGENT_WINDOWS = ['manager', 'dev'];

export const podSession = (podId: string): string => `lambda-pod-${podId}`;

/**
 * A building pod's agent windows, in the order they sit first in their
 * session: the Engineering manager's window is `manager`.
 */
export const BUILDING_AGENT_WINDOWS: string[] = ['manager', 'qa', 'dev'];

/** The pod's record, from LAMBDA_PODS_ROOT or the project's pods root (null: none). */
const readPodFor = (
  podId: string,
  project: Project | null,
  env: NodeJS.ProcessEnv
) => {
  const root =
    env.LAMBDA_PODS_ROOT !== undefined && env.LAMBDA_PODS_ROOT !== ''
      ? env.LAMBDA_PODS_ROOT
      : project === null
      ? null
      : resolvePodsRoot(project, env);

  if (root === null) {
    return null;
  }

  // No record is a planning pod's layout; one that can't be read is an error,
  // never a guess at the wrong session.
  try {
    return createPodStore(root).readPod(podId);
  } catch (error) {
    throw new Error(
      `Couldn't read pod ${podId} under ${root}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
};

/**
 * The session and agent windows to address. A pod (`POD_ID` set) uses its
 * own session and roles; otherwise lambda.json `tmux`.
 */
export const resolveTmuxSettings = (
  project: Project | null,
  env: NodeJS.ProcessEnv = process.env
): TmuxSettings => {
  const podId = env.POD_ID;

  if (podId !== undefined && podId !== '') {
    const pod = readPodFor(podId, project, env);

    return pod?.kind === 'building'
      ? {
          session: pod.tmuxSession ?? podSession(podId),
          agentWindows: BUILDING_AGENT_WINDOWS,
        }
      : { session: podSession(podId), agentWindows: POD_AGENT_WINDOWS };
  }

  return {
    session: project?.config.tmux.session ?? DEFAULT_TMUX_SESSION,
    agentWindows: project?.config.tmux.agentWindows ?? DEFAULT_AGENT_WINDOWS,
  };
};

/** The settings for the project the current folder belongs to. */
export const currentTmuxSettings = (): TmuxSettings =>
  resolveTmuxSettings(loadProjectConfig(process.cwd()));

/** Panes that are Claude Code agent windows requiring mode switching */
export const agentWindows = (
  settings: TmuxSettings = currentTmuxSettings()
): string[] => settings.agentWindows;

export function tmuxTarget(
  pane: string,
  settings: TmuxSettings = currentTmuxSettings()
): string {
  return `${settings.session}:${pane}`;
}

/** Whether `tmux` is on PATH. */
export const tmuxAvailable = (env: NodeJS.ProcessEnv = process.env): boolean =>
  onPath('tmux', env);

export const TMUX_NOT_FOUND = 'tmux not found.';

function getPanePwd(target: string): string | null {
  try {
    return (
      execSync(`tmux display -t "${target}" -p '#{pane_current_path}'`, {
        encoding: 'utf-8',
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

/**
 * Scrollback lines included in a capture when `--scrollback` is not passed.
 * Agents that read a pane rely on this window's size.
 */
export const DEFAULT_CAPTURE_SCROLLBACK = 40;

/**
 * Capture a pane, optionally reaching further back into tmux history.
 *
 * `scrollback` maps to `capture-pane -S -<N>`: how many lines ABOVE the visible
 * region to include. The default only reaches ~40 lines, so any output taller than
 * the pane is silently truncated — the reader sees a partial answer with no
 * indication that anything was cut. The rest is in tmux's history (up to its
 * `history-limit`); this is the knob that reaches it.
 */
function capturePane(
  target: string,
  scrollback: number = DEFAULT_CAPTURE_SCROLLBACK
): string {
  return execSync(`tmux capture-pane -t "${target}" -p -S -${scrollback}`, {
    encoding: 'utf-8',
    timeout: 5000,
  }).trimEnd();
}

/**
 * Parse `--scrollback`. Rejects anything that is not a non-negative integer rather
 * than silently falling back to the default, so a typo surfaces instead of quietly
 * producing a truncated capture — the exact failure this flag exists to remove.
 */
export function parseScrollback(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  // `Number('')` and `Number('  ')` are 0, which would otherwise pass the integer
  // check and silently capture the visible region only — reject them explicitly.
  const parsed = value.trim() === '' ? NaN : Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    console.error(
      `Invalid --scrollback "${value}": expected a non-negative integer (lines of history to include).`
    );
    process.exit(1);
  }

  return parsed;
}

function sendKeys(target: string, ...keys: string[]): void {
  execFileSync('tmux', ['send-keys', '-t', target, ...keys], {
    timeout: 5000,
  });
}

export function isAgentPane(
  pane: string,
  settings: TmuxSettings = currentTmuxSettings()
): boolean {
  return settings.agentWindows.includes(pane);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Switch a Claude Code agent pane to the target mode by cycling BTab.
 * Returns true if mode was found, false if it failed after max attempts.
 */
async function switchMode(target: string, pattern: string): Promise<boolean> {
  for (const _ of Array.from({ length: 6 })) {
    const output = capturePane(target);

    if (output.includes(pattern)) {
      return true;
    }
    sendKeys(target, 'BTab');
    await sleep(300);
  }

  return false;
}

/**
 * Ensure a Claude Code agent pane is in "auto" mode before sending.
 * Silently falls back if mode switching fails.
 */
async function ensureAutoMode(target: string): Promise<void> {
  await switchMode(target, 'auto mode on');
}

function logTmux(pane: string, action: string, detail?: string): void {
  const args = detail ? [pane, action, detail] : [pane, action];

  logCommand({
    agent: detectAgent(),
    cmd: 'lambda tmux',
    args,
    outcome: 'success',
    ticketId: extractTicketId(),
  });
}

interface SendTextOpts {
  target: string;
  pane: string;
  text: string;
  agent: boolean;
  enter: boolean;
  raw: boolean;
  /** Lines of history to include in the auto-read capture after sending. */
  scrollback?: number;
}

/**
 * Send text to a tmux pane, handling agent mode switching, slash commands,
 * and Enter key behavior. Shared by both the args path and the stdin path.
 */
export async function sendText(opts: SendTextOpts): Promise<void> {
  const { target, pane, text, agent, enter, raw, scrollback } = opts;

  // Claude Code runs a prompt starting with ! as a shell command, outside the
  // agent's permissions, so it never goes to an agent pane.
  if (agent && text.trim().startsWith('!')) {
    throw new Error(
      `A message starting with ! runs as a shell command in ${pane}: send it without the !.`
    );
  }

  // Warn if text contains \! which likely means zsh mangled an exclamation mark
  if (text.includes('\\!')) {
    console.error(
      "Warning: text contains '\\!' which may be shell-mangled. " +
        "Consider using stdin instead: lambda tmux <pane> <<'EOF'\\n...\\nEOF"
    );
  }

  // For agent panes, ensure "auto" mode before sending text
  if (agent && !raw) {
    await ensureAutoMode(target);
  }

  const isSlashCommand = agent && text.startsWith('/');

  if (isSlashCommand && enter) {
    // Slash commands trigger Claude Code's autocomplete menu.
    // Send text, wait for autocomplete to render, Escape to dismiss, then Enter.
    sendKeys(target, text);
    await sleep(500);
    sendKeys(target, 'Escape');
    await sleep(100);
    sendKeys(target, 'Enter');
  } else if (agent && enter) {
    // Agent panes need a delay between text and Enter to avoid
    // Enter being swallowed or interpreted as a newline.
    // 500ms handles large pastes where the terminal needs time to buffer.
    sendKeys(target, text);
    await sleep(500);
    sendKeys(target, 'Enter');
  } else if (enter) {
    sendKeys(target, text, 'Enter');
  } else {
    sendKeys(target, text);
  }
  clearReceiptsForPane(target);
  logTmux(pane, 'send', text);

  // Auto-read: wait briefly, capture output, and create send receipt
  // so the next `lambda tmux <pane> wait` goes straight to blocking mode.
  await sleep(500);
  const output = capturePane(target, scrollback);
  outputWithPwd(target, output);
  createSendReceipt(target);
}

export const registerTmuxCommand = (program: Command): void => {
  program
    .command('tmux <pane> [args...]')
    .description('Send commands to or read output from tmux panes')
    .allowUnknownOption(true)
    .option('-n, --no-enter', 'Send text without pressing Enter')
    .option('--raw', 'Skip agent mode switching')
    .option('--plan', 'Switch agent pane to plan mode (no message sent)')
    .option('--long', 'Use long timeout for wait (10min timeout, 60s idle)')
    .option('--stdin', 'Read command text from stdin (shell-safe)')
    .option(
      '-S, --scrollback <lines>',
      `Lines of tmux history to include in the capture (default: ${DEFAULT_CAPTURE_SCROLLBACK})`
    )
    .addHelpText(
      'after',
      `
Agent panes (lambda.json tmux.agentWindows; manager, dev, qa by default):
  Automatically switches to "auto" mode before sending.
  Use --raw to skip mode switching, --plan to switch to plan mode.

Shell-safe stdin mode (preserves !, $, backticks, etc.):
  $ lambda tmux scratchPad --stdin <<'EOF'
  curl -s ... | jq 'select(.message != null)'
  EOF

Examples:
  $ lambda tmux scratchPad "echo hello"   Send command + Enter
  $ lambda tmux scratchPad                Capture current output
  $ lambda tmux dev C-c                   Send Ctrl+C
  $ lambda tmux dev "text" -n             Type text without Enter
  $ lambda tmux dev Enter                 Send Enter key
  $ lambda tmux dev --plan                Switch dev to plan mode
  $ lambda tmux dev --raw "y"             Send without mode switching
  $ lambda tmux dev wait                  Wait on dev pane (peek-then-block)
  $ lambda tmux dev wait "pattern"        Wait for pattern on dev pane

Reading output taller than the pane:
  A plain capture reaches only ~${DEFAULT_CAPTURE_SCROLLBACK} lines back, so longer
  output is truncated with no indication anything was cut. Reach into history with:

  $ lambda tmux scratchPad -S 200         Capture with 200 lines of scrollback
  $ lambda tmux scratchPad --scrollback 500
`
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
          scrollback?: string;
        }
      ) => {
        if (!tmuxAvailable()) {
          console.error(TMUX_NOT_FOUND);
          process.exit(1);
        }

        const settings = currentTmuxSettings();
        const target = tmuxTarget(pane, settings);
        const agent = isAgentPane(pane, settings);
        const scrollback = parseScrollback(opts.scrollback);

        // --plan flag → switch to plan mode and exit
        if (opts.plan) {
          if (!agent) {
            console.error(
              `--plan only works on agent panes (${settings.agentWindows.join(
                ', '
              )})`
            );
            process.exit(1);
          }
          const ok = await switchMode(target, 'plan mode on');

          if (ok) {
            console.log('Switched to plan mode');
          } else {
            console.error('Failed to switch to plan mode after 6 attempts');
            process.exit(1);
          }
          logTmux(pane, 'plan');

          return;
        }

        // --stdin flag → read command from stdin
        if (opts.stdin) {
          const rawInput = await readStdin();
          const text = rawInput.replace(/\n+$/, '');

          if (!text) {
            console.error('Error: empty stdin');
            process.exit(1);
          }

          await sendText({
            target,
            pane,
            text,
            agent,
            enter: opts.enter,
            raw: opts.raw,
            ...(scrollback !== undefined && { scrollback }),
          });

          return;
        }

        // No args → capture mode
        if (args.length === 0) {
          const output = capturePane(target, scrollback);
          outputWithPwd(target, output);
          logTmux(pane, 'capture');

          return;
        }

        // "wait" subcommand → delegate to wait logic
        if (args[0] === 'wait') {
          const [, pattern] = args;
          logTmux(pane, 'wait', pattern);

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

        // Single arg that's a known tmux key → send as raw key (no mode switching)
        if (args.length === 1 && TMUX_KEY_PATTERN.test(args[0])) {
          sendKeys(target, args[0]);
          clearReceiptsForPane(target);
          logTmux(pane, 'key', args[0]);

          return;
        }

        // Command string → send text via shared helper
        const text = args.join(' ');
        await sendText({
          target,
          pane,
          text,
          agent,
          enter: opts.enter,
          raw: opts.raw,
          ...(scrollback !== undefined && { scrollback }),
        });
      }
    );
};
