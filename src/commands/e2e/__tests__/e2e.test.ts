import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { run } from '../../../cli';
import {
  NO_PLAYWRIGHT_CONFIG,
  fillCommandTemplate,
  findPlaywrightDir,
  playwrightArgs,
  searchStop,
} from '../index';

const tmp = (): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-e2e-')));

describe('playwright argv', () => {
  it('keeps a trace of failures by default', () => {
    expect(playwrightArgs(['tests/a.spec.ts'])).toEqual([
      'playwright',
      'test',
      'tests/a.spec.ts',
      '--trace',
      'retain-on-failure',
    ]);
  });

  it("leaves the caller's own trace mode alone", () => {
    expect(playwrightArgs(['--trace', 'on'])).toEqual([
      'playwright',
      'test',
      '--trace',
      'on',
    ]);
    expect(playwrightArgs(['--trace=off'])).toEqual([
      'playwright',
      'test',
      '--trace=off',
    ]);
  });
});

describe('commands.e2e template', () => {
  it('puts the quoted args in {spec}', () => {
    expect(fillCommandTemplate('pnpm test:e2e {spec}', ["it's.spec.ts"])).toBe(
      "pnpm test:e2e 'it'\\''s.spec.ts'"
    );
  });

  it('leaves {spec} empty with no args', () => {
    expect(fillCommandTemplate('pnpm test:e2e {spec}', [])).toBe(
      'pnpm test:e2e '
    );
  });

  it('appends the args when there is no {spec}', () => {
    expect(fillCommandTemplate('pnpm test:e2e', ['a.spec.ts'])).toBe(
      "pnpm test:e2e 'a.spec.ts'"
    );
  });
});

describe('finding the Playwright config', () => {
  it('uses a config in a parent folder', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'playwright.config.ts'), '');
    const sub = path.join(root, 'tests', 'parks');
    fs.mkdirSync(sub, { recursive: true });

    expect(findPlaywrightDir(sub, root)).toBe(root);
  });

  it('never uses one above the project root', () => {
    const outside = tmp();
    fs.writeFileSync(path.join(outside, 'playwright.config.ts'), '');
    const root = path.join(outside, 'pawnee');
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });

    expect(findPlaywrightDir(path.join(root, 'tests'), root)).toBeUndefined();
  });

  it("in a linked worktree, uses the worktree's config and nothing above it", () => {
    const tmpRoot = tmp();
    const main = path.join(tmpRoot, 'main');
    const worktree = path.join(tmpRoot, 'pod-worktree');
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
    fs.mkdirSync(path.join(main, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(main, 'lambda.json'), '{}');
    fs.writeFileSync(path.join(main, 'playwright.config.ts'), '');
    fs.writeFileSync(path.join(main, 'tests', 'parks.spec.ts'), '');
    git(main, ['init', '-q']);
    git(main, ['add', '.']);
    git(main, ['commit', '-q', '-m', 'Pawnee']);
    git(main, ['worktree', 'add', '-q', '--detach', worktree]);
    fs.writeFileSync(path.join(tmpRoot, 'playwright.config.ts'), '');
    const tests = path.join(worktree, 'tests');

    expect(searchStop(tests, main)).toBe(worktree);
    expect(findPlaywrightDir(tests, searchStop(tests, main))).toBe(worktree);

    fs.rmSync(path.join(worktree, 'playwright.config.ts'));

    expect(findPlaywrightDir(tests, searchStop(tests, main))).toBeUndefined();
  });

  it('stops at the project root outside a worktree', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'tests'));

    expect(searchStop(path.join(root, 'tests'), root)).toBe(root);
    expect(searchStop(root, root)).toBe(root);
  });

  it('explains how to set one when there is none', () => {
    expect(NO_PLAYWRIGHT_CONFIG).toBe(
      'No Playwright config found. Set commands.e2e in lambda.json.'
    );
  });
});

describe('lambda e2e with no Playwright config and no override', () => {
  const savedCwd = process.cwd();
  const savedHome = process.env.LAMBDA_HOME;
  const errors: string[] = [];

  beforeEach(() => {
    errors.length = 0;
    jest.spyOn(console, 'error').mockImplementation((line: string) => {
      errors.splice(errors.length, 0, line);
    });
  });

  afterEach(() => {
    process.chdir(savedCwd);
    process.env.LAMBDA_HOME = savedHome;
    process.exitCode = undefined;
    jest.restoreAllMocks();
  });

  it('exits 1 and says how to set one on stderr', async () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'lambda.json'), '{}');
    fs.mkdirSync(path.join(root, 'tests'));
    process.env.LAMBDA_HOME = tmp();
    process.chdir(path.join(root, 'tests'));

    expect(await run(['node', 'lambda', 'e2e', 'budget.spec.ts'])).toBe(1);
    expect(errors).toEqual([
      'No Playwright config found. Set commands.e2e in lambda.json.',
    ]);
  });
});
