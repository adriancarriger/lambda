import { run } from '../cli';

/**
 * `lambda <args>` in-process, as `bin/lambda` runs it, with some environment
 * set for the run: its exit code and what it printed (stdout and stderr).
 */
export const runCli = async (
  args: string[],
  env: Record<string, string>
): Promise<{ code: number; out: string; err: string }> => {
  const saved = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]])
  );
  const printed: { out: string[]; err: string[] } = { out: [], err: [] };
  const log = jest.spyOn(console, 'log').mockImplementation((line: unknown) => {
    printed.out = [...printed.out, String(line)];
  });
  const error = jest
    .spyOn(console, 'error')
    .mockImplementation((line: unknown) => {
      printed.err = [...printed.err, String(line)];
    });
  Object.assign(process.env, env);

  try {
    const code = await run(['node', 'lambda', ...args]);

    return { code, out: printed.out.join('\n'), err: printed.err.join('\n') };
  } finally {
    log.mockRestore();
    error.mockRestore();
    Object.entries(saved).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
    process.exitCode = undefined;
  }
};
