import { execFileSync, execSync } from 'child_process';

import {
  TMUX_KEY_PATTERN,
  agentWindows,
  isAgentPane,
  sendText,
  tmuxTarget,
} from '../index';
import { getPaneStatusTag } from '../pane-status';

jest.mock('child_process');
// tmux is "installed" whatever the machine; settings.test.ts covers its absence.
jest.mock('../../../utils/onPath', () => ({ onPath: () => true }));
// Settings come from the defaults, whatever folder the tests run in.
jest.mock('../../../config/projectConfig', () => ({
  ...jest.requireActual('../../../config/projectConfig'),
  loadProjectConfig: () => null,
}));
delete process.env.POD_ID;
jest.mock('../../agent/agent-logger', () => ({
  detectAgent: () => 'test',
  extractTicketId: () => undefined,
  logCommand: jest.fn(),
}));
jest.mock('../../wait', () => ({
  clearReceiptsForPane: jest.fn(),
  createSendReceipt: jest.fn(),
  runWaitCommand: jest.fn(),
}));
jest.mock('../pane-status', () => ({
  getPaneStatusTag: jest.fn().mockReturnValue('[idle]'),
}));

const mockExecSync = jest.mocked(execSync);
const mockExecFileSync = jest.mocked(execFileSync);

/** A `tmux send-keys …` call's args, or undefined for any other call. */
const sendKeysArgs = (call: readonly unknown[]): string[] | undefined => {
  const [cmd, args] = call;

  if (cmd !== 'tmux' || !Array.isArray(args)) {
    return undefined;
  }

  const strings = args.filter((arg): arg is string => typeof arg === 'string');

  return strings.includes('send-keys') ? strings : undefined;
};

/** Every send-keys call in the execFileSync mock, as `['tmux', args]`. */
function findAllSendKeysCalls(): Array<[string, string[]]> {
  return mockExecFileSync.mock.calls.flatMap(
    (call): Array<[string, string[]]> => {
      const args = sendKeysArgs(call);

      return args === undefined ? [] : [['tmux', args]];
    }
  );
}

/** Find a send-keys call in execFileSync mock calls */
function findSendKeysCall(
  predicate?: (args: string[]) => boolean
): [string, string[]] | undefined {
  return findAllSendKeysCalls().find(([, args]) =>
    predicate ? predicate(args) : true
  );
}

describe('tmuxTarget', () => {
  it('should prefix pane with the lambda session', () => {
    expect(tmuxTarget('scratchPad')).toBe('lambda:scratchPad');
  });

  it('should work with agent panes', () => {
    expect(tmuxTarget('dev')).toBe('lambda:dev');
  });
});

describe('isAgentPane', () => {
  it('should return true for dev', () => {
    expect(isAgentPane('dev')).toBe(true);
  });

  it('should return true for qa', () => {
    expect(isAgentPane('qa')).toBe(true);
  });

  it('should return true for manager', () => {
    expect(isAgentPane('manager')).toBe(true);
  });

  it('should return false for scratchPad', () => {
    expect(isAgentPane('scratchPad')).toBe(false);
  });

  it('should return false for web', () => {
    expect(isAgentPane('web')).toBe(false);
  });

  it('should return false for server', () => {
    expect(isAgentPane('server')).toBe(false);
  });
});

describe('agentWindows', () => {
  it('should contain exactly dev, qa, and manager', () => {
    expect(agentWindows()).toEqual(['manager', 'dev', 'qa']);
  });
});

describe('TMUX_KEY_PATTERN', () => {
  describe('should match known tmux keys', () => {
    const validKeys = [
      'Enter',
      'Escape',
      'BSpace',
      'BTab',
      'Space',
      'Tab',
      'Home',
      'End',
      'PageUp',
      'PageDown',
      'Up',
      'Down',
      'Left',
      'Right',
      'F1',
      'F12',
      'C-c',
      'C-z',
      'C-a',
      'C-d',
    ];

    for (const key of validKeys) {
      it(`should match "${key}"`, () => {
        expect(TMUX_KEY_PATTERN.test(key)).toBe(true);
      });
    }
  });

  describe('should not match non-key strings', () => {
    const invalidKeys = [
      'enter',
      'ENTER',
      'C-1',
      'C-C',
      'F',
      'echo hello',
      '/clear',
      'C-',
      'F0F',
      'BSpace ',
      ' Enter',
      'C-cc',
    ];

    for (const key of invalidKeys) {
      it(`should not match "${key}"`, () => {
        expect(TMUX_KEY_PATTERN.test(key)).toBe(false);
      });
    }
  });
});

