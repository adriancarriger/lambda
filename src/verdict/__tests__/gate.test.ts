import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { fakeSource, ticket } from '../../building/__tests__/fakes';
import { runShip } from '../../building/ship';
import { type Project, ProjectConfigSchema } from '../../config/projectConfig';
import { type Verdict } from '../../pod-store/schemas';
import { type TicketSource } from '../../tickets/source';
import { describeRefusal, hasDesignSection } from '../gate';
import { type VerdictDeps, registerVerdictCommand } from '../index';
import {
  ensureVerdictsDir,
  readVerdict,
  recordVerdict,
  verdictsDir,
} from '../store';
import { type VisualVerdict, writeVisualVerdict } from '../visualStore';

const TICKET = { id: '3', title: 'Trail markers' };

const project = (lambdaJson: Record<string, unknown> = {}): string => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-verdict-'))
  );
  fs.writeFileSync(
    path.join(root, 'lambda.json'),
    JSON.stringify({ name: 'Pawnee Parks app', ...lambdaJson })
  );

  return root;
};

const verdict = (extra: Partial<Verdict> = {}): Verdict => ({
  ticketId: '3',
  verdict: 'COMPLETE',
  failedDimensions: [],
  deviations: [],
  recordedAt: '2026-10-23T10:00:00.000Z',
  ...extra,
});

const cli = (root: string) => {
  const out: string[] = [];
  const err: string[] = [];
  const deps: VerdictDeps = {
    projectRoot: root,
    print: (line) => {
      out.splice(out.length, 0, line);
    },
    printError: (line) => {
      err.splice(err.length, 0, line);
    },
  };
  // A new program each run: commander keeps option values between parses.
  const program = (): Command => {
    const made = new Command().exitOverride();
    made.configureOutput({
      writeErr: (text) => {
        err.splice(err.length, 0, text);
      },
    });
    registerVerdictCommand(made, () => deps);

    return made;
  };

  return {
    out,
    err,
    exitCode: (...args: string[]): Promise<number> =>
      program()
        .parseAsync(['node', 'lambda', 'verdict', ...args])
        .then(
          () => {
            const code = Number(process.exitCode ?? 0);
            process.exitCode = undefined;

            return code;
          },
          () => {
            process.exitCode = undefined;

            return 1;
          }
        ),
  };
};

describe('the ship gate', () => {
  it('refuses a ticket with no verdict', () => {
    expect(describeRefusal(TICKET, { kind: 'missing' })).toEqual([
      '✗ 3 Trail markers has no COMPLETE check-ticket verdict.',
      '  Run the check-ticket step first.',
    ]);
  });

  it('refuses an INCOMPLETE verdict, naming what failed', () => {
    expect(
      describeRefusal(TICKET, {
        kind: 'found',
        verdict: verdict({
          verdict: 'INCOMPLETE',
          failedDimensions: ['Test Plan'],
        }),
      })
    ).toEqual([
      "✗ 3 Trail markers's last check-ticket verdict was INCOMPLETE.",
      '  Failed: Test Plan',
    ]);
    expect(
      describeRefusal(TICKET, {
        kind: 'found',
        verdict: verdict({ verdict: 'INCOMPLETE' }),
      })
    ).toEqual(["✗ 3 Trail markers's last check-ticket verdict was INCOMPLETE."]);
  });

  it('refuses a verdict it cannot read, and never as missing or COMPLETE', () => {
    const root = project();
    fs.writeFileSync(
      path.join(ensureVerdictsDir(root), '3.json'),
      '{"verdict": "COMPL'
    );
    const lookup = readVerdict(root, '3');

    expect(lookup.kind).toBe('unreadable');
    expect(describeRefusal(TICKET, lookup)).toEqual([
      expect.stringMatching(
        /^✗ 3 Trail markers: the check-ticket verdict couldn't be read \(.+\)\.$/
      ),
    ]);
  });

  it('passes a COMPLETE verdict, deviations and all', () => {
    expect(
      describeRefusal(TICKET, {
        kind: 'found',
        verdict: verdict({ deviations: ['The suite the ticket named moved.'] }),
      })
    ).toBeNull();
  });
});

describe('hasDesignSection', () => {
  it.each([
    ['## Design', true],
    ['## Design   ', true],
    ['## Designer notes', false],
    ['### Design', false],
    ['## Design reference (checked when ticket 5 is built)', false],
  ])('%j → %s', (heading, expected) => {
    expect(hasDesignSection(`# Trail map\n\n${heading}\n\nText.\n`)).toBe(
      expected
    );
  });
});

