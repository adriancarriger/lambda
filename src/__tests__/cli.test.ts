import { type Command } from 'commander';

import { createProgram } from '../cli';

const BUILT_INS = {
  init: 'Write lambda.json for this codebase',
  doctor: 'Show where each command comes from',
  tmux: "Send to or read an agent's window",
  await: "Wait until an agent's window is done",
  agent: 'Compact, clear or inspect an agent',
  e2e: 'Run Playwright tests (traces kept on failure)',
  trace: "Read a failed test's trace",
  tickets: "Read and change the codebase's tickets",
  planning: "Show this codebase's planning process",
  building: "Show this codebase's building process",
  pod: 'Run planning pods: a planning manager and a dev',
  knowledge: 'Keep lasting judgements and copy rules',
  start: "Start this codebase's services and Lambda",
  stop: "Stop this codebase's services and pods",
  open: 'Open Lambda in your browser, signed in',
  join: 'Make this computer part of your Lambda',
  leave: 'Take this computer out of your Lambda',
  status: 'What this computer is doing for Lambda',
  event: 'Record an event for the Analytics page',
  account: 'The logins that count as you',
  verdict: "Record or read a ticket's check-ticket verdict",
  ship: 'Ship a ticket behind its verdict',
};

/** Parse in-process, capturing stdout instead of exiting. */
const output = async (args: string[]): Promise<string> => {
  const written: string[] = [];
  const program: Command = createProgram();
  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => {
      written.splice(written.length, 0, text);
    },
    writeErr: (text) => {
      written.splice(written.length, 0, text);
    },
  });

  await program.parseAsync(['node', 'lambda', ...args]).catch(() => undefined);

  return written.join('');
};

describe('the lambda program', () => {
  it('prints its version', async () => {
    expect((await output(['--version'])).trim()).toBe('0.2.0');
  });

  it('lists the built-ins and where anything else goes', async () => {
    const help = await output(['--help']);

    Object.entries(BUILT_INS).forEach(([name, description]) =>
      expect(help).toContain(`  ${name.padEnd(9)} ${description}`)
    );
    expect(help).toContain(
      "Anything else runs your project's CLI (see lambda doctor)."
    );
  });

  it('lists ship and verdict, once reserved and now built in', async () => {
    const commandLines = (await output(['--help']))
      .split('\n')
      .filter((line) => /^ {2}\S/.test(line))
      .map((line) => line.trim().split(/\s+/)[0]);

    expect(commandLines).toEqual(expect.arrayContaining(['ship', 'verdict']));
  });
});
