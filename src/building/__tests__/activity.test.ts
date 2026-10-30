import type { Pod, Turn } from '../../pod-store';
import { agentPane } from '../../runner/building';
import { type ProcessRow, agentActivity, toolRunningUnder } from '../activity';

/** Who in a building pod is working: turns, and commands still running. */

const SNAPSHOT =
  '/bin/zsh -c source /home/leslie/.claude/shell-snapshots/snapshot-zsh-1.sh && eval npm test';

const rows: ProcessRow[] = [
  // The dev's window: its shell, Claude, the tool's shell, the E2E run.
  { pid: 100, ppid: 1, command: '-zsh' },
  { pid: 101, ppid: 100, command: 'claude' },
  { pid: 102, ppid: 101, command: SNAPSHOT },
  { pid: 103, ppid: 102, command: 'node playwright test' },
  // The qa's window: Claude and an MCP server, nothing running.
  { pid: 200, ppid: 1, command: '-zsh' },
  { pid: 201, ppid: 200, command: 'claude' },
  { pid: 202, ppid: 201, command: 'node mcp-server.js' },
];

describe("a building pod's activity", () => {
  it("finds a tool's command anywhere under a window, and nothing under one without", () => {
    expect(toolRunningUnder(rows, 100)).toBe(true);
    expect(toolRunningUnder(rows, 200)).toBe(false);
    expect(toolRunningUnder(rows, 999)).toBe(false);
  });

  it('reads busy from the turns and running from the processes, by role', () => {
    const turns: Record<string, Turn> = {
      'engineering-manager': {
        startedAt: '2026-10-28T10:00:00.000Z',
        endedAt: '2026-10-28T10:05:00.000Z',
      },
      // Sent a message it hasn't started on yet: busy.
      dev: {
        startedAt: '2026-10-28T10:00:00.000Z',
        endedAt: '2026-10-28T10:05:00.000Z',
        sentAt: '2026-10-28T10:06:00.000Z',
      },
      qa: {
        startedAt: '2026-10-28T10:07:00.000Z',
        endedAt: '2026-10-28T10:01:00.000Z',
      },
    };
    const panes: Record<string, number> = { dev: 100, qa: 200 };

    expect(
      agentActivity({
        turn: (role) => turns[role] ?? {},
        panePid: (role) => panes[role] ?? null,
        processes: () => rows,
      })
    ).toEqual({ busy: ['dev', 'qa'], running: ['dev'] });
  });

  it("reads the Engineering manager's own window, `manager`, not one that doesn't exist", () => {
    const pod: Pick<Pod, 'kind'> = { kind: 'building' };

    expect(agentPane('main', pod, 'engineering-manager')).toBe(
      '=main:=manager'
    );
    expect(agentPane('main', pod, 'dev')).toBe('=main:=dev');
  });
});
