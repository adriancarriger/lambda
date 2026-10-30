import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { registerSystemCommands } from '../../commands/design/system';
import {
  cloneOfUpstream,
  commitAll,
  put,
} from '../../design/system/__tests__/gitFixture';
import { noDesignSystemMessage } from '../../design/system/build';
import '../../pod/__tests__/podProject';
import { runStep } from '../../pod/steps';
import {
  lambdaPackageDir,
  resolveInstructions,
  resolveStepInstructions,
} from '../../process/workflow-file';
import { readProcessSettings } from '../../runner/processSettings';
import { pickedUpText } from '../driver';
import { buildingStepIds, buildingSteps } from '../workflow';
import { buildingPodStore } from './fakes';

/**
 * The design check in the build: every ticket of a project with a design
 * system keeps it in step, right before ship, and the gates (check-ticket,
 * code review) hold the design system's copies to the app.
 */

const own = (...parts: string[]): string =>
  path.join(lambdaPackageDir(), 'instructions', ...parts);

const read = (...parts: string[]): string =>
  fs.readFileSync(own(...parts), 'utf8');

const project = (files: Record<string, string> = {}): string => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pawnee-design-check-'))
  );
  Object.entries(files).forEach(([file, text]) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  });

  return root;
};

const STANDARD = [
  'pick-up',
  'build',
  'self-review',
  'check-ticket',
  'visual-check',
  'test',
  'design-check',
  'ship',
];

describe('the design-check instructions', () => {
  it("are Lambda's building/design-check.md, and a project's .lambda/building/design-check.md comes first", () => {
    expect(fs.existsSync(own('building', 'design-check.md'))).toBe(true);
    expect(resolveInstructions(project(), 'building', 'design-check')).toBe(
      own('building', 'design-check.md')
    );

    const root = project({
      '.lambda/building/design-check.md': '# Pawnee design check\n',
    });

    expect(resolveInstructions(root, 'building', 'design-check')).toBe(
      path.join(root, '.lambda', 'building', 'design-check.md')
    );
    expect(resolveStepInstructions(root, 'building', 'design-check')).toBe(
      path.join(root, '.lambda', 'building', 'design-check.md')
    );
  });

  it('name the source map, the check build and both reports, and never publish or commit', () => {
    const text = read('building', 'design-check.md');

    [
      'lambda design system changed',
      'lambda design system build --check',
      'DESIGN: NO CHANGE',
      'DESIGN: UPDATED',
      'never publishes',
      'does not commit',
      'update the copy',
      'rebuild only',
      'NO DESIGN CHANGES',
      'logic only, the copy stands',
      'sources.json',
      'catalog.ts',
      'index.tsx',
      'sampleData.ts',
      'screens/',
      'extra work',
    ].forEach((words) =>
      expect({ words, found: text.includes(words) }).toEqual({
        words,
        found: true,
      })
    );
    expect(text).toMatch(/never changes the manifest/i);
    expect(text).not.toMatch(/manifest write --/);
  });

  it('say what to do when the source map is broken, and the manager blocks on a second failure', () => {
    const check = read('building', 'design-check.md');
    const manager = read('building', 'manager.md');
    const start = read('building', 'start.md');

    expect(check).toContain('If it fails (exits 1');
    expect(check).toContain('DESIGN: FAILED');
    expect(manager).toContain(
      '**`DESIGN: FAILED`** (`lambda design system changed` failed twice'
    );
    expect(manager).toContain("don't skip; go on to 1");
    expect(start).toContain('If it fails (exits 1');
  });
});

