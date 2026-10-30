import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  claudeProjectsDir,
  hasConversation,
  startKind,
} from '../claudeSessions';

const projects = (): string => {
  const dir = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-sessions-')),
    'projects'
  );
  fs.mkdirSync(path.join(dir, '-Users-leslie-pawnee-parks'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(dir, '-Users-leslie-pawnee-parks', 'b3c1f0e2.jsonl'),
    '{}\n'
  );

  return dir;
};

describe("an agent's conversation", () => {
  it('is found by its id in any project folder', () => {
    const dir = projects();

    expect(hasConversation('b3c1f0e2', dir)).toBe(true);
    expect(hasConversation('9d8e7f60', dir)).toBe(false);
    expect(hasConversation('b3c1f0e2', path.join(dir, 'none'))).toBe(false);
  });

  it('is resumed only when it exists; otherwise started fresh', () => {
    const dir = projects();

    expect(startKind('resume', 'b3c1f0e2', dir)).toBe('resume');
    expect(startKind('resume', '9d8e7f60', dir)).toBe('fresh');
    expect(startKind('fresh', 'b3c1f0e2', dir)).toBe('fresh');
  });

  it("lives under Claude Code's config folder when one is set", () => {
    expect(
      claudeProjectsDir({ CLAUDE_CONFIG_DIR: '/cfg' }, '/home/leslie')
    ).toBe('/cfg/projects');
    expect(claudeProjectsDir({}, '/home/leslie')).toBe(
      '/home/leslie/.claude/projects'
    );
  });
});
