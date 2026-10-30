import { type Command } from 'commander';

import { createProgram } from '../../cli';
import './podProject';

/**
 * How `lambda pod` reads its arguments: `skip-ticket <pod-id> <ticket-id>`,
 * `screenshot <file>` with the pod from POD_ID, and `ask --thread <id>
 * --wait` with no target or question.
 */

const recorded: { calls: { name: string; args: unknown[] }[] } = {
  calls: [],
};

jest.mock('../../building/skipTicket', () => ({
  runSkipTicket: async (...args: unknown[]) => {
    recorded.calls = [
      ...recorded.calls,
      { name: 'skip-ticket', args: args.slice(0, 2) },
    ];
  },
}));

jest.mock('../../building/screenshots', () => ({
  runScreenshot: (...args: unknown[]) => {
    recorded.calls = [
      ...recorded.calls,
      { name: 'screenshot', args: args.slice(0, 2) },
    ];
  },
}));

jest.mock('../ask', () => ({
  ...jest.requireActual('../ask'),
  runAsk: async (...args: unknown[]) => {
    recorded.calls = [
      ...recorded.calls,
      { name: 'ask', args: args.slice(0, 3) },
    ];

    return 'a1b2c3';
  },
}));

jest.mock('../context', () => ({
  ...jest.requireActual('../context'),
  callerAgent: () => 'engineering-manager',
  openStore: () => ({}),
  openTickets: () => ({}),
}));

/** Parse in-process: a usage error throws instead of exiting jest. */
const parse = async (args: string[]) => {
  const program: Command = createProgram();
  const quiet = (command: Command): void => {
    command.exitOverride();
    command.configureOutput({ writeErr: () => undefined });
    command.commands.forEach(quiet);
  };
  quiet(program);

  return program.parseAsync(['node', 'lambda', ...args]);
};

afterEach(() => {
  recorded.calls = [];
  process.exitCode = undefined;
});

describe('lambda pod skip-ticket', () => {
  it('takes the pod id, then the ticket id', async () => {
    await parse(['pod', 'skip-ticket', 'build-a1b2', '4']);

    expect(recorded.calls).toEqual([
      { name: 'skip-ticket', args: ['build-a1b2', '4'] },
    ]);
    expect(process.exitCode).toBeUndefined();
  });
});

describe('lambda pod screenshot', () => {
  const flags = ['--url', 'http://localhost:3000', '--conclusion', 'Pin shows'];

  it("takes only the file: qa's pod comes from POD_ID, even after a /clear", async () => {
    await parse(['pod', 'screenshot', 'ramsett.png', ...flags, '--passed']);

    expect(recorded.calls).toEqual([
      { name: 'screenshot', args: [undefined, 'ramsett.png'] },
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it('takes a pod named with --pod', async () => {
    await parse([
      'pod',
      'screenshot',
      'ramsett.png',
      '--pod',
      'build-a1b2',
      ...flags,
      '--passed',
    ]);

    expect(recorded.calls).toEqual([
      { name: 'screenshot', args: ['build-a1b2', 'ramsett.png'] },
    ]);
  });
});

describe('lambda pod ask --wait', () => {
  it('passes --wait on, with no target or question', async () => {
    await parse(['pod', 'ask', '--thread', 'a1b2c3', '--wait']);

    expect(recorded.calls).toEqual([
      {
        name: 'ask',
        args: [
          '',
          '',
          expect.objectContaining({ thread: 'a1b2c3', wait: true }),
        ],
      },
    ]);
  });
});