describe('the design-check step', () => {
  it("sits right before ship in the standard building steps, the dev's, running /design-check", () => {
    expect(buildingStepIds(project())).toEqual(STANDARD);
    expect(
      buildingSteps(project()).find((step) => step.id === 'design-check')
    ).toMatchObject({ who: 'dev', command: 'design-check' });
  });

  it('is exactly the standard eight steps for a project, design-check immediately before ship', () => {
    const ids = buildingStepIds(
      project({ 'lambda.json': '{ "name": "pawnee-parks" }\n' })
    );

    expect(ids).toEqual([
      'pick-up',
      'build',
      'self-review',
      'check-ticket',
      'visual-check',
      'test',
      'design-check',
      'ship',
    ]);
    expect(ids[ids.indexOf('ship') - 1]).toBe('design-check');
  });

  it('runs on every ticket: no quick track, and the pick-up never tells the manager to skip it', () => {
    // A building pod's steps come from the project, never from the ticket:
    // buildingStepIds takes the project root and nothing about the ticket.
    expect(buildingStepIds).toHaveLength(1);

    const quick = {
      id: 'PAWNEE-41',
      title: 'Fix the Lot 48 bench count',
      labels: ['small-fix'],
    };
    const normal = {
      id: 'PAWNEE-42',
      title: 'Add the Ramsett Park page',
      labels: [],
    };
    const texts = [quick, normal].map((run) =>
      pickedUpText(run, { n: 1, m: 2 })
    );

    texts.forEach((text) => {
      expect(text).toContain('go on from Step 2 (Build)');
      expect(text).not.toMatch(/design-check|design check|skip/i);
    });
    expect(texts[0].replace(/PAWNEE-41 Fix the Lot 48 bench count/g, 'T')).toBe(
      texts[1].replace(/PAWNEE-42 Add the Ramsett Park page/g, 'T')
    );

    const manager = read('building', 'manager.md');
    const step = manager.slice(
      manager.indexOf('### Step 7: Design check'),
      manager.indexOf('### Step 8: Ship')
    );

    expect(manager).toContain(
      '`design-check` runs in every ticket of a project with a design system.'
    );
    expect(step).not.toMatch(/quick|label/i);
  });

  it('has no on/off switch in Settings → Process, and is not optional', () => {
    const root = project();
    const step = buildingSteps(root).find((one) => one.id === 'design-check');

    expect(step?.optional).toBeUndefined();
    expect(
      readProcessSettings(root).building.flatMap((stage) =>
        stage.steps.map((one) => one.id)
      )
    ).not.toContain('design-check');
  });

  it('can be skipped only with a reason, which the step record keeps', () => {
    const { store, root, podId } = buildingPodStore();
    store.writeBuilding(podId, {
      runs: [
        {
          id: 'PAWNEE-12',
          title: 'Make the design system from the app',
          step: 'test',
          attempt: 1,
          startedAt: '2026-10-01T10:00:00.000Z',
          claim: 'claimed',
        },
      ],
      upNext: [],
    });
    process.env.LAMBDA_PODS_ROOT = store.root;

    try {
      expect(() =>
        runStep('design-check', 'skip', { pod: podId }, root)
      ).toThrow(/Skipping design-check needs --reason/);

      runStep(
        'design-check',
        'skip',
        { pod: podId, reason: 'no design system' },
        root
      );

      expect(store.readSteps(podId).at(-1)).toMatchObject({
        step: 'design-check',
        event: 'skip',
        reason: 'no design system',
        ticket: 'PAWNEE-12',
      });
    } finally {
      delete process.env.LAMBDA_PODS_ROOT;
    }
  });

  it("is in the Engineering manager's nine steps, skipped with no design system on the base", () => {
    const manager = read('building', 'manager.md');

    expect(manager).toContain(
      'The process has nine steps — `pick-up`, `build`, `self-review`, `check-ticket`, `visual-check`, `test`, `review`, `design-check`, `ship` —'
    );
    expect(manager).toContain('### Step 7: Design check (`design-check`)');
    expect(manager).toContain('### Step 8: Ship (`ship`)');
    expect(manager).toContain(
      'lambda pod step design-check skip --reason "no design system"'
    );
    expect(manager).toContain('lambda tmux dev "/design-check <id>"');
    expect(manager.indexOf('### Step 7: Design check')).toBeLessThan(
      manager.indexOf('### Step 8: Ship')
    );
  });
});

