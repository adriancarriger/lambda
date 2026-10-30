import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { NOT_CONNECTED, runClaudeToken } from '../../commands/internal';
import { lambdaBin } from '../../lambdaBin';
import { createPodStore } from '../../pod-store';
import { FAKE_TOKEN } from '../../setup/__tests__/fakePty';
import { agentCommandLine, claudeTokenShell, oneShotLaunch } from '../launch';
import { shellQuote } from '../tmux';
import { LAMBDA_HOME } from './podProject';

const POD = 'pawnee-c3d4';

const writeToken = (value: string | undefined) =>
  fs.writeFileSync(
    path.join(LAMBDA_HOME, 'config.json'),
    `${JSON.stringify(
      value === undefined
        ? {}
        : {
            tokens: {
              claude: { value, createdAt: '2026-10-19T12:00:00.000Z' },
            },
          }
    )}\n`,
    { mode: 0o600 }
  );

const podsRootEnv: { saved?: string; roots: string[] } = { roots: [] };

beforeEach(() => {
  podsRootEnv.saved = process.env.LAMBDA_PODS_ROOT;
});

afterEach(() => {
  if (podsRootEnv.saved === undefined) {
    delete process.env.LAMBDA_PODS_ROOT;
  } else {
    process.env.LAMBDA_PODS_ROOT = podsRootEnv.saved;
  }

  podsRootEnv.roots.forEach((root) =>
    fs.rmSync(root, { recursive: true, force: true })
  );
  podsRootEnv.roots = [];
});

const podLine = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pods-'));
  podsRootEnv.roots = [...podsRootEnv.roots, root];
  process.env.LAMBDA_PODS_ROOT = root;
  const store = createPodStore(root);
  store.writePod({
    id: POD,
    slug: 'pawnee',
    createdAt: '2026-10-19T00:00:00.000Z',
    status: 'active',
    phase: 1,
    completedCheckpoints: [],
    worktreePath: '/tmp/pawnee',
    ownsWorktree: false,
    managerCwd: '/tmp/pawnee',
    devCwd: '/tmp/pawnee',
    agentCommand: 'claude',
    sessions: { manager: 'm', dev: 'd' },
  });

  return agentCommandLine(store.requirePod(POD), store, 'dev', {
    kind: 'fresh',
    sessionId: 'd',
  });
};

