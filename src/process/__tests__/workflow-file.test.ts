import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  type ProcessName,
  type ResolvedProcess,
  fillRun,
  formatProcess,
  lambdaPackageDir,
  loadProcess,
  readWorkflowFile,
  resolveInstructions,
  resolveStepInstructions,
  setStepOff,
  withAddendum,
} from '../workflow-file';

const tmp = (): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-process-')));

const write = (root: string, file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};

/**
 * A project with a workflow.json and, when the workflow runs it, the custom
 * command (an override file that matches nothing is refused).
 */
const project = (
  workflow: object | null,
  options: { name?: ProcessName; files?: Record<string, string> } = {}
): string => {
  const root = tmp();
  const name = options.name ?? 'planning';

  if (JSON.stringify(workflow ?? {}).includes('/my-custom-command')) {
    write(root, `.lambda/${name}/my-custom-command.md`, 'Check it.\n');
  }

  if (workflow !== null) {
    write(root, `.lambda/${name}/workflow.json`, JSON.stringify(workflow));
  }

  Object.entries(options.files ?? {}).forEach(([file, text]) =>
    write(root, file, text)
  );

  return root;
};

const refusal = (load: () => unknown): string => {
  try {
    load();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error('Expected a refusal');
};

/** Lambda's own copy of an instruction file. */
const own = (name: ProcessName, file: string): string =>
  path.join(lambdaPackageDir(), 'instructions', name, file);

const ROLE = "it holds the instructions of Lambda's quality steps.";
const addInstead = (name: ProcessName, role: string): string =>
  `Add to them with .lambda/${name}/${role}.add.md instead.`;

const stepIds = (process: ResolvedProcess, track = 'idea'): string[] =>
  (process.tracks[track] ?? []).flatMap((stage) =>
    stage.steps.map((step) => step.id)
  );

const stageOf = (process: ResolvedProcess, track: string, stepId: string) =>
  (process.tracks[track] ?? []).find((stage) =>
    stage.steps.some((step) => step.id === stepId)
  );

const showLines = (
  root: string,
  track = 'existing',
  pod?: { tickets: string[]; epic?: string }
): string[] =>
  formatProcess(loadProcess(root, 'planning'), {
    title: 'Pawnee Parks app',
    track,
    pod,
  }).split('\n');

const lineOf = (lines: string[], id: string): number =>
  lines.findIndex((line) => new RegExp(`^\\s*\\d+  ${id}( |$)`).test(line));

const a11y = {
  id: 'a11y-check',
  label: 'Accessibility check',
  run: '/my-custom-command {tickets}',
  after: 'ux-review',
};

describe('adding a step', () => {
  it('lists it right after the UX review, with run filled', () => {
    const root = project({ extends: 'standard', add: [a11y] });
    const lines = showLines(root, 'existing', {
      tickets: ['PAWNEE-1', 'PAWNEE-2'],
    });
    const at = lineOf(lines, 'a11y-check');

    expect(lines[0]).toBe('Pawnee Parks app · planning · track: existing');
    expect(at).toBe(lineOf(lines, 'cp4-post') + 1);
    expect(lines[at]).toMatch(/^ 17  a11y-check\s+added$/);
    expect(lines[at + 1]).toBe(
      '     run: /my-custom-command PAWNEE-1, PAWNEE-2'
    );
    expect(lines[at + 2]).toMatch(/^ cp4\s+locked$/);
  });

  it('names a misspelt target and suggests the closest id', () => {
    const root = project({
      extends: 'standard',
      add: [{ ...a11y, after: 'ux-reveiw' }],
    });

    expect(refusal(() => loadProcess(root, 'planning'))).toBe(
      '.lambda/planning/workflow.json: add "a11y-check" after "ux-reveiw" — no such step. Did you mean "ux-review"?'
    );
  });
});

describe("Lambda's quality steps", () => {
  it('refuses dropping, replacing, dropping a checkpoint and switching off check-ticket', () => {
    const refusals = [
      refusal(() =>
        loadProcess(
          project({ extends: 'standard', drop: ['proposal-cold-read'] }),
          'planning'
        )
      ),
      refusal(() =>
        loadProcess(
          project(null, {
            files: { '.lambda/planning/ux-cold-read.md': 'Skip it.\n' },
          }),
          'planning'
        )
      ),
      refusal(() =>
        loadProcess(project({ extends: 'standard', drop: ['cp3'] }), 'planning')
      ),
      refusal(() =>
        loadProcess(
          project(
            { extends: 'standard', off: ['check-ticket'] },
            { name: 'building' }
          ),
          'building'
        )
      ),
    ];

    expect(refusals).toEqual([
      '.lambda/planning/workflow.json: drop "proposal-cold-read" refused — it\'s one of Lambda\'s quality steps.',
      '.lambda/planning/ux-cold-read.md replaces "ux-cold-read" refused — it\'s one of Lambda\'s quality steps.',
      '.lambda/planning/workflow.json: drop "cp3" refused — it\'s one of Lambda\'s quality steps.',
      '.lambda/building/workflow.json: off "check-ticket" refused — it\'s one of Lambda\'s quality steps.',
    ]);
  });

  it('refuses moving a quality step, but allows renaming one, marked both ways', () => {
    expect(
      refusal(() =>
        loadProcess(
          project({
            extends: 'standard',
            move: [{ id: 'ux-cold-read', after: 'ux-surfaces' }],
          }),
          'planning'
        )
      )
    ).toBe(
      '.lambda/planning/workflow.json: move "ux-cold-read" refused — it\'s one of Lambda\'s quality steps.'
    );

    const root = project({
      extends: 'standard',
      rename: { 'proposal-cold-read': 'Fresh read' },
    });
    const lines = showLines(root);
    const step = loadProcess(root, 'planning')
      .tracks.idea?.flatMap((stage) => stage.steps)
      .find((candidate) => candidate.id === 'proposal-cold-read');

    expect(step?.label).toBe('Fresh read');
    expect(lines[lineOf(lines, 'proposal-cold-read')]).toMatch(
      /proposal-cold-read\s+renamed "Fresh read" · locked$/
    );
  });
});

describe('rename, move, off and the command files', () => {
  it('changes order and labels, switches off an optional step only, and names a missing command file', () => {
    const root = project({
      extends: 'standard',
      rename: { 'e2e-plans': 'Test plans', fill: 'Fill in' },
      move: [{ id: 'duplicate-check', after: 'verify-premise' }],
      off: ['research'],
    });
    const process = loadProcess(root, 'planning');
    const research = stageOf(process, 'idea', 'research');

    expect(research?.steps.map((step) => step.id).slice(0, 3)).toEqual([
      'verify-premise',
      'duplicate-check',
      'research',
    ]);
    expect(research?.steps.find((step) => step.id === 'research')?.off).toBe(
      true
    );
    expect(
      stageOf(process, 'idea', 'e2e-plans')?.steps.find(
        (step) => step.id === 'e2e-plans'
      )?.label
    ).toBe('Test plans');
    expect(stageOf(process, 'idea', 'e2e-plans')?.label).toBe('Fill in');
    expect(
      showLines(root, 'idea')[lineOf(showLines(root, 'idea'), 'research')]
    ).toMatch(/research\s+optional · off$/);

    expect(
      refusal(() =>
        loadProcess(
          project({ extends: 'standard', off: ['write-tickets'] }),
          'planning'
        )
      )
    ).toBe(
      '.lambda/planning/workflow.json: off "write-tickets" refused — it isn\'t an optional step, so it can\'t be switched off.'
    );

    const survey = project({
      extends: 'standard',
      add: [{ ...a11y, run: '/lot-48-survey {tickets}' }],
    });

    expect(refusal(() => loadProcess(survey, 'planning'))).toBe(
      `.lambda/planning/workflow.json: add "a11y-check" runs /lot-48-survey, but lot-48-survey.md isn't in any of: ${[
        path.join(survey, '.lambda', 'planning', 'lot-48-survey.md'),
        path.join(survey, '.claude', 'commands', 'lot-48-survey.md'),
        path.join(
          lambdaPackageDir(),
          'instructions',
          'planning',
          'lot-48-survey.md'
        ),
      ].join(', ')}.`
    );
  });

  it('an added step with switch can be switched off', () => {
    const root = project({
      extends: 'standard',
      add: [{ ...a11y, switch: true }],
      off: ['a11y-check'],
    });

    expect(
      stageOf(loadProcess(root, 'planning'), 'idea', 'a11y-check')?.steps.find(
        (step) => step.id === 'a11y-check'
      )?.off
    ).toBe(true);
  });

  it('fills {epic} with an empty string when the pod has none', () => {
    expect(fillRun('/survey {epic} {tickets}', { tickets: ['PAWNEE-1'] })).toBe(
      '/survey  PAWNEE-1'
    );
    expect(fillRun('/survey {epic}', { tickets: [], epic: 'PAWNEE-7' })).toBe(
      '/survey PAWNEE-7'
    );
  });

  it('after a step that is also a stage, goes right after the step', () => {
    const process = loadProcess(
      project({
        extends: 'standard',
        add: [{ ...a11y, after: 'research' }],
      }),
      'planning'
    );
    const ids = stepIds(process);

    expect(ids.indexOf('a11y-check')).toBe(ids.indexOf('research') + 1);
    expect(ids.indexOf('a11y-check')).toBeLessThan(
      ids.indexOf('proposal-post')
    );
  });
});

describe('what the loader refuses and where after lands', () => {
  it('refuses a custom base and a repeated id', () => {
    expect(
      refusal(() => loadProcess(project({ extends: 'custom' }), 'planning'))
    ).toBe(
      '.lambda/planning/workflow.json: extends "custom" — only "standard" can be extended.'
    );
    expect(
      refusal(() =>
        loadProcess(
          project({
            extends: 'standard',
            add: [{ ...a11y, id: 'research' }],
          }),
          'planning'
        )
      )
    ).toBe(
      '.lambda/planning/workflow.json: add "research" repeats the id of an existing step. Give it its own id.'
    );
  });

  it('after a checkpoint, the step is the first of the next stage', () => {
    const process = loadProcess(
      project({ extends: 'standard', add: [{ ...a11y, after: 'cp3' }] }),
      'planning'
    );
    const tickets = (process.tracks.idea ?? []).find(
      (stage) => stage.id === 'tickets'
    );

    expect(tickets?.steps[0]?.id).toBe('a11y-check');
  });

  it('after a step only one track has, it lands on that track only', () => {
    const process = loadProcess(
      project({ extends: 'standard', add: [{ ...a11y, after: 'triage' }] }),
      'planning'
    );

    expect(stepIds(process, 'batch')).toContain('a11y-check');
    expect(stepIds(process, 'idea')).not.toContain('a11y-check');
    expect(stepIds(process, 'existing')).not.toContain('a11y-check');
    expect(
      stageOf(process, 'batch', 'a11y-check')?.steps.map((step) => step.id)
    ).toEqual(['triage', 'a11y-check', 'cp2-post-triage']);
  });

  it('refuses a checkpoint the step comes after', () => {
    expect(
      refusal(() =>
        loadProcess(
          project({
            extends: 'standard',
            add: [{ ...a11y, checkpoint: 3 }],
          }),
          'planning'
        )
      )
    ).toContain(
      'add "a11y-check" checkpoint 3 — it comes after "proposal-post"'
    );
    expect(() =>
      loadProcess(
        project({ extends: 'standard', add: [{ ...a11y, checkpoint: 4 }] }),
        'planning'
      )
    ).toThrow('it comes after "cp4-post"');
    expect(() =>
      loadProcess(
        project({
          extends: 'standard',
          add: [{ ...a11y, after: 'ux-cold-read', checkpoint: 4 }],
        }),
        'planning'
      )
    ).not.toThrow();
  });

  it('refuses an unknown field, naming it', () => {
    expect(
      refusal(() =>
        loadProcess(project({ extends: 'standard', parade: true }), 'planning')
      )
    ).toBe(
      ".lambda/planning/workflow.json: (root) unrecognized key(s) in object: 'parade'"
    );
  });

  it("keeps the parser's detail when workflow.json isn't valid JSON", () => {
    const text = '{ "extends": "standard", }';
    const detail = ((): string => {
      try {
        JSON.parse(text);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }

      throw new Error('Expected the trailing comma to be invalid JSON');
    })();
    const root = tmp();

    write(root, '.lambda/planning/workflow.json', text);

    expect(refusal(() => loadProcess(root, 'planning'))).toBe(
      `.lambda/planning/workflow.json: not valid JSON (${detail}).`
    );
  });

  it("refuses an added step whose run doesn't start with a /command", () => {
    const load = (run: string): string =>
      refusal(() =>
        loadProcess(
          project({ extends: 'standard', add: [{ ...a11y, run }] }),
          'planning'
        )
      );
    const expected =
      '.lambda/planning/workflow.json: add "a11y-check" run must start with a slash command, e.g. "/a11y-check {tickets}".';

    expect(load('a11y {tickets}')).toBe(expected);
    expect(load('   ')).toBe(expected);
  });

  it("names a bad entry by its step id, in the settings files' format", () => {
    const { after: _after, ...noAfter } = a11y;

    expect(
      refusal(() =>
        loadProcess(
          project({
            extends: 'standard',
            add: [noAfter],
            move: [{ id: 'research', after: 7 }],
            drop: [7],
          }),
          'planning'
        )
      )
    ).toBe(
      [
        '.lambda/planning/workflow.json: add "a11y-check" after is required.',
        '.lambda/planning/workflow.json: drop.0 expected string, received number',
        '.lambda/planning/workflow.json: move "research" after expected string, received number',
      ].join('\n')
    );
  });

  it('with no workflow.json, the standard process loads unchanged', () => {
    const process = loadProcess(tmp(), 'planning');

    expect(stepIds(process, 'existing').slice(0, 4)).toEqual([
      'intent',
      'epic',
      'epic-red-flags',
      'verify-premise',
    ]);
    expect(stepIds(loadProcess(tmp(), 'building'), 'standard')).toEqual([
      'pick-up',
      'build',
      'self-review',
      'check-ticket',
      'visual-check',
      'test',
      'review',
      'design-check',
      'ship',
    ]);
  });
});

describe('unknown and repeated ids', () => {
  const load = (workflow: object, name: ProcessName = 'planning'): string =>
    refusal(() => loadProcess(project(workflow, { name }), name));

  it('refuses an unknown id in drop, move, rename and off, naming the file and entry', () => {
    expect(load({ extends: 'standard', drop: ['lot-48'] })).toBe(
      '.lambda/planning/workflow.json: drop "lot-48" — no such step.'
    );
    expect(
      load({ extends: 'standard', move: [{ id: 'lot-48', after: 'research' }] })
    ).toBe('.lambda/planning/workflow.json: move "lot-48" — no such step.');
    expect(load({ extends: 'standard', rename: { 'lot-48': 'Pit' } })).toBe(
      '.lambda/planning/workflow.json: rename "lot-48" — no such step.'
    );
    expect(load({ extends: 'standard', off: ['lot-48'] })).toBe(
      '.lambda/planning/workflow.json: off "lot-48" — no such step.'
    );
    expect(load({ extends: 'standard', off: ['shipp'] }, 'building')).toBe(
      '.lambda/building/workflow.json: off "shipp" — no such step. Did you mean "ship"?'
    );
  });

  it('refuses an added id that repeats another added step', () => {
    expect(
      load({
        extends: 'standard',
        add: [a11y, { ...a11y, label: 'Again', after: 'research' }],
      })
    ).toBe(
      '.lambda/planning/workflow.json: add "a11y-check" repeats the id of an existing step. Give it its own id.'
    );
  });

  it('refuses a standard id on no track, and a building one', () => {
    expect(
      load({ extends: 'standard', add: [{ ...a11y, id: 'split-tickets' }] })
    ).toBe(
      '.lambda/planning/workflow.json: add "split-tickets" repeats the id of an existing step. Give it its own id.'
    );
    expect(
      load(
        {
          extends: 'standard',
          add: [{ ...a11y, id: 'ship', after: 'test' }],
        },
        'building'
      )
    ).toBe(
      '.lambda/building/workflow.json: add "ship" repeats the id of an existing step. Give it its own id.'
    );
  });

  it('refuses a checkpoint the track does not have', () => {
    expect(
      load({
        extends: 'standard',
        add: [{ ...a11y, after: 'triage', checkpoint: 1 }],
      })
    ).toBe(
      '.lambda/planning/workflow.json: add "a11y-check" checkpoint 1 — the batch track has no checkpoint 1.'
    );
  });
});

describe('replacing instructions', () => {
  it('looks in .lambda, then .claude/commands, then Lambda’s own', () => {
    const root = project(null, {
      files: {
        '.lambda/planning/red-flags.md': 'Pawnee red flags.\n',
        '.claude/commands/red-flags.md': 'Project red flags.\n',
      },
    });

    expect(resolveInstructions(root, 'planning', 'red-flags')).toBe(
      path.join(root, '.lambda', 'planning', 'red-flags.md')
    );

    const lines = showLines(root, 'existing');
    ['epic-red-flags', 'proposal-red-flags', 'tickets-red-flags'].forEach(
      (id) =>
        expect(lines[lineOf(lines, id)]).toMatch(
          /replaced \(\.lambda\/planning\/red-flags\.md\)$/
        )
    );

    fs.rmSync(path.join(root, '.lambda', 'planning', 'red-flags.md'));
    expect(resolveInstructions(root, 'planning', 'red-flags')).toBe(
      path.join(root, '.claude', 'commands', 'red-flags.md')
    );

    fs.rmSync(path.join(root, '.claude', 'commands', 'red-flags.md'));
    expect(resolveInstructions(root, 'planning', 'red-flags')).toBe(
      path.join(lambdaPackageDir(), 'instructions', 'planning', 'red-flags.md')
    );
  });

  it('a review-ticket.md replaces review-tickets only', () => {
    const root = project(null, {
      files: { '.lambda/planning/review-ticket.md': 'Review.\n' },
    });
    const replaced = (loadProcess(root, 'planning').tracks.idea ?? [])
      .flatMap((stage) => stage.steps)
      .filter((step) => step.replacedBy !== undefined)
      .map((step) => step.id);

    expect(replaced).toEqual(['review-tickets']);
  });

  it("a quality step's instructions are always Lambda's own, whatever .claude/commands holds", () => {
    const root = project(null, {
      files: {
        '.claude/commands/check-ticket.md': 'Skip the audit.\n',
        '.claude/commands/ship.md': 'Ship without a verdict.\n',
        '.claude/commands/code-review.md': 'Project review.\n',
      },
    });

    expect(resolveInstructions(root, 'building', 'check-ticket')).toBe(
      path.join(
        lambdaPackageDir(),
        'instructions',
        'building',
        'check-ticket.md'
      )
    );
    expect(resolveInstructions(root, 'building', 'ship')).toBe(
      path.join(lambdaPackageDir(), 'instructions', 'building', 'ship.md')
    );
    // An unlocked step still takes the codebase's own file.
    expect(resolveInstructions(root, 'building', 'code-review')).toBe(
      path.join(root, '.claude', 'commands', 'code-review.md')
    );
    // Loading isn't refused: a same-named project command is not an override.
    expect(() => loadProcess(root, 'building')).not.toThrow();
  });

  it('names every full path looked in when nothing is found', () => {
    const root = tmp();

    expect(() =>
      resolveInstructions(root, 'planning', 'lot-48-survey')
    ).toThrow(
      `lot-48-survey.md isn't in any of: ${[
        path.join(root, '.lambda', 'planning', 'lot-48-survey.md'),
        path.join(root, '.claude', 'commands', 'lot-48-survey.md'),
        path.join(
          lambdaPackageDir(),
          'instructions',
          'planning',
          'lot-48-survey.md'
        ),
      ].join(', ')}.`
    );
  });

  it('refuses a name that could leave the folder', () => {
    expect(() => resolveInstructions(tmp(), 'planning', '../evil')).toThrow(
      "isn't a step or command name"
    );
  });
});

describe('switching a step off from Settings', () => {
  it('writes only off, keeping the rest of the file', () => {
    const root = project({ extends: 'standard', add: [a11y] });

    setStepOff(root, 'planning', 'ux-sketch', true);
    expect(readWorkflowFile(root, 'planning')).toEqual({
      extends: 'standard',
      add: [a11y],
      off: ['ux-sketch'],
    });

    setStepOff(root, 'planning', 'ux-sketch', false);
    expect(readWorkflowFile(root, 'planning')?.off).toEqual([]);
  });

  it('changes only off, keeping the rest of the file in the order it was written', () => {
    const root = project({
      rename: { research: 'Look around' },
      off: ['research'],
      extends: 'standard',
    });
    const file = path.join(root, '.lambda/planning/workflow.json');

    setStepOff(root, 'planning', 'ux-sketch', true);

    expect(fs.readFileSync(file, 'utf8')).toBe(
      `${JSON.stringify(
        {
          rename: { research: 'Look around' },
          off: ['research', 'ux-sketch'],
          extends: 'standard',
        },
        null,
        2
      )}\n`
    );
  });

  it('switching a step on with no workflow.json writes nothing', () => {
    const root = tmp();

    setStepOff(root, 'planning', 'ux-sketch', false);

    expect(fs.existsSync(path.join(root, '.lambda'))).toBe(false);
  });

  it('refuses a step that is not optional, writing nothing', () => {
    const root = tmp();

    expect(() => setStepOff(root, 'building', 'ship', true)).toThrow(
      "it's one of Lambda's quality steps"
    );
    expect(readWorkflowFile(root, 'building')).toBeNull();
  });
});

describe('stage ids in move and off', () => {
  const load = (workflow: object, name: ProcessName = 'planning'): string =>
    refusal(() => loadProcess(project(workflow, { name }), name));

  it('refuses moving or switching off a checkpoint as a quality step', () => {
    expect(load({ extends: 'standard', off: ['cp3'] })).toBe(
      '.lambda/planning/workflow.json: off "cp3" refused — it\'s one of Lambda\'s quality steps.'
    );
    expect(
      load({ extends: 'standard', move: [{ id: 'cp4', after: 'fill' }] })
    ).toBe(
      '.lambda/planning/workflow.json: move "cp4" refused — it\'s one of Lambda\'s quality steps.'
    );
  });

  it('says only drop and rename take a stage, never suggesting the id itself', () => {
    expect(load({ extends: 'standard', off: ['tickets'] })).toBe(
      '.lambda/planning/workflow.json: off "tickets" — "tickets" is a stage, and only drop and rename take a stage.'
    );
    expect(
      load({ extends: 'standard', move: [{ id: 'tickets', after: 'fill' }] })
    ).toBe(
      '.lambda/planning/workflow.json: move "tickets" — "tickets" is a stage, and only drop and rename take a stage.'
    );
  });

  it("names a move target that is on none of the step's tracks", () => {
    expect(
      load({ extends: 'standard', move: [{ id: 'triage', after: 'cp1-post' }] })
    ).toBe(
      '.lambda/planning/workflow.json: move "triage" after "cp1-post" — no track has both.'
    );
  });

  it("refuses moving a standard step past a checkpoint's post", () => {
    expect(
      load({
        extends: 'standard',
        move: [{ id: 'split-proposal', after: 'cp3' }],
      })
    ).toBe(
      '.lambda/planning/workflow.json: move "split-proposal" after "cp3" refused — it would run after "proposal-post", and checkpoint 3 is where the owner approves the work before it.'
    );
  });

  it("refuses moving a standard step ahead of a checkpoint's post", () => {
    expect(
      load({
        extends: 'standard',
        move: [{ id: 'finish-ready', after: 'reconcile-tickets' }],
      })
    ).toBe(
      '.lambda/planning/workflow.json: move "finish-ready" after "reconcile-tickets" refused — it would run before "cp5-post", and the work after checkpoint 5 waits for the owner to approve it.'
    );
    expect(
      load({
        extends: 'standard',
        move: [{ id: 'write-tickets', after: 'split-proposal' }],
      })
    ).toBe(
      '.lambda/planning/workflow.json: move "write-tickets" after "split-proposal" refused — it would run before "proposal-post", and the work after checkpoint 3 waits for the owner to approve it.'
    );
  });

  it('loads a move that stays on its side of every post', () => {
    const order = stepIds(
      loadProcess(
        project({
          extends: 'standard',
          move: [
            { id: 'write-tickets', after: 'ux-sketch' },
            { id: 'verify-premise', after: 'duplicate-check' },
          ],
        }),
        'planning'
      ),
      'existing'
    );

    expect(order.indexOf('write-tickets')).toBe(order.indexOf('ux-sketch') + 1);
    expect(order.indexOf('verify-premise')).toBe(
      order.indexOf('duplicate-check') + 1
    );
  });
});

describe('show marks', () => {
  it("marks a step replaced by the codebase's .claude/commands file, never a quality step", () => {
    const root = project(null, {
      files: {
        '.claude/commands/red-flags.md': 'Project red flags.\n',
        '.claude/commands/check-ticket.md': 'Skip the audit.\n',
      },
    });
    const lines = showLines(root, 'existing');

    ['epic-red-flags', 'proposal-red-flags', 'tickets-red-flags'].forEach(
      (id) =>
        expect(lines[lineOf(lines, id)]).toMatch(
          /replaced \(\.claude\/commands\/red-flags\.md\)$/
        )
    );

    const building = formatProcess(loadProcess(root, 'building'), {
      title: 'Pawnee Parks app',
    }).split('\n');

    expect(building[lineOf(building, 'check-ticket')]).toMatch(
      /check-ticket\s+locked$/
    );
  });

  it('marks a switchable added step optional, on and off', () => {
    const on = showLines(
      project({ extends: 'standard', add: [{ ...a11y, switch: true }] })
    );
    const off = showLines(
      project({
        extends: 'standard',
        add: [{ ...a11y, switch: true }],
        off: ['a11y-check'],
      })
    );

    expect(on[lineOf(on, 'a11y-check')]).toMatch(
      /a11y-check\s+added · optional$/
    );
    expect(off[lineOf(off, 'a11y-check')]).toMatch(
      /a11y-check\s+added · optional · off$/
    );
  });
});

describe("a step's own instructions", () => {
  it('a step id file wins; with none, the step falls through to its command', () => {
    const root = project(null, {
      files: { '.lambda/planning/epic-red-flags.md': 'Epic only.\n' },
    });

    expect(resolveStepInstructions(root, 'planning', 'epic-red-flags')).toBe(
      path.join(root, '.lambda', 'planning', 'epic-red-flags.md')
    );
    expect(resolveStepInstructions(root, 'planning', 'tickets-red-flags')).toBe(
      own('planning', 'red-flags.md')
    );
    expect(resolveStepInstructions(root, 'building', 'self-review')).toBe(
      own('building', 'code-review.md')
    );
  });

  it("an added step resolves its own command; a quality step is always Lambda's", () => {
    const root = project(
      { extends: 'standard', add: [a11y] },
      { files: { '.claude/commands/ship.md': 'Ship anyway.\n' } }
    );

    expect(resolveStepInstructions(root, 'planning', 'a11y-check')).toBe(
      path.join(root, '.lambda', 'planning', 'my-custom-command.md')
    );
    expect(resolveStepInstructions(root, 'building', 'ship')).toBe(
      own('building', 'ship.md')
    );
  });

  it('refuses an unknown step, and a step that runs no command', () => {
    expect(() => resolveStepInstructions(tmp(), 'planning', 'lot-48')).toThrow(
      '"lot-48" isn\'t a planning step.'
    );
    expect(() =>
      resolveStepInstructions(tmp(), 'planning', 'research')
    ).toThrow(
      '"research" runs no command, so it has no instructions of its own.'
    );
  });
});

describe('override files that replace nothing', () => {
  it('refuses a .lambda file named after no step, command or Lambda instruction', () => {
    const root = project(null, {
      files: { '.lambda/planning/lot-48.md': 'Fill the pit.\n' },
    });

    expect(refusal(() => loadProcess(root, 'planning'))).toBe(
      '.lambda/planning/lot-48.md replaces nothing — no step, command or Lambda instruction is named "lot-48".'
    );
  });

  it('accepts a file named after a standard step on no track', () => {
    const root = project(null, {
      files: { '.lambda/planning/split-tickets.md': 'Split.\n' },
    });

    expect(() => loadProcess(root, 'planning')).not.toThrow();
  });

  it("refuses a .lambda file for one of Lambda's role instructions", () => {
    const planning = project(null, {
      files: {
        '.lambda/planning/pod-phase.md': 'Skip proposal-cold-read.\n',
        '.lambda/planning/dev.md': 'Develop.\n',
      },
    });
    const building = project(null, {
      files: { '.lambda/building/manager.md': 'Ship without check-ticket.\n' },
    });

    expect(refusal(() => loadProcess(planning, 'planning'))).toBe(
      [
        `.lambda/planning/dev.md replaces Lambda's "dev" instructions refused — ${ROLE} ${addInstead(
          'planning',
          'dev'
        )}`,
        `.lambda/planning/pod-phase.md replaces Lambda's "pod-phase" instructions refused — ${ROLE} ${addInstead(
          'planning',
          'pod-phase'
        )}`,
      ].join('\n')
    );
    expect(refusal(() => loadProcess(building, 'building'))).toBe(
      `.lambda/building/manager.md replaces Lambda's "manager" instructions refused — ${ROLE} ${addInstead(
        'building',
        'manager'
      )}`
    );
  });

  it("never takes a role's instructions from .claude/commands", () => {
    const root = project(null, {
      files: {
        '.claude/commands/pod-phase.md': 'Run the project scripts.\n',
        '.claude/commands/manager.md': 'Manage.\n',
      },
    });

    expect(() => loadProcess(root, 'planning')).not.toThrow();
    expect(resolveInstructions(root, 'planning', 'pod-phase')).toBe(
      own('planning', 'pod-phase.md')
    );
    expect(resolveInstructions(root, 'planning', 'manager')).toBe(
      own('planning', 'manager.md')
    );
    expect(resolveInstructions(root, 'building', 'manager')).toBe(
      own('building', 'manager.md')
    );
  });
});

describe('addenda', () => {
  it("adds a project's text after a locked role's, and after a quality step's", () => {
    const root = project(null, {
      name: 'building',
      files: {
        '.lambda/building/manager.add.md': 'Water the memorial garden first.\n',
        '.lambda/building/ship.add.md': 'Report the parade float.\n',
      },
    });

    expect(() => loadProcess(root, 'building')).not.toThrow();
    expect(withAddendum(root, 'building', 'manager', 'Lambda text.\n')).toBe(
      'Lambda text.\n\nWater the memorial garden first.\n'
    );
    expect(withAddendum(root, 'building', 'ship', 'Ship.')).toBe(
      'Ship.\n\nReport the parade float.\n'
    );
  });

  it('leaves the text as it is with no addendum', () => {
    expect(withAddendum(tmp(), 'planning', 'dev', 'Develop.\n')).toBe(
      'Develop.\n'
    );
  });

  it('refuses an addendum named after nothing', () => {
    const root = project(null, {
      files: { '.lambda/planning/lot-48.add.md': 'Fill the pit.\n' },
    });

    expect(refusal(() => loadProcess(root, 'planning'))).toBe(
      '.lambda/planning/lot-48.add.md adds to nothing — no step, command or Lambda instruction is named "lot-48".'
    );
  });
});

describe('a required step', () => {
  const building = (workflow: object | null, files = {}): string =>
    project(workflow, { name: 'building', files });
  const REQUIRED =
    "it's one of Lambda's required steps: it stays where it is, though its instructions can be replaced.";

  it('refuses dropping, moving or switching off design-check', () => {
    const refusals = [
      { extends: 'standard', drop: ['design-check'] },
      { extends: 'standard', move: [{ id: 'design-check', after: 'build' }] },
      { extends: 'standard', off: ['design-check'] },
    ].map((workflow) =>
      refusal(() => loadProcess(building(workflow), 'building'))
    );

    expect(refusals).toEqual([
      `.lambda/building/workflow.json: drop "design-check" refused — ${REQUIRED}`,
      `.lambda/building/workflow.json: move "design-check" refused — ${REQUIRED}`,
      `.lambda/building/workflow.json: off "design-check" refused — ${REQUIRED}`,
    ]);
  });

  it('refuses a step added or moved between design-check and ship, but takes one before design-check', () => {
    const between =
      '"design-check" is one of Lambda\'s required steps and runs right before "ship".';

    expect(
      refusal(() =>
        loadProcess(
          building(
            {
              extends: 'standard',
              add: [{ ...a11y, after: 'design-check' }],
            },
            { '.lambda/building/my-custom-command.md': 'Check it.\n' }
          ),
          'building'
        )
      )
    ).toBe(
      `.lambda/building/workflow.json: "a11y-check" can't run between "design-check" and "ship" — ${between}`
    );
    expect(
      refusal(() =>
        loadProcess(
          building({
            extends: 'standard',
            move: [{ id: 'test', after: 'design-check' }],
          }),
          'building'
        )
      )
    ).toBe(
      `.lambda/building/workflow.json: "test" can't run between "design-check" and "ship" — ${between}`
    );
    expect(() =>
      loadProcess(
        building(
          { extends: 'standard', add: [{ ...a11y, after: 'test' }] },
          { '.lambda/building/my-custom-command.md': 'Check it.\n' }
        ),
        'building'
      )
    ).not.toThrow();
  });

  it("takes the codebase's own design-check.md, marked required", () => {
    const root = building(null, {
      '.lambda/building/design-check.md': 'Our design check.\n',
    });
    const lines = formatProcess(loadProcess(root, 'building'), {
      title: 'Pawnee Parks app',
    }).split('\n');

    expect(resolveStepInstructions(root, 'building', 'design-check')).toBe(
      path.join(root, '.lambda', 'building', 'design-check.md')
    );
    expect(lines[lineOf(lines, 'design-check')]).toMatch(
      /design-check\s+replaced \(\.lambda\/building\/design-check\.md\) · required$/
    );
  });

  it("marks a locked step whose command is in building.ownCommands as run with the codebase's own instructions", () => {
    const lines = formatProcess(loadProcess(building(null), 'building'), {
      title: 'Pawnee Parks app',
      ownCommands: ['check-ticket'],
    }).split('\n');

    expect(lines[lineOf(lines, 'check-ticket')]).toMatch(
      /check-ticket\s+locked · Pawnee Parks app's own instructions$/
    );
  });
});

describe('a step that starts off', () => {
  const reviewOff = (root: string): boolean | undefined =>
    Object.values(loadProcess(root, 'building').tracks)
      .flat()
      .flatMap((stage) => stage.steps)
      .find((step) => step.id === 'review')?.off;

  it('is off with no workflow.json, switched on with on, and off again', () => {
    const root = tmp();

    expect(reviewOff(root)).toBe(true);

    setStepOff(root, 'building', 'review', false);
    expect(reviewOff(root)).toBe(false);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(root, '.lambda', 'building', 'workflow.json'),
          'utf8'
        )
      ).on
    ).toEqual(['review']);

    setStepOff(root, 'building', 'review', true);
    expect(reviewOff(root)).toBe(true);
  });
});