describe('sendKeys', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default mock for capture-pane calls (used by sendText auto-read)
    mockExecSync.mockReturnValue('mock output\n');
  });

  it('should send a single key via execFileSync', () => {
    const { registerTmuxCommand } = require('../index');
    const { Command } = require('commander');
    const program = new Command();
    registerTmuxCommand(program);

    mockExecFileSync.mockReturnValue('');
    // Reset execSync — key sends don't trigger capture-pane
    mockExecSync.mockReset();
    program.parse(['node', 'lambda', 'tmux', 'scratchPad', 'Enter']);

    const call = findSendKeysCall();
    expect(call).toBeDefined();
    expect(call![1]).toEqual(['send-keys', '-t', 'lambda:scratchPad', 'Enter']);
  });

  it('should pass backticks through without escaping', () => {
    const { registerTmuxCommand } = require('../index');
    const { Command } = require('commander');
    const program = new Command();
    registerTmuxCommand(program);

    mockExecFileSync.mockReturnValue('');
    program.parse([
      'node',
      'lambda',
      'tmux',
      'scratchPad',
      'run `make check` now',
    ]);

    const call = findSendKeysCall((args) =>
      args.includes('run `make check` now')
    );
    expect(call).toBeDefined();
    expect(call![1]).toEqual([
      'send-keys',
      '-t',
      'lambda:scratchPad',
      'run `make check` now',
      'Enter',
    ]);
  });

  it('should pass dollar signs through without escaping', () => {
    const { registerTmuxCommand } = require('../index');
    const { Command } = require('commander');
    const program = new Command();
    registerTmuxCommand(program);

    mockExecFileSync.mockReturnValue('');
    program.parse(['node', 'lambda', 'tmux', 'scratchPad', 'echo $HOME']);

    const call = findSendKeysCall((args) => args.includes('echo $HOME'));
    expect(call).toBeDefined();
    expect(call![1]).toEqual([
      'send-keys',
      '-t',
      'lambda:scratchPad',
      'echo $HOME',
      'Enter',
    ]);
  });

  it('should send text with Enter as separate args', () => {
    const { registerTmuxCommand } = require('../index');
    const { Command } = require('commander');
    const program = new Command();
    registerTmuxCommand(program);

    mockExecFileSync.mockReturnValue('');
    program.parse(['node', 'lambda', 'tmux', 'scratchPad', 'echo hello']);

    const call = findSendKeysCall((args) => args.includes('echo hello'));
    expect(call).toBeDefined();
    expect(call![1]).toEqual([
      'send-keys',
      '-t',
      'lambda:scratchPad',
      'echo hello',
      'Enter',
    ]);
  });
});

describe('capture mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should call capture-pane when no args provided', () => {
    const { registerTmuxCommand } = require('../index');
    const { Command } = require('commander');
    const program = new Command();
    registerTmuxCommand(program);

    mockExecSync.mockReturnValue('pane output here\n');
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    program.parse(['node', 'lambda', 'tmux', 'scratchPad']);

    const captureCall = mockExecSync.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('capture-pane')
    );
    expect(captureCall).toBeDefined();
    expect(captureCall![0]).toBe(
      'tmux capture-pane -t "lambda:scratchPad" -p -S -40'
    );

    consoleSpy.mockRestore();
  });

  it('should include status tag in output header', () => {
    jest.mocked(getPaneStatusTag).mockReturnValue('[running: node]');

    const { registerTmuxCommand } = require('../index');
    const { Command } = require('commander');
    const program = new Command();
    registerTmuxCommand(program);

    mockExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.includes('capture-pane')) {
        return 'pane output here';
      }

      if (typeof cmd === 'string' && cmd.includes('pane_current_path')) {
        return '/home/user\n';
      }

      return '';
    });
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    program.parse(['node', 'lambda', 'tmux', 'scratchPad']);

    expect(consoleSpy).toHaveBeenCalledWith('[/home/user] [running: node]');

    consoleSpy.mockRestore();
  });
});

