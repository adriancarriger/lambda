/**
 * Pane status utilities - Shared logic for detecting whether a tmux pane
 * is idle or running a command.
 */
import { execSync } from "child_process";

export const KNOWN_SHELLS = ["zsh", "bash", "fish", "sh", "dash", "login"];

export function getPaneCurrentCommand(pane: string): string | null {
  try {
    const cmd = execSync(
      `tmux display-message -t "${pane}" -p '#{pane_current_command}'`,
      { encoding: "utf-8", timeout: 5000 },
    ).trim();

    return cmd || null;
  } catch {
    return null;
  }
}

export function isShellIdle(pane: string): boolean {
  const cmd = getPaneCurrentCommand(pane);

  if (!cmd) {
    return false;
  }

  return KNOWN_SHELLS.some(
    (shell) => cmd === shell || cmd.endsWith(`/${shell}`),
  );
}

export function getPaneStatusTag(pane: string): string {
  const cmd = getPaneCurrentCommand(pane);

  if (!cmd) {
    return "[idle]";
  }

  const isIdle = KNOWN_SHELLS.some(
    (shell) => cmd === shell || cmd.endsWith(`/${shell}`),
  );

  if (isIdle) {
    return "[idle]";
  }

  return `[running: ${cmd}]`;
}
