import { execFileSync } from 'child_process';

import { BUILDING_ROLES, type Turn, isIdle } from '../pod-store';
import type { Activity } from './stall';

/**
 * Who in a building pod is working, for the stall watch (building/stall.ts).
 *
 * - Busy: mid-turn by Claude's own hooks (UserPromptSubmit / Stop), or sent a
 *   message it hasn't started on.
 * - Running: a command still going under the agent's window: Claude's Bash
 *   tool runs each command through a shell that sources its snapshot
 *   (`zsh -c source ~/.claude/shell-snapshots/…`), a background run too. So
 *   an agent that ended its turn while an E2E run carries on still counts.
 */

export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

const TOOL_SHELL = '/.claude/shell-snapshots/';

/** Whether a tool's shell runs anywhere under `root`. */
export const toolRunningUnder = (rows: ProcessRow[], root: number): boolean => {
  const children = new Map<number, ProcessRow[]>();
  rows.forEach((row) =>
    children.set(row.ppid, [...(children.get(row.ppid) ?? []), row])
  );

  const search = (pids: number[], seen: Set<number>): boolean => {
    const next = pids
      .flatMap((pid) => children.get(pid) ?? [])
      .filter((row) => !seen.has(row.pid));

    if (next.length === 0) {
      return false;
    }

    return (
      next.some((row) => row.command.includes(TOOL_SHELL)) ||
      search(
        next.map((row) => row.pid),
        new Set([...seen, ...next.map((row) => row.pid)])
      )
    );
  };

  return search([root], new Set([root]));
};

export const agentActivity = (input: {
  turn: (role: string) => Turn;
  /** The pid of the role's window's shell, or null with no window. */
  panePid: (role: string) => number | null;
  processes: () => ProcessRow[];
}): Activity => {
  const rows = input.processes();

  return {
    busy: BUILDING_ROLES.filter((role) => !isIdle(input.turn(role))),
    running: BUILDING_ROLES.filter((role) => {
      const pid = input.panePid(role);

      return pid !== null && toolRunningUnder(rows, pid);
    }),
  };
};

/** `ps` for every process: pid, parent and command line. */
export const listProcesses = (): ProcessRow[] =>
  execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
    .split('\n')
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);

      return match === null
        ? []
        : [
            {
              pid: Number(match[1]),
              ppid: Number(match[2]),
              command: match[3] ?? '',
            },
          ];
    });
