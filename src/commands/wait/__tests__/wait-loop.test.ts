import { execSync } from 'child_process';

import {
  clearReceiptsForPane,
  createSendReceipt,
  runWaitCommand,
} from '../index';

jest.mock('child_process', () => ({
  execSync: jest.fn(),
  execFileSync: jest.fn(),
}));

const mockExecSync: jest.MockedFunction<typeof execSync> =
  jest.mocked(execSync);

function throwOnExit(): never {
  throw new Error('process.exit called');
}

jest.useFakeTimers();

/** A pane name of this suite's own, so its receipts touch no one else's. */
const PANE = 'lambda-wait-loop-test:scratchPad';

/**
 * The pane shows `screens` one capture at a time and runs `command`
 * (`zsh` = the shell is idle).
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

describe('lambda tmux <pane> wait, each way the wait ends', () => {
  const spies = {
    exit: jest.spyOn(process, 'exit').mockImplementation(throwOnExit),
    log: jest.spyOn(console, 'log').mockImplementation(() => {}),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    clearReceiptsForPane(PANE);
  });

  afterAll(() => {
    clearReceiptsForPane(PANE);
    spies.exit.mockRestore();
    spies.log.mockRestore();
  });

  /** Block (a send receipt skips the peek) and return the exit code. */
  const block = async (
    options: { pattern?: string; timeoutSec?: number; idleSec?: number },
    ms: number
  ): Promise<number> => {
    createSendReceipt(PANE);
    const done = runWaitCommand({ pane: PANE, ...options }).catch(
      () => undefined
    );

    await jest.advanceTimersByTimeAsync(ms);

    const [code] = spies.exit.mock.calls[0] ?? [];

    if (typeof code !== 'number') {
      throw new Error(`wait hadn't exited after ${ms / 1000}s.`);
    }

    await done;

    return code;
  };

  const printed = (): string =>
    spies.log.mock.calls.map((call) => String(call[0])).join('\n');

  it('peeks first, without blocking or exiting', async () => {
    pane(() => 'Raking leaves');
    const done = runWaitCommand({ pane: PANE });

    await jest.advanceTimersByTimeAsync(1_000);
    await done;

    expect(spies.exit).not.toHaveBeenCalled();
    expect(printed()).toContain('=== PEEK');
    expect(printed()).toContain('Raking leaves');
  });

  it('exits 0 when the pattern shows up', async () => {
    pane((index) => (index < 3 ? 'Raking leaves' : 'Raking done'));

    expect(await block({ pattern: 'done' }, 10_000)).toBe(0);
    expect(printed()).toContain('=== COMPLETED (found pattern');
    expect(printed()).toContain('Raking done');
  });

  it('exits 0 when the shell is idle', async () => {
    pane(() => 'Lot 48 filled in', 'zsh');

    expect(await block({}, 2_000)).toBe(0);
    expect(printed()).toContain('=== COMPLETED (command exited');
  });

  it('exits 0 once the output has stopped changing for idleSec', async () => {
    // The idle count compares each capture with the one before it.
    pane((index) => (index === 0 ? 'Pit dug' : 'Pit filled'));

    expect(await block({ idleSec: 3 }, 10_000)).toBe(0);
    expect(printed()).toContain('=== IDLE (no new output for 3s');
    expect(printed()).toContain('Pit filled');
  });

  it('exits 1 at the timeout while the output keeps changing', async () => {
    pane((index) => `Parks survey page ${index}`);

    expect(await block({ timeoutSec: 5, idleSec: 3 }, 10_000)).toBe(1);
    expect(printed()).toContain('=== STILL RUNNING (timeout');
  });
});
