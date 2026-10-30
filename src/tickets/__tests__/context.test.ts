import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runnerOf } from '../context';

const repoWithEmail = (email: string): string => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-runner-'))
  );
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', email], { cwd: root });

  return root;
};

describe('runnerOf — who create records as reporter', () => {
  it('is owner.name, with git config user.email as the email', () => {
    expect(
      runnerOf(
        { owner: { name: 'Leslie Knope' } },
        repoWithEmail('leslie@pawnee.gov')
      )
    ).toEqual({ name: 'Leslie Knope', email: 'leslie@pawnee.gov' });
  });

  it('is nobody without owner.name', () => {
    expect(runnerOf({}, repoWithEmail('leslie@pawnee.gov'))).toBeNull();
    expect(runnerOf(null, repoWithEmail('leslie@pawnee.gov'))).toBeNull();
  });
});
