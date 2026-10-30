import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { registerPlanningCommand } from '..';
import { STEP_IDS, WORKFLOW } from '../../../pod-store/workflow';
import { BUILDING_STEPS } from '../../../process/building';
import { registerBuildingCommand } from '../../building';

const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-process-cmd-'))
);
const pawnee = () => ({ root, title: 'Pawnee Parks app' });

/** Run `lambda <args>` in process and return what it printed. */
const run = async (args: string[]): Promise<string[]> => {
  const program = new Command().exitOverride();
  registerPlanningCommand(program, pawnee);
  registerBuildingCommand(program, pawnee);
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

  try {
    await program.parseAsync(['node', 'lambda', ...args]);

    return log.mock.calls
      .map((call) => String(call[0]))
      .join('\n')
      .split('\n');
  } finally {
    log.mockRestore();
  }
};

const ids = (lines: string[]): string[] =>
  lines
    .filter((line) => line.startsWith('  '))
    .map((line) => line.trim().split(/\s+/)[0] ?? '');

describe('lambda planning steps / building steps', () => {
  it('lists every planning step and stage id', async () => {
    const listed = ids(await run(['planning', 'steps']));

    expect(STEP_IDS.filter((id) => !listed.includes(id))).toEqual([]);
    expect(
      Array.from(new Set(WORKFLOW.map((stage) => stage.id))).filter(
        (id) => !listed.includes(id)
      )
    ).toEqual([]);
  });

  it('lists every building step and its stage', async () => {
    const listed = ids(await run(['building', 'steps']));

    expect(listed).toEqual([
      ...BUILDING_STEPS.map((step) => step.id),
      'building',
    ]);
  });
});

describe('lambda planning show / building show', () => {
  it('shows the idea track by default', async () => {
    const lines = await run(['planning', 'show']);

    expect(lines[0]).toBe('Pawnee Parks app · planning · track: idea');
    expect(lines).toContainEqual(expect.stringMatching(/^ cp1\s+locked$/));
    expect(lines[1]).toBe(' shape');
    expect(lines[2]).toBe('  1  intent');
  });

  it('shows another track when asked', async () => {
    const lines = await run(['planning', 'show', '--track', 'batch']);

    expect(lines[0]).toBe('Pawnee Parks app · planning · track: batch');
    expect(lines).toContainEqual(expect.stringMatching(/^ triage$/));
  });

  it('shows pick-up to ship, with check-ticket and ship locked, visual-check optional, your review optional and off, and design-check required before ship', async () => {
    expect(await run(['building', 'show'])).toEqual([
      'Pawnee Parks app · building',
      ' building',
      '  1  pick-up',
      '  2  build',
      '  3  self-review',
      expect.stringMatching(/^ {2}4 {2}check-ticket\s+locked$/),
      expect.stringMatching(/^ {2}5 {2}visual-check\s+optional$/),
      '  6  test',
      expect.stringMatching(/^ {2}7 {2}review\s+optional · off$/),
      expect.stringMatching(/^ {2}8 {2}design-check\s+required$/),
      expect.stringMatching(/^ {2}9 {2}ship\s+locked$/),
    ]);
  });
});