describe("an agent's Claude token", () => {
  afterEach(() => writeToken(undefined));

  it('reaches the agent through its own shell, never in the command string', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-claude-bin-'));
    const claude = path.join(home, '.local', 'bin', 'claude');
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.writeFileSync(claude, '#!/bin/sh\n');
    fs.chmodSync(claude, 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${path.dirname(claude)}:/usr/bin:/bin`;
    writeToken(FAKE_TOKEN);

    try {
      const line = podLine();

      const token = claudeTokenShell();
      expect(line.startsWith(`${token.read} env `)).toBe(true);
      // Inherited from that shell, never an argument to env (`ps` shows it).
      expect(line.slice(token.read.length)).not.toContain(
        'CLAUDE_CODE_OAUTH_TOKEN='
      );
      expect(token.read).toContain(
        `${shellQuote(process.execPath)} ${shellQuote(
          lambdaBin()
        )} internal claude-token`
      );
      expect(line).toContain(`'${claude}' --session-id d`);
      expect(line).not.toContain(FAKE_TOKEN);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('leaves the launch as it was when Claude is not connected', () => {
    writeToken(undefined);

    const line = podLine();

    expect(line).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(line).toMatch(/ claude --session-id d /);
  });
});

/** The token lines run in a POSIX shell with no `lambda` on its PATH. */
describe("an agent's shell reading the Claude token", () => {
  const bin: { dir?: string } = {};

  afterEach(() => {
    if (bin.dir !== undefined) {
      fs.rmSync(bin.dir, { recursive: true, force: true });
    }
  });

  const runToken = (script: string) => {
    bin.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-token-cli-'));
    const cli = path.join(bin.dir, 'cli.js');
    fs.writeFileSync(cli, script);
    const token = claudeTokenShell([
      shellQuote(process.execPath),
      shellQuote(cli),
    ]);

    // An `env` that records its arguments, as `ps` would show them.
    const envArgs = path.join(bin.dir, 'env-args');
    fs.writeFileSync(
      path.join(bin.dir, 'env'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${envArgs}'\nexec /usr/bin/env "$@"\n`,
      { mode: 0o755 }
    );
    const ran = spawnSync(
      '/bin/sh',
      ['-c', `${token.read} env /usr/bin/printenv CLAUDE_CODE_OAUTH_TOKEN`],
      {
        env: { PATH: `${bin.dir}:/usr/bin:/bin` },
        encoding: 'utf8',
        timeout: 10_000,
      }
    );

    return {
      ...ran,
      envArgs: fs.existsSync(envArgs) ? fs.readFileSync(envArgs, 'utf8') : '',
    };
  };

  it('runs the lambda it was launched from, not one on PATH', () => {
    const ran = runToken("process.stdout.write('ron-swanson-token');\n");

    expect(ran.stdout.trim()).toBe('ron-swanson-token');
    expect(ran.status).toBe(0);
  });

  it("hands the token to env's environment, never its arguments", () => {
    const ran = runToken("process.stdout.write('ron-swanson-token');\n");

    expect(ran.stdout.trim()).toBe('ron-swanson-token');
    expect(ran.envArgs).not.toContain('ron-swanson-token');
  });

  it('stops the launch, saying why, when no token comes back', () => {
    const ran = runToken('process.exit(1);\n');

    expect(ran.status).not.toBe(0);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toContain('Claude token');
  });
});

describe("a one-shot run's Claude token (ticket summaries)", () => {
  afterEach(() => writeToken(undefined));

  it('runs the resolved claude with the token in its env, never its arguments', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-oneshot-bin-'));
    const claude = path.join(bin, 'claude');
    fs.writeFileSync(claude, '#!/bin/sh\n');
    fs.chmodSync(claude, 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    writeToken(FAKE_TOKEN);

    try {
      const launch = oneShotLaunch({
        prompt: 'Summarise PAWNEE-12',
        settingsFile: '/tmp/settings.json',
        env: { PATH: '/usr/bin:/bin', POD_ID: 'x' },
      });

      expect(launch.command).toBe(claude);
      expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(FAKE_TOKEN);
      expect(launch.env.POD_ID).toBeUndefined();
      expect(launch.args.join(' ')).not.toContain(FAKE_TOKEN);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('is a plain claude with no token when Claude is not connected', () => {
    writeToken(undefined);

    const launch = oneShotLaunch({
      prompt: 'Summarise PAWNEE-12',
      settingsFile: '/tmp/settings.json',
      env: {},
    });

    expect(launch.command).toBe('claude');
    expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

describe('lambda internal claude-token', () => {
  const run = (stdoutIsTTY: boolean) => {
    const written: string[] = [];
    const errors: string[] = [];
    const code = runClaudeToken({
      env: { LAMBDA_HOME },
      stdoutIsTTY,
      write: (text) => written.splice(written.length, 0, text),
      error: (line) => errors.splice(errors.length, 0, line),
    });

    return { code, written, errors };
  };

  afterEach(() => writeToken(undefined));

  it('prints the token with no newline when piped', () => {
    writeToken(FAKE_TOKEN);

    expect(run(false)).toEqual({ code: 0, written: [FAKE_TOKEN], errors: [] });
  });

  it('refuses a terminal, printing nothing', () => {
    writeToken(FAKE_TOKEN);

    expect(run(true)).toEqual({ code: 1, written: [], errors: [] });
  });

  it("says Claude isn't connected when there is no token", () => {
    writeToken(undefined);

    expect(run(false)).toEqual({
      code: 1,
      written: [],
      errors: [NOT_CONNECTED],
    });
  });
});
