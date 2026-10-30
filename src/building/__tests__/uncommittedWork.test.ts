import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { writeLambdaGitignore } from '../../commands/init';
import { uncommittedWork } from '../blocked';

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
  );

/**
 * A markdown project as setup and planning leave it: lambda.json committed,
 * `lambda init`'s `.lambda/.gitignore` never committed, and a planned
 * ticket's files written into the checkout.
 */
const plannedProject = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-work-'));
  fs.writeFileSync(
    path.join(root, 'lambda.json'),
    '{ "tickets": { "source": "markdown", "prefix": "PAWNEE" } }\n'
  );
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'Start');
  writeLambdaGitignore(root);
  fs.writeFileSync(
    path.join(root, 'TASKS.md'),
    '- [ ] PAWNEE-1: Add hello.txt\n'
  );
  fs.mkdirSync(path.join(root, 'tickets'));
  fs.writeFileSync(
    path.join(root, 'tickets', 'PAWNEE-1.md'),
    '# Add hello.txt\n'
  );

  return root;
};

describe("the checkout's uncommitted work, which holds a pick-up", () => {
  it("is none when all that's uncommitted is Lambda's own files and the tickets", () => {
    expect(uncommittedWork(plannedProject())).toEqual([]);
  });

  it('is still the person’s own changes', () => {
    const root = plannedProject();
    fs.writeFileSync(path.join(root, 'notes.txt'), 'Ice Town\n');

    expect(uncommittedWork(root)).toEqual(['?? notes.txt']);
  });
});
