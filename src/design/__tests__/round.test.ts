import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as designLoop from '../loop';
import { archiveDesignRounds, recordDesignRound } from '../round';

// The stop helper is real unless a test overrides it, which is how the
// separate round-8 cap in recordDesignRound is proven.
jest.mock('../loop', () => {
  const actual = jest.requireActual<typeof designLoop>('../loop');

  return {
    ...actual,
    shouldStopDesignLoop: jest.fn(actual.shouldStopDesignLoop),
  };
});

const tmp = (prefix: string): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

const judge = (severities: designLoop.DesignSeverity[]): string => {
  const file = path.join(tmp('lambda-design-judge-'), 'judge.json');
  fs.writeFileSync(
    file,
    `\`\`\`json\n${JSON.stringify({
      issues: severities.map((severity, i) => ({
        severity,
        where: `Step ${i + 1}`,
        what: `Leslie Knope's trail marker issue ${i + 1}`,
      })),
    })}\n\`\`\``
  );

  return file;
};

const readLines = (screenDir: string): unknown[] =>
  fs
    .readFileSync(path.join(screenDir, 'rounds.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line));

describe('recordDesignRound', () => {
  const saved = process.env.LAMBDA_PODS_ROOT;
  const dirs = { pods: '', screen: '' };

  beforeEach(() => {
    dirs.pods = tmp('lambda-design-pods-');
    process.env.LAMBDA_PODS_ROOT = dirs.pods;
    dirs.screen = path.join(dirs.pods, 'pawnee-trails', 'designs', 'trail-map');
    fs.mkdirSync(dirs.screen, { recursive: true });
  });

  afterEach(() => {
    jest
      .mocked(designLoop.shouldStopDesignLoop)
      .mockImplementation(
        jest.requireActual<typeof designLoop>('../loop').shouldStopDesignLoop
      );
  });

  afterAll(() => {
    if (saved === undefined) {
      delete process.env.LAMBDA_PODS_ROOT;
    } else {
      process.env.LAMBDA_PODS_ROOT = saved;
    }
  });

  const record = (file: string): ReturnType<typeof recordDesignRound> =>
    recordDesignRound({ screenDir: dirs.screen, judgeFile: file });

  it('records high → medium-low ×3: continue ×3, then stop at round 4', () => {
    const outcomes = [
      record(judge(['high'])),
      record(judge(['medium-low', 'low'])),
      record(judge(['medium-low'])),
      record(judge(['medium-low'])),
    ];

    expect(outcomes.map(({ line }) => line)).toEqual([
      'CONTINUE',
      'CONTINUE',
      'CONTINUE',
      'STOP round-4-medium-low',
    ]);

    const lines = readLines(dirs.screen);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({
      round: 1,
      issues: [
        {
          severity: 'high',
          where: 'Step 1',
          what: "Leslie Knope's trail marker issue 1",
        },
      ],
      decision: { stop: false, reason: null },
    });
    expect(lines[3]).toMatchObject({
      round: 4,
      decision: { stop: true, reason: 'round-4-medium-low' },
    });
    lines.forEach((line) => {
      expect(line).not.toHaveProperty('situation');
      expect(line).toHaveProperty('at', expect.stringMatching(/^\d{4}-.*Z$/));
    });
  });

  it('stops on a round-1 judge with only low issues', () => {
    expect(record(judge(['low'])).line).toBe('STOP only-low');
  });

  it('continues on a round-1 medium-low (no early stop)', () => {
    expect(record(judge(['medium-low'])).line).toBe('CONTINUE');
  });

  it('works the round out from rounds.jsonl, not from the caller', () => {
    record(judge(['high']));
    record(judge(['high']));
    expect(record(judge(['high'])).round).toBe(3);
  });

  it('refuses round 8 even when the stop helper says continue', () => {
    jest
      .mocked(designLoop.shouldStopDesignLoop)
      .mockReturnValue({ stop: false, reason: null });
    Array.from({ length: 7 }).forEach(() => record(judge(['high'])));
    const before = fs.readFileSync(path.join(dirs.screen, 'rounds.jsonl'));

    expect(() => record(judge(['high']))).toThrow(/round 8/i);
    expect(
      fs.readFileSync(path.join(dirs.screen, 'rounds.jsonl')).equals(before)
    ).toBe(true);
  });

  it('refuses a screen dir that is a symlink out of the pod designs/, writing nothing', () => {
    const outside = tmp('lambda-design-outside-');
    const link = path.join(dirs.pods, 'pawnee-trails', 'designs', 'escape');
    fs.symlinkSync(outside, link);

    expect(() =>
      recordDesignRound({ screenDir: link, judgeFile: judge(['low']) })
    ).toThrow(/designs/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it.each([
    ['not under designs/', ['pawnee-trails', 'notes', 'trail-map']],
    ['a bad pod id', ['Pawnee_Trails', 'designs', 'trail-map']],
    ['a bad screen slug', ['pawnee-trails', 'designs', 'Trail Map']],
  ])('refuses a screen dir %s', (_label, parts) => {
    const dir = path.join(dirs.pods, ...parts);
    fs.mkdirSync(dir, { recursive: true });

    expect(() =>
      recordDesignRound({ screenDir: dir, judgeFile: judge(['low']) })
    ).toThrow();
    expect(fs.existsSync(path.join(dir, 'rounds.jsonl'))).toBe(false);
  });

  it('refuses after a line that already says stop, leaving the file unchanged', () => {
    record(judge(['low']));
    const before = fs.readFileSync(path.join(dirs.screen, 'rounds.jsonl'));

    expect(() => record(judge(['high']))).toThrow(/stop/i);
    expect(
      fs.readFileSync(path.join(dirs.screen, 'rounds.jsonl')).equals(before)
    ).toBe(true);
  });

  it('names the stop reason when refusing, and no dangling space when it has none', () => {
    record(judge(['low']));
    expect(() => record(judge(['high']))).toThrow(
      /^Round 1 already said STOP only-low: /
    );

    fs.writeFileSync(
      path.join(dirs.screen, 'rounds.jsonl'),
      `${JSON.stringify({
        round: 1,
        at: '2026-10-19T20:00:00.000Z',
        issues: [],
        decision: { stop: true, reason: 'ron-swanson-said-so' },
      })}\n`
    );
    expect(() => record(judge(['high']))).toThrow(
      /^Round 1 already said STOP: /
    );
  });

  it('refuses judge JSON that parseJudgeVerdict refuses, writing nothing', () => {
    const file = path.join(tmp('lambda-design-judge-'), 'judge.json');
    fs.writeFileSync(
      file,
      '{"issues":[{"severity":"Med","where":"x","what":"y"}]}'
    );

    expect(() => record(file)).toThrow(/severity/);
    expect(fs.existsSync(path.join(dirs.screen, 'rounds.jsonl'))).toBe(false);
  });

  it('refuses an unparseable line already in rounds.jsonl, naming its number', () => {
    const file = path.join(dirs.screen, 'rounds.jsonl');
    const good = JSON.stringify({
      round: 1,
      at: '2026-10-19T20:00:00.000Z',
      issues: [],
      decision: { stop: false, reason: null },
    });
    fs.writeFileSync(file, `${good}\n{not json\n`);
    const before = fs.readFileSync(file);

    expect(() => record(judge(['high']))).toThrow(/line 2/);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('a re-design moves rounds.jsonl and walk/ aside, so it gets its own rounds and cap', () => {
    record(judge(['low']));
    fs.mkdirSync(path.join(dirs.screen, 'walk', 'round-1'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(dirs.screen, 'walk', 'round-1', 'step-1.png'),
      'png'
    );

    const moved = archiveDesignRounds({
      screenDir: dirs.screen,
      now: () => new Date('2026-10-19T21:30:00.000Z'),
    });

    expect(moved.sort()).toEqual([
      'rounds.2026-10-19T21-30-00-000Z.jsonl',
      'walk.2026-10-19T21-30-00-000Z',
    ]);
    expect(fs.existsSync(path.join(dirs.screen, 'rounds.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(dirs.screen, 'walk'))).toBe(false);
    expect(
      fs.existsSync(
        path.join(
          dirs.screen,
          'walk.2026-10-19T21-30-00-000Z',
          'round-1',
          'step-1.png'
        )
      )
    ).toBe(true);
    // The finished design no longer blocks round 1 of the new one.
    expect(record(judge(['high']))).toMatchObject({ round: 1 });
  });

  it('a re-design with nothing to move moves nothing', () => {
    expect(archiveDesignRounds({ screenDir: dirs.screen })).toEqual([]);
  });

  it('a re-design refuses a screen dir outside the pod designs/', () => {
    const outside = tmp('lambda-design-outside-');
    fs.writeFileSync(path.join(outside, 'rounds.jsonl'), '');

    expect(() => archiveDesignRounds({ screenDir: outside })).toThrow(
      /designs/
    );
    expect(fs.existsSync(path.join(outside, 'rounds.jsonl'))).toBe(true);
  });
});
