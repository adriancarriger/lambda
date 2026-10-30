import { Command } from 'commander';

import { registerDesignCommand } from '../../commands/design';

/**
 * `lambda design <args>` through commander, as the CLI runs it: the exit code
 * it set and what it printed (stdout and stderr). Not a test file.
 */
export const runDesign = async (
  args: string[]
): Promise<{ code: number; out: string; err: string }> => {
  const printed: { out: string[]; err: string[] } = { out: [], err: [] };
  const log = jest.spyOn(console, 'log').mockImplementation((line: unknown) => {
    printed.out = [...printed.out, String(line)];
  });
  const error = jest
    .spyOn(console, 'error')
    .mockImplementation((line: unknown) => {
      printed.err = [...printed.err, String(line)];
    });
  const program = new Command('lambda').exitOverride();
  registerDesignCommand(program);

  try {
    await program.parseAsync(['design', ...args], { from: 'user' });

    return {
      code: Number(process.exitCode ?? 0),
      out: printed.out.join('\n'),
      err: printed.err.join('\n'),
    };
  } finally {
    log.mockRestore();
    error.mockRestore();
    process.exitCode = undefined;
  }
};
