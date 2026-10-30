import { Command } from 'commander';

import { registerAgentCommand } from '../../examples/src/commands/agent';
import { registerAwaitCommand } from '../../examples/src/commands/await';
import { registerShipCommand } from '../../examples/src/commands/ship';
import { registerTmuxCommand } from '../../examples/src/commands/tmux';
import {
  assertPaneName,
  assertTicketId,
  assertWindowTarget,
} from '../../examples/src/utils/validate';

jest.mock('child_process', () => {
  const refuse = (): never => {
    throw new Error('the demo CLI ran a command');
  };

  return { execSync: jest.fn(refuse), execFileSync: jest.fn(refuse) };
});

const INJECTION = 'DEMO-1; touch /tmp/leslie';

const runDemo = (
  register: (program: Command) => void,
  args: string[]
): Promise<unknown> => {
  const program = new Command().exitOverride();
  register(program);

  return program.parseAsync(args, { from: 'user' });
};

beforeEach(() => {
  jest.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit(${String(code)})`);
  });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("the demo CLI's argument validators", () => {
  it.each(['DEMO-1', 'PAWNEE-42'])('accepts the ticket id %s', (id) => {
    expect(assertTicketId(id)).toBe(id);
  });

  it.each([INJECTION, 'demo-1', 'DEMO-', '$(whoami)', 'DEMO-1 --delete'])(
    'refuses the ticket id %j',
    (id) => {
      expect(() => assertTicketId(id)).toThrow(/ticket id/);
    }
  );

  it.each(['ron', 'dev-server', 'scratchPad'])(
    'accepts the pane %s',
    (pane) => {
      expect(assertPaneName(pane)).toBe(pane);
    }
  );

  it.each(['ron"; touch /tmp/leslie; "', 'ron sam', '$(whoami)', ''])(
    'refuses the pane %j',
    (pane) => {
      expect(() => assertPaneName(pane)).toThrow(/pane name/);
    }
  );

  it('accepts a session:window target and refuses anything else', () => {
    expect(assertWindowTarget('lambda:ron')).toBe('lambda:ron');
    expect(() => assertWindowTarget("lambda:ron' ; touch /tmp/leslie")).toThrow(
      /window/
    );
  });
});

describe("the demo CLI's entry points", () => {
  it('ship refuses a ticket id that is not one, before running anything', async () => {
    await expect(
      runDemo(registerShipCommand, ['ship', INJECTION])
    ).rejects.toThrow(/ticket id/);
  });

  it('tmux refuses a pane name that is not one, before running anything', async () => {
    await expect(
      runDemo(registerTmuxCommand, ['tmux', 'ron"; touch /tmp/leslie; "'])
    ).rejects.toThrow(/pane name/);
  });

  it('await refuses a pane name that is not one, before running anything', async () => {
    await expect(
      runDemo(registerAwaitCommand, ['await', '$(touch /tmp/leslie)'])
    ).rejects.toThrow(/pane name/);
  });

  it('agent compact refuses a window that is not one, before running anything', async () => {
    await expect(
      runDemo(registerAgentCommand, [
        'agent',
        'compact',
        '-w',
        "lambda:ron'; touch /tmp/leslie; '",
      ])
    ).rejects.toThrow(/window/);
  }, 10_000);
});
