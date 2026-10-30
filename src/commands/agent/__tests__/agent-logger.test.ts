import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { detectAgent, extractTicketId, logCommand } from '../agent-logger';

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Leslie Knope',
  GIT_AUTHOR_EMAIL: 'leslie@pawnee.gov',
  GIT_COMMITTER_NAME: 'Leslie Knope',
  GIT_COMMITTER_EMAIL: 'leslie@pawnee.gov',
};

const git = (cwd: string, args: string[]): void => {
  execFileSync('git', args, { cwd, env: gitEnv, stdio: 'ignore' });
};

const tmpRepo = (branch: string): string => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-agent-log-'))
  );
  fs.writeFileSync(path.join(root, 'lambda.json'), '{}');
  git(root, ['init', '-q', '-b', branch]);
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'Pawnee']);

  return root;
};

describe('agent logger', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('reads any ticket id from the branch', () => {
    expect(extractTicketId(tmpRepo('PAWNEE-12-budget'))).toBe('PAWNEE-12');
    expect(extractTicketId(tmpRepo('main'))).toBeUndefined();
  });

  it("appends to the codebase's .lambda/agent-log.jsonl", () => {
    const root = tmpRepo('main');

    logCommand(
      { agent: 'dev', cmd: 'lambda tmux', args: ['dev'], outcome: 'success' },
      root
    );

    const lines = fs
      .readFileSync(path.join(root, '.lambda', 'agent-log.jsonl'), 'utf8')
      .trim()
      .split('\n');

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      agent: 'dev',
      cmd: 'lambda tmux',
    });
  });

  it('logs nothing outside a project', () => {
    const outside = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-agent-log-'))
    );

    logCommand(
      { agent: 'dev', cmd: 'lambda tmux', args: ['dev'], outcome: 'success' },
      outside
    );

    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('names the agent from LAMBDA_WINDOW', () => {
    delete process.env.TMUX_PANE;
    process.env.LAMBDA_WINDOW = 'lambda:dev';

    expect(detectAgent()).toBe('dev');
  });
});