const DESIGN = [
  '# Trail map',
  '',
  '## Design',
  '',
  '### Trail map — Trail closed',
  '',
  '![Trail map — Trail closed](trail-closed.png)',
  '',
  'Scenario: trail-map-closed',
  '',
  '1. Show the detour',
  '',
].join('\n');

const NO_SCENARIO = DESIGN.replace('Scenario: trail-map-closed\n', '');

const visualVerdict = (
  result: VisualVerdict['result'] = 'MATCH'
): VisualVerdict => ({
  ticketId: 'PAWNEE-5',
  result,
  rounds: 4,
  issues: [],
  recordedAt: '2026-10-23T10:00:00.000Z',
});

/** `lambda ship` against fake tickets: the codebase's ship command is recorded, never run. */
const shipGate = async (options: {
  description?: string;
  record?: VisualVerdict | 'unreadable' | null;
  off?: boolean;
  shot?: boolean;
  getFails?: boolean;
  checkTicket?: boolean;
}) => {
  const root = project({
    commands: {
      ship: 'ship-it {spec}',
      ...(options.shot === false ? {} : { shot: 'photograph {id} {out}' }),
    },
  });

  if (options.off === true) {
    fs.mkdirSync(path.join(root, '.lambda', 'building'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.lambda', 'building', 'workflow.json'),
      JSON.stringify({ extends: 'standard', off: ['visual-check'] })
    );
  }

  if (options.checkTicket !== false) {
    recordVerdict(root, verdict({ ticketId: 'PAWNEE-5' }));
  }

  if (options.record === 'unreadable') {
    fs.writeFileSync(
      path.join(ensureVerdictsDir(root), 'PAWNEE-5.visual.json'),
      '{"result": "MAT'
    );
  } else if (options.record !== undefined && options.record !== null) {
    writeVisualVerdict(root, options.record);
  }

  const source = fakeSource([
    {
      ...ticket('PAWNEE-5', { title: 'Trail map', status: 'building' }),
      description: options.description ?? DESIGN,
    },
  ]);
  const tickets: TicketSource =
    options.getFails === true
      ? {
          ...source,
          get: async () => {
            throw new Error('Linear answered 500');
          },
        }
      : source;
  const config = ProjectConfigSchema.parse(
    JSON.parse(fs.readFileSync(path.join(root, 'lambda.json'), 'utf8'))
  );
  const shipProject: Project = {
    root,
    file: path.join(root, 'lambda.json'),
    config,
  };
  const shell: string[] = [];
  const err: string[] = [];
  const code = await runShip('PAWNEE-5', {
    project: shipProject,
    tickets,
    env: { LAMBDA_PODS_ROOT: path.join(root, '.lambda', 'pods') },
    runShell: async (command) => {
      shell.splice(shell.length, 0, command);

      return 0;
    },
    print: () => undefined,
    printError: (line) => {
      err.splice(err.length, 0, line);
    },
    now: () => '2026-10-23T10:00:00.000Z',
  });

  return { code, shell, err };
};

describe("the ship gate's visual check", () => {
  it('refuses a design ticket with no visual record, in exactly these words', async () => {
    const { code, shell, err } = await shipGate({ record: null });

    expect(code).toBe(1);
    expect(shell).toEqual([]);
    expect(err).toEqual([
      '✗ PAWNEE-5 Trail map has a design but no visual check.',
      '  Run the visual-check step first.',
    ]);
  });

  it('refuses an unreadable record, naming why', async () => {
    const { code, shell, err } = await shipGate({ record: 'unreadable' });

    expect(code).toBe(1);
    expect(shell).toEqual([]);
    expect(err).toEqual([
      expect.stringMatching(
        /^✗ PAWNEE-5 Trail map: the visual check record couldn't be read \(.+\)\.$/
      ),
    ]);
  });

  it('refuses a BLOCKED record', async () => {
    const { code, shell, err } = await shipGate({
      record: visualVerdict('BLOCKED'),
    });

    expect(code).toBe(1);
    expect(shell).toEqual([]);
    expect(err).toEqual(["✗ PAWNEE-5 Trail map's visual check is blocked."]);
  });

  it.each([
    ['SHIPPED_WITH_MISSES', { record: visualVerdict('SHIPPED_WITH_MISSES') }],
    ['MATCH', { record: visualVerdict('MATCH') }],
    [
      'a ticket without ## Design',
      { record: null, description: '# Trail map\n\nNo pictures.\n' },
    ],
    [
      'a ## Design with no Scenario: line',
      { record: null, description: NO_SCENARIO },
    ],
    ['the step switched off', { record: null, off: true }],
    ['no commands.shot', { record: null, shot: false }],
  ])('passes %s', async (_, options) => {
    const { code, shell, err } = await shipGate(options);

    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(shell).toEqual(["ship-it 'PAWNEE-5'"]);
  });

  it('refuses when the ticket can’t be read, never taking it as "no design"', async () => {
    const { code, shell, err } = await shipGate({
      record: null,
      getFails: true,
    });

    expect(code).toBe(1);
    expect(shell).toEqual([]);
    expect(err).toEqual([
      "✗ PAWNEE-5: the ticket couldn't be read (Linear answered 500).",
    ]);
  });

  it('lists every refusal at once, and runs nothing', async () => {
    const { code, shell, err } = await shipGate({
      record: null,
      checkTicket: false,
    });

    expect(code).toBe(1);
    expect(shell).toEqual([]);
    expect(err).toEqual([
      '✗ PAWNEE-5 Trail map has no COMPLETE check-ticket verdict.',
      '  Run the check-ticket step first.',
      '✗ PAWNEE-5 Trail map has a design but no visual check.',
      '  Run the visual-check step first.',
    ]);
  });
});

describe('the verdict store', () => {
  it('is .lambda/verdicts by default, with a `*` .gitignore written first', () => {
    const root = project();
    const dir = ensureVerdictsDir(root);

    expect(dir).toBe(path.join(root, '.lambda', 'verdicts'));
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('reads a missing verdict as missing', () => {
    expect(readVerdict(project(), '3')).toEqual({ kind: 'missing' });
  });

  it('ignores extra fields another tool wrote', () => {
    const root = project();
    fs.writeFileSync(
      path.join(ensureVerdictsDir(root), '3.json'),
      JSON.stringify({
        ...verdict(),
        reviewer: { name: 'Ron Swanson', tool: 'a desk checklist' },
        rushed: false,
      })
    );

    expect(readVerdict(root, '3')).toEqual({
      kind: 'found',
      verdict: verdict(),
    });
  });

  it("reads another ticket's verdict, copied under this one's name, as unreadable", () => {
    const root = project();
    fs.writeFileSync(
      path.join(ensureVerdictsDir(root), '3.json'),
      JSON.stringify(verdict({ ticketId: '4' }))
    );

    expect(readVerdict(root, '3')).toEqual({
      kind: 'unreadable',
      reason: 'the verdict is for 4, not 3',
    });
  });

  it('uses lambda.json verdicts.dir', () => {
    const root = project({ verdicts: { dir: 'checks' } });

    expect(verdictsDir(root)).toBe(path.join(root, 'checks'));
    recordVerdict(root, verdict());

    expect(fs.existsSync(path.join(root, 'checks', '3.json'))).toBe(true);
    expect(
      fs.readFileSync(path.join(root, 'checks', '.gitignore'), 'utf8')
    ).toBe('*\n');
    expect(fs.existsSync(path.join(root, '.lambda', 'verdicts'))).toBe(false);
  });

  it('refuses a verdicts.dir outside the project, naming it', () => {
    expect(() => verdictsDir(project({ verdicts: { dir: '../x' } }))).toThrow(
      /verdicts\.dir/
    );
  });

  it('refuses the project root as verdicts.dir, writing no .gitignore there', () => {
    const root = project({ verdicts: { dir: '.' } });

    expect(() => recordVerdict(root, verdict())).toThrow(
      /verdicts\.dir "\." is the project root/
    );
    expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(false);
    expect(fs.existsSync(path.join(root, '3.json'))).toBe(false);
  });

  it("refuses a folder of the codebase's own as verdicts.dir, leaving it untouched", () => {
    const root = project({ verdicts: { dir: 'src' } });
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};\n');

    expect(() => recordVerdict(root, verdict())).toThrow(
      /verdicts\.dir "src" already holds files Lambda didn't write \(index\.ts\)/
    );
    expect(fs.readdirSync(path.join(root, 'src'))).toEqual(['index.ts']);
  });

  it('refuses a verdicts folder whose .gitignore is not its own', () => {
    const root = project({ verdicts: { dir: 'checks' } });
    fs.mkdirSync(path.join(root, 'checks'));
    fs.writeFileSync(path.join(root, 'checks', '.gitignore'), 'node_modules\n');

    expect(() => recordVerdict(root, verdict())).toThrow(
      /verdicts\.dir "checks" already holds files Lambda didn't write \(\.gitignore\)/
    );
  });

  it("takes a folder holding only a visual check's photos, shot before its first round was recorded", () => {
    const root = project();
    const photos = path.join(
      root,
      '.lambda',
      'verdicts',
      'PAWNEE-5.visual',
      'round-1'
    );
    fs.mkdirSync(photos, { recursive: true });
    fs.writeFileSync(path.join(photos, 'trail-closed.png'), 'png');

    expect(() => ensureVerdictsDir(root)).not.toThrow();
    expect(
      fs.readFileSync(
        path.join(root, '.lambda', 'verdicts', '.gitignore'),
        'utf8'
      )
    ).toBe('*\n');
  });

  it('keeps using a verdicts folder it made', () => {
    const root = project();
    recordVerdict(root, verdict());

    expect(() => recordVerdict(root, verdict({ ticketId: '4' }))).not.toThrow();
  });

  it('keeps using a folder with a `*` .gitignore whatever else is in it', () => {
    const root = project({ verdicts: { dir: 'checks' } });
    fs.mkdirSync(path.join(root, 'checks', 'visual'), { recursive: true });
    fs.writeFileSync(path.join(root, 'checks', '.gitignore'), '*');
    fs.writeFileSync(path.join(root, 'checks', 'visual', '3.png'), 'png');

    expect(() => recordVerdict(root, verdict())).not.toThrow();
    expect(fs.existsSync(path.join(root, 'checks', '3.json'))).toBe(true);
  });
});

describe('lambda verdict record and show', () => {
  it('records, and the latest verdict wins', async () => {
    const root = project();
    const { exitCode, out } = cli(root);

    expect(await exitCode('record', '3', '--complete')).toBe(0);
    expect(
      await exitCode('record', '3', '--incomplete', '--failed', 'Test Plan')
    ).toBe(0);

    const stored: unknown = JSON.parse(
      fs.readFileSync(path.join(root, '.lambda', 'verdicts', '3.json'), 'utf8')
    );
    expect(stored).toMatchObject({
      ticketId: '3',
      verdict: 'INCOMPLETE',
      failedDimensions: ['Test Plan'],
    });
    expect(
      fs.readFileSync(
        path.join(root, '.lambda', 'verdicts', '.gitignore'),
        'utf8'
      )
    ).toBe('*\n');

    expect(await exitCode('show', '3')).toBe(0);
    expect(out.join('\n')).toContain('"verdict": "INCOMPLETE"');
  });

  it('keeps deviations, one per --deviation', async () => {
    const root = project();
    const { exitCode } = cli(root);

    await exitCode(
      'record',
      '3',
      '--complete',
      '--deviation',
      'The suite moved, so it runs in a.test.ts, b.test.ts',
      '--deviation',
      'A second note'
    );

    expect(readVerdict(root, '3')).toMatchObject({
      kind: 'found',
      verdict: {
        deviations: [
          'The suite moved, so it runs in a.test.ts, b.test.ts',
          'A second note',
        ],
      },
    });
  });

  it('refuses both flags, and neither, writing nothing', async () => {
    const root = project();
    const { exitCode, err } = cli(root);

    expect(await exitCode('record', '3', '--complete', '--incomplete')).toBe(1);
    expect(await exitCode('record', '3')).toBe(1);
    expect(err.join('\n')).toContain('--complete or --incomplete');
    expect(
      fs.existsSync(path.join(root, '.lambda', 'verdicts', '3.json'))
    ).toBe(false);
  });

  it('writes and reads lambda.json verdicts.dir', async () => {
    const root = project({ verdicts: { dir: 'checks' } });
    const { exitCode, out } = cli(root);

    expect(await exitCode('record', '3', '--complete')).toBe(0);
    expect(fs.existsSync(path.join(root, 'checks', '3.json'))).toBe(true);
    expect(await exitCode('show', '3')).toBe(0);
    expect(out.join('\n')).toContain('"verdict": "COMPLETE"');
  });

  it('show exits 1 for a ticket with no verdict', async () => {
    const { exitCode, err } = cli(project());

    expect(await exitCode('show', '9')).toBe(1);
    expect(err.join('\n')).toContain('No verdict recorded for 9');
  });
});
