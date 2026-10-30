import { spawn } from 'child_process';
import * as os from 'os';

/** Quote one argument for a POSIX shell. */
export const shellQuote = (arg: string): string =>
  `'${arg.replace(/'/g, `'\\''`)}'`;

/**
 * Run a command with inherited stdio and resolve with its exit code
 * (`128 + <signal number>` when a signal ended it, 127 when not found).
 */
export const runInherited = (
  command: string,
  args: string[],
  options: { cwd: string; shell?: boolean }
): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: 'inherit',
      shell: options.shell ?? false,
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      console.error(
        error.code === 'ENOENT'
          ? `${command} not found.`
          : `${command} failed: ${error.message}`
      );
      resolve(error.code === 'ENOENT' ? 127 : 1);
    });
    child.on('exit', (code, signal) => {
      resolve(
        signal === null ? code ?? 1 : 128 + (os.constants.signals[signal] ?? 0)
      );
    });
  });