describe('--scrollback flag', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /** Run a capture and return the `capture-pane` command string that was issued. */
  function captureCommandFor(argv: string[]): string {
    const { registerTmuxCommand } = require('../index');
    const { Command } = require('commander');
    const program = new Command();
    registerTmuxCommand(program);

    mockExecSync.mockReturnValue('pane output here\n');
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    program.parse(argv);

    const call = mockExecSync.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('capture-pane')
    );

    consoleSpy.mockRestore();

    const command = call?.[0];

    if (typeof command !== 'string') {
      throw new Error('No capture-pane command was issued.');
    }

    return command;
  }

  it('should reach further back in history when --scrollback is given', () => {
    expect(
      captureCommandFor([
        'node',
        'lambda',
        'tmux',
        'scratchPad',
        '--scrollback',
        '500',
      ])
    ).toBe('tmux capture-pane -t "lambda:scratchPad" -p -S -500');
  });

  it('should support the -S short form', () => {
    expect(
      captureCommandFor(['node', 'lambda', 'tmux', 'scratchPad', '-S', '200'])
    ).toBe('tmux capture-pane -t "lambda:scratchPad" -p -S -200');
  });

  // The whole point of the flag is that the DEFAULT must not shift — every existing
  // agent workflow reads panes through this path.
  it('should keep the historical default when the flag is absent', () => {
    expect(captureCommandFor(['node', 'lambda', 'tmux', 'scratchPad'])).toBe(
      'tmux capture-pane -t "lambda:scratchPad" -p -S -40'
    );
  });

  it('should accept 0 (visible region only)', () => {
    expect(
      captureCommandFor(['node', 'lambda', 'tmux', 'scratchPad', '-S', '0'])
    ).toBe('tmux capture-pane -t "lambda:scratchPad" -p -S -0');
  });

  describe('parseScrollback', () => {
    // Rejecting loudly matters: silently falling back to the default would produce
    // a truncated capture, which is the exact failure this flag exists to remove.
    it.each(['abc', '-5', '1.5', ''])(
      'should exit rather than silently default on %p',
      (bad) => {
        const { parseScrollback } = require('../index');
        const errSpy = jest.spyOn(console, 'error').mockImplementation();
        const exitSpy = jest
          .spyOn(process, 'exit')
          .mockImplementation((): never => {
            throw new Error('process.exit');
          });

        expect(() => parseScrollback(bad)).toThrow('process.exit');

        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(errSpy).toHaveBeenCalledWith(
          expect.stringContaining('Invalid --scrollback')
        );

        errSpy.mockRestore();
        exitSpy.mockRestore();
      }
    );

    it('should return undefined when not provided', () => {
      const { parseScrollback } = require('../index');
      expect(parseScrollback(undefined)).toBeUndefined();
    });
  });
});

describe('slash command detection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecSync.mockReturnValue('mock output\n');
  });

  it('should detect slash commands on agent panes', async () => {
    const { registerTmuxCommand } = require('../index');
    const { Command } = require('commander');
    const program = new Command();
    registerTmuxCommand(program);

    // capturePane still uses execSync
    mockExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.includes('capture-pane')) {
        return 'auto mode on';
      }

      return '';
    });
    mockExecFileSync.mockReturnValue('');

    await program.parseAsync(['node', 'lambda', 'tmux', 'dev', '/clear']);

    const sendKeysCalls = findAllSendKeysCalls();

    // Should have: text send, Escape, Enter (as separate calls)
    const textCall = sendKeysCalls.find(([, args]) => args.includes('/clear'));
    const escapeCall = sendKeysCalls.find(
      ([, args]) => args.includes('Escape') && !args.includes('/clear')
    );
    const enterCall = sendKeysCalls.find(
      ([, args]) => args.includes('Enter') && !args.includes('/clear')
    );

    expect(textCall).toBeDefined();
    expect(escapeCall).toBeDefined();
    expect(enterCall).toBeDefined();
  });

  it('should not use slash handling for non-agent panes', async () => {
    const { registerTmuxCommand } = require('../index');
    const { Command } = require('commander');
    const program = new Command();
    registerTmuxCommand(program);

    mockExecFileSync.mockReturnValue('');
    await program.parseAsync([
      'node',
      'lambda',
      'tmux',
      'scratchPad',
      '/some-command',
    ]);

    // Should send text + Enter in one call (no Escape)
    const call = findSendKeysCall((args) => args.includes('/some-command'));
    expect(call).toBeDefined();
    expect(call![1]).toContain('Enter');
    expect(call![1]).not.toContain('Escape');
  });

  it('should not use slash handling for non-slash text on agent panes', async () => {
    const { registerTmuxCommand } = require('../index');
    const { Command } = require('commander');
    const program = new Command();
    registerTmuxCommand(program);

    mockExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.includes('capture-pane')) {
        return 'auto mode on';
      }

      return '';
    });
    mockExecFileSync.mockReturnValue('');

    await program.parseAsync(['node', 'lambda', 'tmux', 'dev', 'echo hello']);

    // Agent panes send text and Enter as separate calls
    const textCall = findSendKeysCall(
      (args) => args.includes('echo hello') && !args.includes('Enter')
    );
    const enterCall = findSendKeysCall(
      (args) => args.includes('Enter') && !args.includes('echo hello')
    );
    expect(textCall).toBeDefined();
    expect(textCall![1]).toEqual([
      'send-keys',
      '-t',
      'lambda:dev',
      'echo hello',
    ]);
    expect(enterCall).toBeDefined();
  });
});

