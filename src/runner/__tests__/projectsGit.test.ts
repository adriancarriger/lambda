import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { tempHome } from '../../mothership/__tests__/harness';
import { refreshBase } from '../../pod/base';
import { addProject, newProject } from '../projectsSetup';

/**
 * A project's pods are worktrees at its HEAD (`refreshBase`), so a folder
 * Lambda sets up must have a commit, not just `git init`.
 */
describe('the git a set-up project starts with', () => {
  const homes: string[] = [];
  const home = (): string => {
    const made = tempHome();
    homes.splice(homes.length, 0, made);

    return made;
  };
  const env = (at: string) => ({
    ...process.env,
    LAMBDA_HOME: path.join(at, '.lambda'),
  });
  const git = (cwd: string, args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  afterEach(() => {
    homes
      .splice(0)
      .forEach((made) => fs.rmSync(made, { recursive: true, force: true }));
  });

  it('gives a new project a first commit that pods can start from', () => {
    const at = home();
    const { folder } = newProject({ name: 'Sweetums recipe app', home: at });

    expect(refreshBase(folder, {}, at)).toMatch(/^[0-9a-f]{40}$/);
    expect(git(folder, ['ls-files'])).toContain('lambda.json');
    expect(git(folder, ['status', '--porcelain'])).toBe('');
  });

  it('gives a plain folder added as a project a first commit of only what Lambda wrote', () => {
    const at = home();
    const folder = path.join(at, 'pawnee-parks');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, '.env'), 'PARKS_BUDGET_KEY=jerry\n');
    fs.writeFileSync(path.join(folder, 'secret.txt'), 'Li’l Sebastian\n');

    addProject({
      typed: folder,
      known: [],
      computer: "Leslie's MacBook",
      home: at,
      env: env(at),
    });

    expect(refreshBase(folder, {}, at)).toMatch(/^[0-9a-f]{40}$/);
    expect(git(folder, ['ls-files']).split('\n').sort()).toEqual([
      '.lambda/.gitignore',
      'lambda.json',
    ]);
  });

  it('leaves a folder inside an existing repository alone', () => {
    const at = home();
    const repo = path.join(at, 'pawnee');
    const inside = path.join(repo, 'parks');
    fs.mkdirSync(inside, { recursive: true });
    git(repo, ['init', '--quiet']);

    addProject({
      typed: inside,
      known: [],
      computer: "Leslie's MacBook",
      home: at,
      env: env(at),
    });

    expect(fs.existsSync(path.join(inside, '.git'))).toBe(false);
  });

  it("doesn't commit in a repository that was already there", () => {
    const at = home();
    const folder = path.join(at, 'eagleton');
    fs.mkdirSync(folder);
    git(folder, ['init', '--quiet']);

    addProject({
      typed: folder,
      known: [],
      computer: "Leslie's MacBook",
      home: at,
      env: env(at),
    });

    expect(() => git(folder, ['rev-parse', '--verify', 'HEAD'])).toThrow();
  });
});
