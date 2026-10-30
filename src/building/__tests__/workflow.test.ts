import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildingStepIds, buildingSteps } from '../workflow';

const project = (workflow?: unknown): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pawnee-build-'));

  if (workflow !== undefined) {
    fs.mkdirSync(path.join(root, '.lambda', 'building'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.lambda', 'building', 'workflow.json'),
      JSON.stringify(workflow)
    );
    // An added step runs its own instructions.
    fs.writeFileSync(
      path.join(root, '.lambda', 'building', 'a11y-check.md'),
      '# Accessibility check\n'
    );
  }

  return root;
};

describe("a building pod's steps", () => {
  it('are the standard eight with no workflow.json, visual-check right after check-ticket and design-check right before ship', () => {
    expect(buildingStepIds(project())).toEqual([
      'pick-up',
      'build',
      'self-review',
      'check-ticket',
      'visual-check',
      'test',
      'design-check',
      'ship',
    ]);
  });

  it('can drop visual-check, or switch it off: it is optional', () => {
    const expected = [
      'pick-up',
      'build',
      'self-review',
      'check-ticket',
      'test',
      'a11y-check',
      'design-check',
      'ship',
    ];
    const a11y = {
      id: 'a11y-check',
      label: 'Accessibility check',
      run: '/a11y-check',
      after: 'test',
    };

    expect(
      buildingStepIds(
        project({ extends: 'standard', add: [a11y], drop: ['visual-check'] })
      )
    ).toEqual(expected);
    expect(
      buildingStepIds(
        project({ extends: 'standard', add: [a11y], off: ['visual-check'] })
      )
    ).toEqual(expected);
    expect(
      buildingSteps(project()).find((one) => one.id === 'visual-check')
    ).toMatchObject({ optional: true, command: 'visual-check', who: 'qa' });
  });

  it('run an added step in its declared place', () => {
    expect(
      buildingStepIds(
        project({
          extends: 'standard',
          add: [
            {
              id: 'a11y-check',
              label: 'Accessibility check',
              run: '/a11y-check',
              after: 'test',
            },
          ],
        })
      )
    ).toEqual([
      'pick-up',
      'build',
      'self-review',
      'check-ticket',
      'visual-check',
      'test',
      'a11y-check',
      'design-check',
      'ship',
    ]);
  });

  it("can't lose check-ticket or ship", () => {
    expect(() =>
      buildingStepIds(project({ extends: 'standard', drop: ['check-ticket'] }))
    ).toThrow(/check-ticket/);
    expect(() =>
      buildingStepIds(project({ extends: 'standard', drop: ['ship'] }))
    ).toThrow(/ship/);
  });

  it("can't lose design-check or move it away from right before ship", () => {
    expect(() =>
      buildingStepIds(project({ extends: 'standard', drop: ['design-check'] }))
    ).toThrow(/drop "design-check" refused/);
    expect(() =>
      buildingStepIds(
        project({
          extends: 'standard',
          move: [{ id: 'design-check', after: 'build' }],
        })
      )
    ).toThrow(/move "design-check" refused/);
  });
});

describe('the pick-up step', () => {
  it("is the runner's, claiming the ticket, not the Engineering manager's", () => {
    const pickUp = buildingSteps(project()).find((one) => one.id === 'pick-up');

    expect(pickUp?.who).toBe('app');
    expect(pickUp?.tip).toMatch(/runner/);
    expect(pickUp?.tip).toMatch(/claims/);
    expect(pickUp?.tip).not.toMatch(/manager takes/i);
  });
});