describe('the design-check skip is tied to a missing manifest on the base', () => {
  const DIR = '.lambda/design-system';
  const MANIFEST = `${DIR}/design-system.json`;

  /** A clone whose origin/main has (or lacks) the manifest, on a ticket branch that changed the theme. */
  const ticketClone = (withManifest: boolean): string => {
    const { clone } = cloneOfUpstream({
      'lambda.json': JSON.stringify({ name: 'Pawnee parks map' }),
      'src/theme.ts': 'export const theme = {};\n',
      [`${DIR}/sources.json`]: JSON.stringify({
        system: [`${DIR}/`],
        tokens: ['src/theme.ts'],
        components: {},
        patterns: {},
      }),
      ...(withManifest
        ? {
            [MANIFEST]: JSON.stringify({
              namespace: 'PawneeParksMap',
              version: 1,
            }),
          }
        : {}),
    });
    put(clone, 'src/theme.ts', "export const theme = { green: '#2e7d32' };\n");
    commitAll(clone, 'PAWNEE-31: greener parks');

    return clone;
  };

  const changed = async (cwd: string): Promise<string[]> => {
    const printed: string[] = [];
    const log = jest
      .spyOn(console, 'log')
      .mockImplementation((line: unknown) => {
        printed.splice(printed.length, 0, String(line));
      });
    const error = jest
      .spyOn(console, 'error')
      .mockImplementation((line: unknown) => {
        printed.splice(printed.length, 0, `error: ${String(line)}`);
      });
    const savedCwd = process.cwd();
    const savedExit = process.exitCode;

    try {
      process.chdir(cwd);
      const program = new Command('lambda').exitOverride();
      registerSystemCommands(program.command('design'));
      await program.parseAsync(['design', 'system', 'changed'], {
        from: 'user',
      });

      return [...printed, `exit ${process.exitCode ?? 0}`];
    } finally {
      process.chdir(savedCwd);
      log.mockRestore();
      error.mockRestore();
      process.exitCode = savedExit;
    }
  };

  /** The manager's Step 7 skip bullet. */
  const skipRule = (): string => {
    const manager = read('building', 'manager.md');
    const step = manager.slice(
      manager.indexOf('### Step 7: Design check'),
      manager.indexOf('### Step 8: Ship')
    );
    const bullet = step
      .split('\n')
      .find((line) => line.includes('design-check skip'));

    if (bullet === undefined) {
      throw new Error('manager.md Step 7 has no design-check skip line.');
    }

    return bullet;
  };

  it('with no manifest on origin/main, changed prints exactly the line the manager skips on', async () => {
    const lines = await changed(ticketClone(false));

    expect(lines).toEqual([noDesignSystemMessage(MANIFEST), 'exit 0']);

    const rule = skipRule();

    // The manager skips when `changed` prints that line, whatever the manifest's path.
    expect(rule).toContain(
      `\`lambda design system changed\` prints "${noDesignSystemMessage('…')}"`
    );
    expect(rule).toContain(
      '`lambda pod step design-check skip --reason "no design system"`'
    );
  });

  it('with the manifest on origin/main, changed prints change lines and the manager does not skip', async () => {
    const lines = await changed(ticketClone(true));

    expect(lines).toEqual(['rebuild only     theme   src/theme.ts', 'exit 0']);
    expect(
      lines.some((line) =>
        line.startsWith('This project has no design system yet')
      )
    ).toBe(false);

    const manager = read('building', 'manager.md');

    expect(manager).toMatch(
      /Otherwise:\n\n1\. `lambda tmux dev "\/design-check <id>"`/
    );
    expect(skipRule()).toContain(
      'Skip only on that line: change lines or `NO DESIGN CHANGES` mean the project has one, so go on below.'
    );
  });

  it('prints NO DESIGN CHANGES with the manifest on origin/main and no design change', async () => {
    const { clone } = cloneOfUpstream({
      'lambda.json': JSON.stringify({ name: 'Pawnee parks map' }),
      'README.md': '# Pawnee parks map\n',
      [`${DIR}/sources.json`]: JSON.stringify({
        system: [`${DIR}/`],
        tokens: [],
        components: {},
        patterns: {},
      }),
      [MANIFEST]: JSON.stringify({ namespace: 'PawneeParksMap', version: 1 }),
    });
    put(clone, 'README.md', '# Pawnee parks map, Lot 48\n');
    commitAll(clone, 'PAWNEE-32: README');

    expect(await changed(clone)).toEqual(['NO DESIGN CHANGES', 'exit 0']);
  });
});

describe('the gates', () => {
  it('check-ticket holds a pattern that still copies the old look as a gap, and nothing else', () => {
    const text = read('building', 'check-ticket.md');

    expect(text).toContain(
      'Missing file: <dir>/patterns/<file> still copies the old <thing>.'
    );
    expect(text).toContain('logic only, the copy stands');
    expect(text).toMatch(
      /`rebuild only` lines and `NO DESIGN CHANGES` are never a gap/
    );
  });

  it('code review reviews the design system as code', () => {
    const text = read('building', 'code-review.md');

    expect(text).toContain('Design system changes are code.');
    [
      'sources.json',
      'catalog.ts',
      'sampleData.ts',
      'screens/',
      'index.tsx',
    ].forEach((words) => expect(text).toContain(words));
    expect(text).toMatch(/import the app's runtime/);
  });

  it('no instruction mentions a publish after the merge', () => {
    const files = (dir: string): string[] =>
      fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((entry) =>
          entry.isDirectory()
            ? files(path.join(dir, entry.name))
            : [path.join(dir, entry.name)]
        );
    const mentions = files(own())
      .filter((file) => file.endsWith('.md'))
      .filter((file) =>
        /after[- ]merge|after the merge|afterMerge|republish|PUBLISH DUE/i.test(
          fs.readFileSync(file, 'utf8')
        )
      );

    expect(mentions).toEqual([]);
  });
});
