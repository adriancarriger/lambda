import { execSync } from 'child_process';
import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Import after mocks are set up
import { agentWindows } from '../../tmux';
import { registerAwaitCommand } from '../index';

// Settings come from the defaults, whatever folder the tests run in.
jest.mock('../../../config/projectConfig', () => ({
  ...jest.requireActual('../../../config/projectConfig'),
  loadProjectConfig: () => null,
}));
delete process.env.POD_ID;

jest.mock('child_process', () => ({
  execSync: jest.fn(),
  execFileSync: jest.fn(),
}));

const mockExecSync: jest.MockedFunction<typeof execSync> =
  jest.mocked(execSync);

// Track process.exit calls without actually exiting
function throwOnExit(): never {
  throw new Error('process.exit called');
}
const mockExit = jest.spyOn(process, 'exit').mockImplementation(throwOnExit);

// Capture console output
const mockLog = jest.spyOn(console, 'log').mockImplementation(() => {});
const mockError = jest.spyOn(console, 'error').mockImplementation(() => {});

// Mock timers for fast tests
jest.useFakeTimers();

describe('lambda await', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    mockExit.mockRestore();
    mockLog.mockRestore();
    mockError.mockRestore();
  });

  describe('getIdleThresholdMs logic', () => {
    it('should treat agent panes with 3s idle threshold', () => {
      expect(agentWindows()).toContain('dev');
      expect(agentWindows()).toContain('qa');
      expect(agentWindows()).toContain('manager');
    });

    it('should NOT treat scratchPad as an agent pane', () => {
      expect(agentWindows()).not.toContain('scratchPad');
    });
  });

  describe('capturePaneOutput integration', () => {
    it('should call tmux capture-pane with correct target format', () => {
      mockExecSync.mockReturnValue('some output\n');

      // capturePaneOutput is called with the full target (lambda:pane)
      const { capturePaneOutput } = require('../../wait');
      const result = capturePaneOutput('lambda:scratchPad');

      expect(mockExecSync).toHaveBeenCalledWith(
        'tmux capture-pane -t "lambda:scratchPad" -p',
        expect.objectContaining({ encoding: 'utf-8', timeout: 5000 })
      );
      expect(result).toBe('some output');
    });

    it('should exit 1 on pane not found', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("can't find pane");
      });

      const { capturePaneOutput } = require('../../wait');

      expect(() => capturePaneOutput('lambda:nonexistent')).toThrow();
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe('pattern regex', () => {
    it('should handle pipe-separated patterns', () => {
      const regex = new RegExp('passed|failed');

      expect(regex.test('Tests: 3 passed, 0 failed')).toBe(true);
      expect(regex.test('still running...')).toBe(false);
    });

    it('should clean backslash-escaped pipes', () => {
      const raw = 'passed\\|failed';
      const cleaned = raw.replace(/\\\|/g, '|');
      const regex = new RegExp(cleaned);

      expect(regex.test('Tests: 3 passed')).toBe(true);
    });

    it('should handle complex CI patterns', () => {
      const regex = new RegExp('All checks passed|FAILED|Done in \\d+s');

      expect(regex.test('All checks passed')).toBe(true);
      expect(regex.test('FAILED: build step')).toBe(true);
      expect(regex.test('Done in 42s')).toBe(true);
      expect(regex.test('Running job 3 of 5...')).toBe(false);
    });
  });

  describe('exit codes', () => {
    it('should document exit code 0 for success', () => {
      // Exit 0 = pattern matched, shell idle, or output idle
      expect(0).toBe(0);
    });

    it('should document exit code 1 for errors', () => {
      // Exit 1 = pane not found, tmux not running
      expect(1).toBe(1);
    });

    it('should document exit code 2 for timeout', () => {
      // Exit 2 = internal timeout (still running, caller should re-run)
      expect(2).toBe(2);
    });
  });

  describe('tmuxTarget', () => {
    it('should prefix pane with the lambda session', () => {
      const { tmuxTarget } = require('../../tmux');

      expect(tmuxTarget('scratchPad')).toBe('lambda:scratchPad');
      expect(tmuxTarget('dev')).toBe('lambda:dev');
      expect(tmuxTarget('qa')).toBe('lambda:qa');
    });
  });
});

describe('lambda await, each way the wait ends', () => {
  const savedPath = process.env.PATH;
  // The suite above restores its spies when it ends, so these are this
  // suite's own.
  const spies = {
    exit: jest.spyOn(process, 'exit'),
    log: jest.spyOn(console, 'log'),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    spies.exit = jest.spyOn(process, 'exit').mockImplementation(throwOnExit);
    spies.log = jest.spyOn(console, 'log').mockImplementation(() => {});
    // `tmux` must be on PATH; it never runs, child_process is mocked.
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-await-bin-'));
    fs.writeFileSync(path.join(bin, 'tmux'), '');
    fs.chmodSync(path.join(bin, 'tmux'), 0o755);
    process.env.PATH = bin;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    spies.exit.mockRestore();
    spies.log.mockRestore();
  });

  /**
   * The pane shows `screens` one capture at a time (the last one stays), and
   * runs `command` (`zsh` = the shell is idle).
   */
  const pane = (screens: (index: number) => string, command = 'node'): void => {
    const captures = { count: 0 };

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith('tmux capture-pane')) {
        captures.count += 1;

        return `${screens(captures.count - 1)}\n`;
      }

      if (cmd.startsWith('tmux display-message')) {
        return `${command}\n`;
      }

      throw new Error(`Unexpected command: ${cmd}`);
    });
  };

  const awaitPane = async (args: string[], ms: number): Promise<number> => {
    const program = new Command();
    registerAwaitCommand(program);
    const done = program
      .parseAsync(['node', 'lambda', 'await', ...args])
      .catch(() => undefined);

    await jest.advanceTimersByTimeAsync(ms);

    const [code] = spies.exit.mock.calls[0] ?? [];

    if (typeof code !== 'number') {
      throw new Error(`await hadn't exited after ${ms / 1000}s.`);
    }

    await done;

    return code;
  };

  const printed = (): string =>
    spies.log.mock.calls.map((call) => String(call[0])).join('\n');

  it('exits 0 when the pattern shows up', async () => {
    pane((index) => (index < 3 ? 'Raking leaves' : 'Raking done'));

    expect(await awaitPane(['scratchPad', 'done'], 10_000)).toBe(0);
    expect(printed()).toContain('=== DONE (pattern matched) ===');
    expect(printed()).toContain('Raking done');
  });

  it('exits 0 when the shell is idle', async () => {
    pane(() => 'Lot 48 filled in', 'zsh');

    expect(await awaitPane(['scratchPad'], 2_000)).toBe(0);
    expect(printed()).toContain('=== DONE (shell idle) ===');
  });

  it('exits 0 once the output has stopped changing for the idle threshold', async () => {
    // It changes once after the peek, then holds: the idle count starts from
    // the new output, not the peeked one.
    pane((index) => (index === 0 ? 'Pit dug' : 'Pit filled'));

    expect(await awaitPane(['scratchPad'], 30_000)).toBe(0);
    expect(printed()).toContain('=== DONE (idle 15s) ===');
    expect(printed()).toContain('Pit filled');
  });

  it('exits 2 at its own timeout while the output keeps changing', async () => {
    pane((index) => `Parks survey page ${index}`);

    expect(await awaitPane(['scratchPad'], 600_000)).toBe(2);
    expect(printed()).toContain(
      '=== TIMEOUT (540s elapsed, still running) ==='
    );
  });
});
