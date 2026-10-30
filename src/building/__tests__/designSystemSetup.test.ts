import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { SETUP_TICKET_TITLE } from '../../design/system/setupTicket';
import { usePodProject } from '../../pod/__tests__/podProject';
import {
  lambdaPackageDir,
  loadProcess,
  resolveInstructions,
} from '../../process/workflow-file';
import { pickedUpText } from '../driver';
import { writeBuildingInstructions } from '../lifecycle';

/**
 * The ticket that makes the design system, the first time: a building pod
 * knows it by its exact title and builds it with /design-system-setup
 * instead of /start.
 */

const OWN = path.join(
  lambdaPackageDir(),
  'instructions',
  'building',
  'design-system-setup.md'
);

const gitProject = (): string => {
  const root = usePodProject({ name: 'Pawnee parks map' });
  execFileSync('git', ['init', '-q'], { cwd: root });

  return root;
};

describe('the design-system-setup instructions', () => {
  it("are Lambda's, and a project's .lambda/building/design-system-setup.md comes first", () => {
    const root = gitProject();

    expect(fs.existsSync(OWN)).toBe(true);
    expect(resolveInstructions(root, 'building', 'design-system-setup')).toBe(
      OWN
    );

    fs.mkdirSync(path.join(root, '.lambda', 'building'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.lambda', 'building', 'design-system-setup.md'),
      '# Make the Pawnee design system\n'
    );

    expect(resolveInstructions(root, 'building', 'design-system-setup')).toBe(
      path.join(root, '.lambda', 'building', 'design-system-setup.md')
    );
    // The override replaces a known command, so loading isn't refused.
    expect(() => loadProcess(root, 'building')).not.toThrow();
  });

  it('spell out the six steps, the files, the loop and the one direction', () => {
    const text = fs.readFileSync(OWN, 'utf8');

    [
      'lambda design system detect',
      'lambda design system build --check',
      'lambda design system round record',
      'lambda design system manifest write',
      'lambda design system install',
      'lambda design render',
      'lambda shot <id> --out $LAMBDA_PODS_ROOT/$POD_ID/design-system/photos/<id>.png',
      '.lambda/design/_system-check/canvas/',
      'round-<n>/<scenario id>.png',
      'sources.json',
      'sampleData.ts',
      'screens/',
      'Round 7 is the most.',
      "Never edit the app's code",
      '{severityFile}',
      "The photo is the real app. Grade how far the drawn picture's look (colours, fonts, spacing, corners, shadows, the shapes of controls) is from it. Different data or wording is not an issue; a missing or wrong control is.",
      'SYSTEM: MATCH',
      'SYSTEM: CLOSE',
      'SYSTEM: BLOCKED',
      'SYSTEM: ERROR',
      "After 7 rounds the design system still didn't match the app: <first high issue>.",
      'this project has no photo hook (commands.shot in lambda.json)',
      'there are no screenshot scenarios to photograph yet',
      'the photo hook failed for every screen (<its last output line>)',
      "Lambda can't make a design system for <project>: it found no theme or components in the code, and it has no photos of the app (<the photo reason>).",
      'lambda tickets comment',
      '--image',
    ].forEach((words) =>
      expect({ words, found: text.includes(words) }).toEqual({
        words,
        found: true,
      })
    );
    expect(text).toMatch(/never edit the app's code/i);
    expect(text).toMatch(/fresh judge subagent/);
    expect(text).toMatch(/commit nothing/i);
  });
});

describe('a building pod given the setup ticket', () => {
  it('points the Engineering manager at /design-system-setup for that exact title', () => {
    const text = pickedUpText(
      { id: 'PAWNEE-12', title: SETUP_TICKET_TITLE },
      { n: 1, m: 1 }
    );

    expect(text).toContain('/design-system-setup PAWNEE-12');
    expect(text).toContain('instead of `/start PAWNEE-12`');
  });

  it.each([
    'Bench rows show the park opening hours',
    'make the design system from the app',
    'Make the design system from the app again',
  ])('builds "%s" the usual way, with /start', (title) => {
    const text = pickedUpText({ id: 'PAWNEE-31', title }, { n: 1, m: 2 });

    expect(text).not.toContain('design-system-setup');
    expect(text).toContain('go on from Step 2 (Build)');
  });

  it("gives the dev the /design-system-setup command beside the steps' commands", () => {
    const root = gitProject();
    const managerCwd = path.join(root, '.lambda', 'managers', 'build-pawnee');
    fs.mkdirSync(managerCwd, { recursive: true });

    writeBuildingInstructions(
      { id: 'build-pawnee', devCwd: root, managerCwd },
      'Leslie Knope'
    );

    const commands = path.join(root, '.claude', 'commands');
    const setup = fs.readFileSync(
      path.join(commands, 'design-system-setup.md'),
      'utf8'
    );

    expect(setup).toContain('lambda design system detect');
    // The severity scale's full path is filled in, as for design-screen.
    expect(setup).not.toContain('{severityFile}');
    expect(setup).toContain(
      path.join(
        lambdaPackageDir(),
        'instructions',
        'design',
        'visual-severity.md'
      )
    );
    expect(fs.existsSync(path.join(commands, 'design-check.md'))).toBe(true);
    expect(
      fs.readFileSync(path.join(commands, '.gitignore'), 'utf8').split('\n')
    ).toEqual(
      expect.arrayContaining(['design-system-setup.md', 'design-check.md'])
    );
    expect(
      fs.readFileSync(path.join(managerCwd, 'CLAUDE.md'), 'utf8')
    ).toContain('/design-system-setup <id>');
  });
});
