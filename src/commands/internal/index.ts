import { type Command } from 'commander';

import { loadMachineConfig } from '../../config/machineConfig';

/**
 * `lambda internal …`: plumbing other Lambda code calls, not for people.
 *
 *   claude-token  The Claude token, for an agent's window to read at launch:
 *                 the pod launcher's command carries
 *                 `CLAUDE_CODE_OAUTH_TOKEN="$(lambda internal claude-token)"`,
 *                 so the token itself is never in a command line, `ps` or
 *                 tmux's history.
 */

type Env = Record<string, string | undefined>;

export const NOT_CONNECTED =
  "Claude isn't connected: run lambda connect claude";

export interface ClaudeTokenIo {
  env: Env;
  stdoutIsTTY: boolean;
  write: (text: string) => void;
  error: (line: string) => void;
}

/**
 * Prints `tokens.claude.value` with no newline. Refuses (exit 1, nothing
 * printed) when stdout is a terminal: it is only ever read by a shell's
 * `$(…)`, never shown.
 */
export const runClaudeToken = (io: ClaudeTokenIo): number => {
  if (io.stdoutIsTTY) {
    return 1;
  }

  const token = loadMachineConfig(io.env)?.tokens?.claude?.value;

  if (token === undefined || token === '') {
    io.error(NOT_CONNECTED);

    return 1;
  }

  io.write(token);

  return 0;
};

export const registerInternalCommand = (program: Command): void => {
  const internal = program
    .command('internal')
    .description("Lambda's own plumbing (not for people)");

  internal
    .command('claude-token')
    .description("Print the Claude token for an agent's window")
    .action(() => {
      process.exitCode = runClaudeToken({
        env: process.env,
        stdoutIsTTY: process.stdout.isTTY === true,
        write: (text) => process.stdout.write(text),
        error: (line) => console.error(line),
      });
    });
};
