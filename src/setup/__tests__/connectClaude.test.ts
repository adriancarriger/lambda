import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  loadMachineConfig,
  machineConfigPath,
} from '../../config/machineConfig';
import {
  FAILED_LINES,
  INSTALLER_COMMAND,
  INSTALL_TIMEOUT_MS,
  PTY_COLUMNS,
  createClaudeConnector,
  findToken,
} from '../connectClaude';
import { ClaudeCodeBody } from '../schemas';
import { FAKE_TOKEN, createFakeSpawn } from './fakePty';

const ESC = '\u001b';

/** A temp home: `HOME/.lambda` for the config, and an empty PATH. */
const tempHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-claude-'));
  const env = { LAMBDA_HOME: path.join(home, '.lambda'), PATH: '' };

  return { home, env };
};

const installClaude = (home: string): string => {
  const claude = path.join(home, '.local', 'bin', 'claude');
  fs.mkdirSync(path.dirname(claude), { recursive: true });
  fs.writeFileSync(claude, '#!/bin/sh\n');
  fs.chmodSync(claude, 0o755);

  return claude;
};

describe('Connect Claude', () => {
  it('finds the token through ANSI noise and saves it 0600', async () => {
    const { home, env } = tempHome();
    const claude = installClaude(home);
    const { spawn, spawned } = createFakeSpawn();
    // Everything it puts out: the terminal echo, each state the page reads,
    // and anything on the console.
    const output: string[] = [];
    const record = (line: string) => output.splice(output.length, 0, line);
    const consoleSpies = (['log', 'info', 'warn', 'error'] as const).map(
      (method) =>
        jest
          .spyOn(console, method)
          .mockImplementation((...args: unknown[]) =>
            record(args.map(String).join(' '))
          )
    );
    const connector = createClaudeConnector({
      spawn,
      home,
      env,
      now: () => Date.UTC(2026, 9, 19, 12),
      echo: record,
      onChange: () => record(JSON.stringify(connector.state())),
    });

    expect(connector.start()).toBe('started');

    const [pty] = spawned;
    expect(pty?.file).toBe(claude);
    expect(pty?.args).toEqual(['setup-token']);
    expect(pty?.cols).toBe(PTY_COLUMNS);

    const half = FAKE_TOKEN.length / 2;
    pty?.emit(
      `${ESC}[2K${ESC}[1mYour token:${ESC}[0m ${FAKE_TOKEN.slice(0, half)}`
    );
    pty?.emit(`${FAKE_TOKEN.slice(half)}${ESC}[0m\r\n`);
    pty?.exit(0);

    expect(await connector.finished()).toEqual({
      phase: 'done',
      expiresOn: '2027-10-19T12:00:00.000Z',
    });
    expect(loadMachineConfig(env)?.tokens?.claude).toEqual({
      value: FAKE_TOKEN,
      createdAt: '2026-10-19T12:00:00.000Z',
    });
    expect(loadMachineConfig(env)?.firstRun?.claude).toBe(true);
    expect(fs.statSync(machineConfigPath(env)).mode & 0o777).toBe(0o600);
    consoleSpies.forEach((spy) => spy.mockRestore());

    const shown = output.join('\n');
    expect(shown).toContain('(saved)');
    // Not the token, and neither half of it from either read.
    expect(shown).not.toContain(FAKE_TOKEN.slice(0, half));
    expect(shown).not.toContain(FAKE_TOKEN.slice(half));
  });

  it('saves nothing when setup-token exits without a token', async () => {
    const { home, env } = tempHome();
    installClaude(home);
    const { spawn, spawned } = createFakeSpawn();
    const connector = createClaudeConnector({ spawn, home, env });

    connector.start();
    spawned[0]?.emit('Opening your browser…\r\n');
    spawned[0]?.exit(1);

    expect(await connector.finished()).toMatchObject({
      phase: 'failed',
      step: 'sign-in',
    });
    expect(loadMachineConfig(env)).toBeNull();
  });

  it('sends the sign-in link and the paste prompt to the page, and the code to the pty', () => {
    const { home, env } = tempHome();
    installClaude(home);
    const { spawn, spawned } = createFakeSpawn();
    const connector = createClaudeConnector({ spawn, home, env });

    connector.start();
    spawned[0]?.emit(
      `Browser didn't open? Use the url below to sign in:\r\n${ESC}[4mhttps://claude.ai/oauth/authorize?code=true&state=abc${ESC}[0m\r\n`
    );

    expect(connector.state()).toEqual({
      phase: 'signing-in',
      url: 'https://claude.ai/oauth/authorize?code=true&state=abc',
      needsCode: false,
    });

    spawned[0]?.emit('Paste code here if prompted > ');

    expect(connector.state()).toMatchObject({ needsCode: true });
    expect(connector.sendCode(' pawnee-code#123 ')).toBe(true);
    expect(spawned[0]?.written).toEqual(['pawnee-code#123\r']);
    expect(connector.sendCode('again')).toBe(false);
  });

  it('keeps the code box closed while the pasted code echoes, and reopens it on a new prompt', () => {
    const { home, env } = tempHome();
    installClaude(home);
    const { spawn, spawned } = createFakeSpawn();
    const connector = createClaudeConnector({ spawn, home, env });

    connector.start();
    spawned[0]?.emit('Paste code here if prompted > ');
    expect(connector.sendCode('pawnee-code')).toBe(true);

    spawned[0]?.emit('pawnee-code\r\nVerifying…\r\n');

    expect(connector.state()).toMatchObject({ needsCode: false });
    expect(connector.sendCode('pawnee-code')).toBe(false);

    spawned[0]?.emit('Invalid code. Paste code here if prompted > ');

    expect(connector.state()).toMatchObject({ needsCode: true });
  });

  it("runs Anthropic's installer when claude isn't found, showing its percentage", async () => {
    const { home, env } = tempHome();
    const { spawn, spawned } = createFakeSpawn();
    const connector = createClaudeConnector({ spawn, home, env });

    connector.start();

    expect(spawned[0]?.file).toBe('/bin/bash');
    expect(spawned[0]?.args).toEqual(['-c', INSTALLER_COMMAND]);

    spawned[0]?.emit('Downloading Claude Code…\r  52%');

    expect(connector.state()).toEqual({
      phase: 'installing',
      percent: 52,
      line: '52%',
    });

    installClaude(home);
    spawned[0]?.exit(0);

    expect(spawned[1]?.args).toEqual(['setup-token']);
    expect(spawned[1]?.file).toBe(path.join(home, '.local', 'bin', 'claude'));
  });

  it("tells the pages about the installer's output only when what they show changes", () => {
    const { home, env } = tempHome();
    const { spawn, spawned } = createFakeSpawn();
    const onChange = jest.fn();
    const connector = createClaudeConnector({ spawn, home, env, onChange });

    connector.start();
    const atStart = onChange.mock.calls.length;
    spawned[0]?.emit('Downloading Claude Code…\r  52%');
    spawned[0]?.emit('\r  52%');
    spawned[0]?.emit('\r  52%');
    spawned[0]?.emit('\r  53%');

    expect(connector.state()).toMatchObject({ percent: 53, line: '53%' });
    expect(onChange.mock.calls.length - atStart).toBe(2);
  });

  it('shows the last 20 lines when the installer fails, and saves nothing', async () => {
    const { home, env } = tempHome();
    const { spawn, spawned } = createFakeSpawn();
    const connector = createClaudeConnector({ spawn, home, env });

    connector.start();
    spawned[0]?.emit(
      Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\r\n')
    );
    spawned[0]?.exit(1);

    const state = await connector.finished();

    expect(state).toMatchObject({ phase: 'failed', step: 'install' });
    expect(state.phase === 'failed' ? state.lines : []).toEqual(
      Array.from({ length: FAILED_LINES }, (_, index) => `line ${index + 11}`)
    );
    expect(loadMachineConfig(env)).toBeNull();
    expect(spawned).toHaveLength(1);
  });

  it('never spawns the installer when claude is at ~/.local/bin/claude', () => {
    const { home, env } = tempHome();
    installClaude(home);
    const { spawn, spawned } = createFakeSpawn();

    createClaudeConnector({ spawn, home, env }).start();

    expect(spawned.map((pty) => pty.file)).toEqual([
      path.join(home, '.local', 'bin', 'claude'),
    ]);
  });

  it('fails the step, not the mothership, when the token cannot be saved, and lets a retry run', async () => {
    const { home, env } = tempHome();
    installClaude(home);
    const { spawn, spawned } = createFakeSpawn();
    const connector = createClaudeConnector({
      spawn,
      home,
      env,
      save: () => {
        throw new Error(`EACCES: permission denied, open '${home}/config'`);
      },
    });

    connector.start();
    spawned[0]?.emit(`${FAKE_TOKEN}\r\n`);

    expect(() => spawned[0]?.exit(0)).not.toThrow();
    expect(await connector.finished()).toEqual({
      phase: 'failed',
      step: 'sign-in',
      message:
        "Claude signed in, but Lambda couldn't save it. Nothing was saved.",
      lines: [],
    });
    expect(connector.start()).toBe('started');
  });

  it('runs one at a time', () => {
    const { home, env } = tempHome();
    installClaude(home);
    const { spawn, spawned } = createFakeSpawn();
    const connector = createClaudeConnector({ spawn, home, env });

    expect(connector.start()).toBe('started');
    expect(connector.start()).toBe('busy');
    expect(spawned).toHaveLength(1);
  });

  it('fails the step, not the mothership, when the pty cannot start, and lets a retry run', async () => {
    const { home, env } = tempHome();
    installClaude(home);
    const connector = createClaudeConnector({
      spawn: () => {
        throw new Error("Cannot find module '@lydell/node-pty'");
      },
      home,
      env,
    });

    expect(connector.start()).toBe('started');
    expect(await connector.finished()).toMatchObject({
      phase: 'failed',
      step: 'sign-in',
    });
    expect(connector.start()).toBe('started');
  });

  it('fails the step when setup-token cannot start after a good install', async () => {
    const { home, env } = tempHome();
    const fake = createFakeSpawn();
    const connector = createClaudeConnector({
      spawn: (file, args, options) => {
        if (args[0] === 'setup-token') {
          throw new Error('posix_spawnp failed.');
        }

        return fake.spawn(file, args, options);
      },
      home,
      env,
    });

    connector.start();
    installClaude(home);

    expect(() => fake.spawned[0]?.exit(0)).not.toThrow();
    expect(connector.state()).toMatchObject({
      phase: 'failed',
      step: 'sign-in',
    });
  });

  it('gives up on a sign-in nobody finishes, killing setup-token and offering Reconnect', async () => {
    jest.useFakeTimers();

    try {
      const { home, env } = tempHome();
      installClaude(home);
      const { spawn, spawned } = createFakeSpawn();
      const killed: string[] = [];
      const connector = createClaudeConnector({
        spawn: (file, args, options) => {
          const pty = spawn(file, args, options);

          return { ...pty, kill: () => killed.splice(0, 0, file) };
        },
        home,
        env,
        signInTimeoutMs: 60_000,
      });

      connector.start();
      jest.advanceTimersByTime(59_999);
      expect(connector.state()).toMatchObject({ phase: 'signing-in' });

      jest.advanceTimersByTime(1);
      expect(killed).toHaveLength(1);
      expect(connector.state()).toMatchObject({
        phase: 'failed',
        step: 'sign-in',
      });

      // The killed pty's own exit arrives later and changes nothing.
      spawned[0]?.exit(1);
      expect(connector.start()).toBe('started');
    } finally {
      jest.useRealTimers();
    }
  });

  it('gives up on an installer that stalls, killing it so a retry can run', () => {
    jest.useFakeTimers();

    try {
      const { home, env } = tempHome();
      const { spawn, spawned } = createFakeSpawn();
      const killed: string[] = [];
      const connector = createClaudeConnector({
        spawn: (file, args, options) => {
          const pty = spawn(file, args, options);

          return { ...pty, kill: () => killed.splice(0, 0, file) };
        },
        home,
        env,
      });

      connector.start();
      spawned[0]?.emit('Downloading Claude Code…\r  12%');
      jest.advanceTimersByTime(INSTALL_TIMEOUT_MS - 1);
      expect(connector.state()).toMatchObject({ phase: 'installing' });

      jest.advanceTimersByTime(1);
      expect(killed).toEqual(['/bin/bash']);
      expect(connector.state()).toMatchObject({
        phase: 'failed',
        step: 'install',
        lines: ['Downloading Claude Code…', '12%'],
      });

      // The killed installer's own exit arrives later and changes nothing.
      installClaude(home);
      spawned[0]?.exit(0);
      expect(spawned).toHaveLength(1);
      expect(connector.start()).toBe('started');
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a token it already read when the sign-in times out before setup-token exits', async () => {
    jest.useFakeTimers();

    try {
      const { home, env } = tempHome();
      installClaude(home);
      const { spawn, spawned } = createFakeSpawn();
      const saved: string[] = [];
      const connector = createClaudeConnector({
        spawn,
        home,
        env,
        now: () => Date.UTC(2026, 9, 19, 12),
        save: (token) => saved.splice(saved.length, 0, token),
        signInTimeoutMs: 60_000,
      });

      connector.start();
      spawned[0]?.emit(`${FAKE_TOKEN}\r\n`);
      jest.advanceTimersByTime(60_000);

      expect(saved).toEqual([FAKE_TOKEN]);
      expect(connector.state()).toMatchObject({ phase: 'done' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('takes a pasted code only as printable characters, never keystrokes', () => {
    expect(ClaudeCodeBody.safeParse({ code: ' pawnee-123 ' }).success).toBe(
      true
    );
    expect(ClaudeCodeBody.safeParse({ code: 'abc\u0003' }).success).toBe(false);
    expect(ClaudeCodeBody.safeParse({ code: 'ab\rcd' }).success).toBe(false);
    expect(ClaudeCodeBody.safeParse({ code: 'ab cd' }).success).toBe(false);
  });

  it('keeps the token out of every spawn, every state and the echo', async () => {
    const { home, env } = tempHome();
    installClaude(home);
    const { spawn, spawned } = createFakeSpawn();
    const echoed: string[] = [];
    const states: string[] = [];
    const connector = createClaudeConnector({
      spawn,
      home,
      env,
      echo: (data) => echoed.splice(echoed.length, 0, data),
      onChange: () =>
        states.splice(states.length, 0, JSON.stringify(connector.state())),
    });

    connector.start();
    spawned[0]?.emit(`https://claude.ai/oauth/x\r\n${FAKE_TOKEN}\r\n`);
    spawned[0]?.exit(0);
    await connector.finished();

    expect(
      spawned.flatMap((pty) => [pty.file, ...pty.args]).join(' ')
    ).not.toContain(FAKE_TOKEN);
    expect(states.join('\n')).not.toContain(FAKE_TOKEN);
    expect(echoed.join('')).not.toContain(FAKE_TOKEN);
    expect(states.join('\n')).not.toContain('oat01');
  });

  it('reads a token only in its own shape', () => {
    expect(findToken(`x ${FAKE_TOKEN} y`)).toBe(FAKE_TOKEN);
    expect(findToken('no token here')).toBeNull();
  });
});
