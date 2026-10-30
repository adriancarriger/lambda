import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { writeCommandsIgnore } from '../../../pod/base';
import { processLines } from '../process';

/** A project with one `.claude/commands/<name>.md` for every name given. */
const project = (commands: string[]): string => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pawnee-doctor-'))
  );
  const dir = path.join(root, '.claude', 'commands');
  fs.mkdirSync(dir, { recursive: true });
  commands.forEach((name) =>
    fs.writeFileSync(path.join(dir, `${name}.md`), `# ${name}\n`)
  );

  return root;
};

const sourceOf = (root: string, label: string): string | undefined =>
  processLines(root)
    .find((line) => line.trim().startsWith(`${label} `))
    ?.trim()
    .slice(label.length)
    .trim();

describe("lambda doctor's instruction sources", () => {
  it("shows a project's own command as a project override", () => {
    const root = project(['ux-sketch']);

    expect(sourceOf(root, 'planning/ux-sketch')).toBe(
      'project override (.claude/commands/ux-sketch.md)'
    );
  });

  it('shows a copy Lambda wrote into the project as Lambda default, not an override', () => {
    const root = project(['ux-sketch']);
    writeCommandsIgnore(root, 'ice-town-1a2b', ['ux-sketch.md']);

    expect(sourceOf(root, 'planning/ux-sketch')).toBe('Lambda default');
  });
});
