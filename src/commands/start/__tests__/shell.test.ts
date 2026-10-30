import * as childProcess from 'child_process';
import * as os from 'os';

import { runShellCommand } from '../shell';

// The real spawn, watched: its options are what keep Ctrl-C working.
jest.mock('child_process', () => {
  const actual: typeof import('child_process') =
    jest.requireActual('child_process');

  return { ...actual, spawn: jest.fn(actual.spawn) };
});

/**
 * `commands.stop` runs inside the runner during an idle switch: a stop that
 * hangs must not freeze the runner (its socket, outbox and timers).
 */
describe("a project's own shell command", () => {
  it('leaves the runner running while it runs', async () => {
    const ticks: { n: number } = { n: 0 };
    const timer = setInterval(() => {
      ticks.n += 1;
    }, 20);

    await runShellCommand('sleep 0.5', os.tmpdir());
    clearInterval(timer);

    expect(ticks.n).toBeGreaterThan(5);
  });

  it('is stopped, and fails, when it runs past its time', async () => {
    const started = Date.now();

    await expect(
      runShellCommand('sleep 30', os.tmpdir(), { timeoutMs: 200 })
    ).rejects.toThrow('"sleep 30" took longer than 0.2 s and was stopped.');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('fails with its exit code', async () => {
    await expect(runShellCommand('exit 4', os.tmpdir())).rejects.toThrow(
      '"exit 4" failed (exit 4).'
    );
  });

  it('stays in the terminal from the CLI, and goes in its own group only with a timeout', async () => {
    const spawned = jest.mocked(childProcess.spawn);
    spawned.mockClear();

    // `lambda stop` in a terminal: a stop that reads the tty must not hang
    // on SIGTTIN, and Ctrl-C must reach it.
    await runShellCommand('true', os.tmpdir(), { stdio: 'inherit' });
    // The runner: a timeout must stop what it started too.
    await runShellCommand('true', os.tmpdir(), { timeoutMs: 5_000 });

    expect(spawned.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ detached: false, stdio: 'inherit' }),
      expect.objectContaining({
        detached: process.platform !== 'win32',
        stdio: 'ignore',
      }),
    ]);
  });
});