describe('--raw flag', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecSync.mockReturnValue('mock output\n');
  });

  it('should skip mode switching when --raw is used on agent pane', async () => {
    const { registerTmuxCommand } = require('../index');
    const { Command } = require('commander');
    const program = new Command();
    registerTmuxCommand(program);

    mockExecFileSync.mockReturnValue('');
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    await program.parseAsync(['node', 'lambda', 'tmux', 'dev', '--raw', 'y']);

    // Should only have one capture-pane call (the auto-read after send),
    // NOT the mode-switching capture-pane calls
    const captureCalls = mockExecSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('capture-pane')
    );
    expect(captureCalls).toHaveLength(1);

    // Agent panes send text and Enter as separate calls
    const textCall = findSendKeysCall(
      (args) => args.includes('y') && !args.includes('Enter')
    );
    const enterCall = findSendKeysCall(
      (args) => args.includes('Enter') && !args.includes('y')
    );
    expect(textCall).toBeDefined();
    expect(textCall![1]).toEqual(['send-keys', '-t', 'lambda:dev', 'y']);
    expect(enterCall).toBeDefined();
    expect(enterCall![1]).toEqual(['send-keys', '-t', 'lambda:dev', 'Enter']);
    consoleSpy.mockRestore();
  });
});

describe('special character preservation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecSync.mockReturnValue('mock output\n');
  });

  it('should preserve exclamation marks without escaping', () => {
    const { registerTmuxCommand } = require('../index');
    const { Command } = require('commander');
    const program = new Command();
    registerTmuxCommand(program);

    mockExecFileSync.mockReturnValue('');
    program.parse([
      'node',
      'lambda',
      'tmux',
      'scratchPad',
      "jq 'select(.message != null)'",
    ]);

    const call = findSendKeysCall((args) => args.some((a) => a.includes('!=')));
    expect(call).toBeDefined();
    // The ! must appear literally, NOT as \!
    const textArg = call![1].find((a) => a.includes('!='));
    expect(textArg).toBe("jq 'select(.message != null)'");
  });

  it('should preserve double quotes in text', () => {
    const { registerTmuxCommand } = require('../index');
    const { Command } = require('commander');
    const program = new Command();
    registerTmuxCommand(program);

    mockExecFileSync.mockReturnValue('');
    program.parse([
      'node',
      'lambda',
      'tmux',
      'scratchPad',
      'echo "hello world"',
    ]);

    const call = findSendKeysCall((args) =>
      args.some((a) => a.includes('"hello'))
    );
    expect(call).toBeDefined();
    expect(call![1]).toContain('echo "hello world"');
  });
});

describe('-n (no-enter) flag', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecSync.mockReturnValue('mock output\n');
  });

  it('should send text without Enter when -n is used', () => {
    const { registerTmuxCommand } = require('../index');
    const { Command } = require('commander');
    const program = new Command();
    registerTmuxCommand(program);

    mockExecFileSync.mockReturnValue('');
    program.parse([
      'node',
      'lambda',
      'tmux',
      'scratchPad',
      'partial text',
      '-n',
    ]);

    const call = findSendKeysCall((args) => args.includes('partial text'));
    expect(call).toBeDefined();
    expect(call![1]).toEqual([
      'send-keys',
      '-t',
      'lambda:scratchPad',
      'partial text',
    ]);
    // Should NOT contain Enter
    expect(call![1]).not.toContain('Enter');
  });
});

