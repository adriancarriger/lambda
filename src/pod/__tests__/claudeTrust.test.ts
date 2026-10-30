import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  claudeStateFile,
  trustFolderForClaude,
  trustRoot,
} from '../claudeTrust';

const tmp = (): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-trust-')));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    [
      '-c',
      'user.email=leslie@pawnee.gov',
      '-c',
      'user.name=Leslie Knope',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim();

/** A repo with a commit, and a worktree of it outside it (as pods have). */
const repoAndWorktree = (): { repo: string; worktree: string } => {
  const repo = path.join(tmp(), 'pawnee-parks');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'start');
  const worktree = path.join(tmp(), 'ice-town-1a2b');
  git(repo, 'worktree', 'add', '-q', '--detach', worktree);

  return { repo, worktree };
};

const read = (file: string): { projects: Record<string, unknown> } =>
  JSON.parse(fs.readFileSync(file, 'utf8'));

describe("marking a pod's folder trusted in Claude Code", () => {
  it("keys a worktree, and a folder inside it, on the main checkout's root", () => {
    const { repo, worktree } = repoAndWorktree();
    const manager = path.join(worktree, '.lambda', 'managers', 'ice-town-1a2b');
    fs.mkdirSync(manager, { recursive: true });

    expect(trustRoot(worktree)).toBe(repo);
    expect(trustRoot(manager)).toBe(repo);
  });

  it('keys a folder outside any repo on itself', () => {
    const folder = tmp();

    expect(trustRoot(folder)).toBe(folder);
  });

  it('marks it, keeping everything else in the file, and writes nothing when it already is', () => {
    const { repo, worktree } = repoAndWorktree();
    const file = path.join(tmp(), '.claude.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        numStartups: 7,
        projects: {
          '/elsewhere': { hasTrustDialogAccepted: true },
          [repo]: { allowedTools: ['Read'], hasTrustDialogAccepted: false },
        },
      }),
      { mode: 0o600 }
    );

    expect(trustFolderForClaude(worktree, file)).toBe(repo);
    expect(read(file)).toEqual({
      numStartups: 7,
      projects: {
        '/elsewhere': { hasTrustDialogAccepted: true },
        [repo]: { allowedTools: ['Read'], hasTrustDialogAccepted: true },
      },
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const before = fs.statSync(file).mtimeMs;
    fs.utimesSync(file, new Date(0), new Date(0));
    trustFolderForClaude(worktree, file);

    expect(fs.statSync(file).mtimeMs).toBe(0);
    expect(before).not.toBe(0);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['.claude.json']);
  });

  it('makes the file when Claude Code has none yet', () => {
    const folder = tmp();
    const file = path.join(tmp(), 'config', '.claude.json');

    trustFolderForClaude(folder, file);

    expect(read(file)).toEqual({
      projects: { [folder]: { hasTrustDialogAccepted: true } },
    });
  });

  it("never reaches the account's real ~/.claude.json from a test", () => {
    expect(() => claudeStateFile({}, os.userInfo().homedir)).toThrow(
      'real ~/.claude.json'
    );
    // Every test file gets a temp one through process.env.
    expect(claudeStateFile()).not.toBe(
      path.join(os.userInfo().homedir, '.claude.json')
    );
  });
});
