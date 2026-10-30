import { spawn } from 'child_process';

const killGroup = (pid: number | undefined): void => {
  if (pid === undefined) {
    return;
  }

  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
  } catch (error) {
    // Already gone between the timeout and the kill: nothing left to stop.
    if (
      !(
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ESRCH'
      )
    ) {
      throw error;
    }
  }
};

/**
 * A project's own command (`commands.stop`), run through the shell without
 * blocking: inside the runner, a stop that hangs would otherwise freeze its
 * socket, outbox and timers. Past `timeoutMs` it's killed and fails.
 */
export const runShellCommand = (
  command: string,
  cwd: string,
  options: { timeoutMs?: number; stdio?: 'inherit' | 'ignore' } = {}
): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: options.stdio ?? 'ignore',
      // With a timeout (the runner), its own process group, so the kill stops
      // what it started too. Without (the CLI), it stays in the terminal's
      // group: Ctrl-C reaches it, and reading the tty can't stop it (SIGTTIN).
      detached: options.timeoutMs !== undefined && process.platform !== 'win32',
    });
    const state = { timedOut: false };
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            state.timedOut = true;
            killGroup(child.pid);
          }, options.timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`"${command}" didn't run: ${error.message}`));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);

      if (state.timedOut) {
        reject(
          new Error(
            `"${command}" took longer than ${
              (options.timeoutMs ?? 0) / 1000
            } s and was stopped.`
          )
        );

        return;
      }

      if (code !== 0) {
        reject(new Error(`"${command}" failed (exit ${String(code)}).`));

        return;
      }

      resolve();
    });
  });