describe('backslash-bang warning', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecSync.mockReturnValue('mock output\n');
  });

  it('should warn on stderr when text contains \\!', async () => {
    mockExecFileSync.mockReturnValue('');
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation();
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    await sendText({
      target: 'lambda:scratchPad',
      pane: 'scratchPad',
      text: 'echo test \\!= value',
      agent: false,
      enter: true,
      raw: false,
    });

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("'\\!'"));
    stderrSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('should still send the command even with \\! warning', async () => {
    mockExecFileSync.mockReturnValue('');
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation();
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    await sendText({
      target: 'lambda:scratchPad',
      pane: 'scratchPad',
      text: 'echo test \\!= value',
      agent: false,
      enter: true,
      raw: false,
    });

    const call = findSendKeysCall((args) =>
      args.some((a) => a.includes('\\!='))
    );
    expect(call).toBeDefined();
    stderrSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('should not warn when text contains clean !', async () => {
    mockExecFileSync.mockReturnValue('');
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation();
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    await sendText({
      target: 'lambda:scratchPad',
      pane: 'scratchPad',
      text: 'echo test != value',
      agent: false,
      enter: true,
      raw: false,
    });

    expect(stderrSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});

describe('--stdin flag', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecSync.mockReturnValue('mock output\n');
  });

  it('should read from stdin and send text when --stdin is used', async () => {
    // Mock stdin as an async iterable
    const stdinData = Buffer.from('echo hello != world\n');
    const originalStdin = process.stdin;
    const mockStdin = Object.create(originalStdin, {
      [Symbol.asyncIterator]: {
        value: async function* () {
          yield stdinData;
        },
      },
    });
    Object.defineProperty(process, 'stdin', {
      value: mockStdin,
      writable: true,
      configurable: true,
    });

    mockExecFileSync.mockReturnValue('');

    const { registerTmuxCommand } = require('../index');
    const { Command } = require('commander');
    const program = new Command();
    registerTmuxCommand(program);

    await program.parseAsync([
      'node',
      'lambda',
      'tmux',
      'scratchPad',
      '--stdin',
    ]);

    const call = findSendKeysCall((args) =>
      args.some((a) => a.includes('echo hello != world'))
    );
    expect(call).toBeDefined();

    Object.defineProperty(process, 'stdin', {
      value: originalStdin,
      writable: true,
      configurable: true,
    });
  });

  it('should trim trailing newlines from stdin input', async () => {
    const stdinData = Buffer.from('echo hello\n\n\n');
    const originalStdin = process.stdin;
    const mockStdin = Object.create(originalStdin, {
      [Symbol.asyncIterator]: {
        value: async function* () {
          yield stdinData;
        },
      },
    });
    Object.defineProperty(process, 'stdin', {
      value: mockStdin,
      writable: true,
      configurable: true,
    });

    mockExecFileSync.mockReturnValue('');

    const { registerTmuxCommand } = require('../index');
    const { Command } = require('commander');
    const program = new Command();
    registerTmuxCommand(program);

    await program.parseAsync([
      'node',
      'lambda',
      'tmux',
      'scratchPad',
      '--stdin',
    ]);

    const call = findSendKeysCall((args) =>
      args.some((a) => a === 'echo hello')
    );
    expect(call).toBeDefined();

    Object.defineProperty(process, 'stdin', {
      value: originalStdin,
      writable: true,
      configurable: true,
    });
  });
});

describe('auto-read after send', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecSync.mockReturnValue('captured output\n');
  });

  it('should capture pane output and create send receipt after sending', async () => {
    const { createSendReceipt } = require('../../wait');
    mockExecFileSync.mockReturnValue('');
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    await sendText({
      target: 'lambda:scratchPad',
      pane: 'scratchPad',
      text: 'echo hello',
      agent: false,
      enter: true,
      raw: false,
    });

    // Should have called capture-pane after sending
    const captureCall = mockExecSync.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('capture-pane')
    );
    expect(captureCall).toBeDefined();

    // Should log the captured output
    expect(consoleSpy).toHaveBeenCalledWith('captured output');

    // Should create a send receipt
    expect(createSendReceipt).toHaveBeenCalledWith('lambda:scratchPad');

    consoleSpy.mockRestore();
  });
});

describe('a message starting with !', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecSync.mockReturnValue('mock output\n');
    mockExecFileSync.mockReturnValue('');
  });

  it('is refused on an agent pane, where Claude Code would run it as a shell command', async () => {
    await expect(
      sendText({
        target: 'lambda:dev',
        pane: 'dev',
        text: '  !git push',
        agent: true,
        enter: true,
        raw: true,
      })
    ).rejects.toThrow(/without the !/);
    expect(findAllSendKeysCalls()).toEqual([]);
  });
});
