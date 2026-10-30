import { execFileSync } from 'child_process';
import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type DesignIssue } from '../../design/loop';
import * as podContext from '../../pod/context';
import {
  type VisualRecordCommandDeps,
  loadVisualDeps,
  registerVerdictCommand,
} from '../index';
import { recordVisualRound } from '../visualRecord';
import { type VisualVerdict, readVisualVerdict } from '../visualStore';

/**
 * `lambda verdict visual record`: one round of the build's visual check,
 * decided for the whole set of the ticket's pictures: the record itself, the
 * ids it accepts, the folder it writes to and its containment rules.
 */

const T = 'PAWNEE-5';
const CLOSED = 'trail-closed';
const HOME = 'trail-open';
const AT = '2026-10-19T12:00:00.000Z';
const SHA = 'abc123';

const repo = { root: '' };

const issue = (severity: DesignIssue['severity']): DesignIssue => ({
  severity,
  where: 'Detour button',
  what: `${severity} difference`,
});

const verdictsFolder = (): string =>
  path.join(repo.root, '.lambda', 'verdicts');
const visualDir = (ticketId = T): string =>
  path.join(verdictsFolder(), `${ticketId}.visual`);
const roundsPath = (ticketId = T): string =>
  path.join(visualDir(ticketId), 'rounds.json');
const recordPath = (ticketId = T): string =>
  path.join(verdictsFolder(), `${ticketId}.visual.json`);

/** A picture whose expected and actual PNGs exist in the checkout. */
const picture = (scenarioId: string, issues: DesignIssue[], ticketId = T) => {
  const expected = `.lambda/pulled/${ticketId}/${scenarioId}.png`;
  const actual = `.lambda/verdicts/${ticketId}.visual/round-x/${scenarioId}.png`;

  [expected, actual].forEach((file) => {
    fs.mkdirSync(path.dirname(path.join(repo.root, file)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(repo.root, file), 'png');
  });

  return {
    scenarioId,
    situation: `Trail map — ${scenarioId}`,
    expected,
    actual,
    issues,
  };
};

const roundFile = (pictures: unknown[]): string => {
  const file = path.join(repo.root, 'round.json');
  fs.writeFileSync(file, JSON.stringify({ pictures }));

  return file;
};

/** Rounds 1…n already recorded with a CONTINUE decision. */
const seedRounds = (n: number, ids = [CLOSED]): void => {
  fs.mkdirSync(visualDir(), { recursive: true });
  fs.writeFileSync(path.join(verdictsFolder(), '.gitignore'), '*\n');
  fs.writeFileSync(
    roundsPath(),
    JSON.stringify(
      Array.from({ length: n }, (_, index) => ({
        round: index + 1,
        at: AT,
        pictures: ids.map((scenarioId) => ({ scenarioId })),
        decision: { stop: false, reason: null },
      }))
    )
  );
};

const postMisses = jest.fn(async (_verdict: VisualVerdict) => undefined);
const warn = jest.fn();
const deps = () => ({
  projectRoot: repo.root,
  now: () => new Date(AT),
  headSha: () => SHA,
  postMisses,
  warn,
});

beforeEach(() => {
  repo.root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-visual-record-'))
  );
  fs.writeFileSync(
    path.join(repo.root, 'lambda.json'),
    JSON.stringify({ name: 'Pawnee Parks app' })
  );
  postMisses.mockReset();
  postMisses.mockResolvedValue(undefined);
  warn.mockReset();
});

afterEach(() => {
  fs.rmSync(repo.root, { recursive: true, force: true });
});

describe('lambda verdict visual record: the decision', () => {
  it('a medium issue at round 2 → CONTINUE, its pictures named, no final record', async () => {
    seedRounds(1);

    const result = await recordVisualRound(
      T,
      roundFile([picture(CLOSED, [issue('medium')])]),
      deps()
    );

    expect(result.round).toBe(2);
    expect(result.lines).toEqual([
      `VISUAL: CONTINUE (round 2) — fix: ${CLOSED}`,
      `Expected: .lambda/pulled/${T}/${CLOSED}.png, actual: .lambda/verdicts/${T}.visual/round-x/${CLOSED}.png`,
    ]);
    expect(fs.existsSync(recordPath())).toBe(false);
    expect(JSON.parse(fs.readFileSync(roundsPath(), 'utf8'))).toHaveLength(2);
  });

  it('a high issue at round 7 → BLOCKED, the record path on its own line, no misses comment', async () => {
    seedRounds(6);

    const result = await recordVisualRound(
      T,
      roundFile([picture(CLOSED, [issue('high')])]),
      deps()
    );

    expect(result.verdict?.result).toBe('BLOCKED');
    expect(result.lines).toEqual([
      `VISUAL: BLOCKED (round 7) — high issue left: ${CLOSED}`,
      `   ${recordPath()}`,
    ]);
    expect(postMisses).not.toHaveBeenCalled();
  });

  it('only a low issue at round 1 → MATCH, and no comment', async () => {
    const result = await recordVisualRound(
      T,
      roundFile([picture(CLOSED, [issue('low')])]),
      deps()
    );

    expect(result.verdict).toMatchObject({
      ticketId: T,
      result: 'MATCH',
      rounds: 1,
      headSha: SHA,
    });
    expect(result.lines).toEqual([
      'VISUAL: MATCH (round 1)',
      `   ${recordPath()}`,
    ]);
    expect(postMisses).not.toHaveBeenCalled();
    expect(readVisualVerdict(repo.root, T)).toMatchObject({
      state: 'found',
      verdict: { result: 'MATCH' },
    });
  });

  it('one set: a medium-low on one picture at round 2 continues both, and round 3 must name both', async () => {
    seedRounds(1, [CLOSED, HOME]);

    const second = await recordVisualRound(
      T,
      roundFile([
        picture(CLOSED, [issue('low')]),
        picture(HOME, [issue('medium-low')]),
      ]),
      deps()
    );

    expect(second.lines[0]).toBe(
      `VISUAL: CONTINUE (round 2) — fix: ${CLOSED}, ${HOME}`
    );

    const before = fs.readFileSync(roundsPath(), 'utf8');

    await expect(
      recordVisualRound(T, roundFile([picture(HOME, [])]), deps())
    ).rejects.toThrow(/same set/);
    expect(fs.readFileSync(roundsPath(), 'utf8')).toBe(before);
  });

  it('two pictures at round 4, worst low and medium-low → the set stops SHIPPED_WITH_MISSES', async () => {
    seedRounds(3, [CLOSED, HOME]);

    const result = await recordVisualRound(
      T,
      roundFile([
        picture(CLOSED, [issue('low')]),
        picture(HOME, [issue('medium-low')]),
      ]),
      deps()
    );

    expect(result.verdict?.result).toBe('SHIPPED_WITH_MISSES');
    expect(result.lines).toEqual([
      `VISUAL: SHIPPED_WITH_MISSES (round 4) — 1 issue left: ${HOME}`,
      `   ${recordPath()}`,
    ]);
  });

  it("the final record's issues carry their picture and situation, worst first", async () => {
    seedRounds(3);

    const result = await recordVisualRound(
      T,
      roundFile([
        picture(CLOSED, [issue('low'), issue('medium-low'), issue('low')]),
      ]),
      deps()
    );

    expect(result.verdict?.issues.map(({ severity }) => severity)).toEqual([
      'medium-low',
      'low',
      'low',
    ]);
    expect(result.verdict?.issues[0]).toEqual({
      ...issue('medium-low'),
      scenarioId: CLOSED,
      situation: `Trail map — ${CLOSED}`,
      expected: `.lambda/pulled/${T}/${CLOSED}.png`,
      actual: `.lambda/verdicts/${T}.visual/round-x/${CLOSED}.png`,
    });
  });

  it('a medium left at round 7 → SHIPPED_WITH_MISSES, the comment posted once with the record', async () => {
    seedRounds(6);

    const result = await recordVisualRound(
      T,
      roundFile([picture(CLOSED, [issue('medium')])]),
      deps()
    );

    expect(result.lines[0]).toBe(
      `VISUAL: SHIPPED_WITH_MISSES (round 7) — 1 issue left: ${CLOSED}`
    );
    expect(postMisses).toHaveBeenCalledTimes(1);
    expect(postMisses).toHaveBeenCalledWith(result.verdict);
  });

  it('a medium at round 4 continues', async () => {
    seedRounds(3);

    const result = await recordVisualRound(
      T,
      roundFile([picture(CLOSED, [issue('medium')])]),
      deps()
    );

    expect(result.lines[0]).toBe(`VISUAL: CONTINUE (round 4) — fix: ${CLOSED}`);
  });

  it('a rejected post still leaves the record written', async () => {
    seedRounds(6);
    postMisses.mockRejectedValueOnce(new Error('the tracker is down'));

    await recordVisualRound(
      T,
      roundFile([picture(CLOSED, [issue('medium')])]),
      deps()
    );

    expect(JSON.parse(fs.readFileSync(recordPath(), 'utf8')).result).toBe(
      'SHIPPED_WITH_MISSES'
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('the tracker is down')
    );
  });

  it('copies each round for the rail, and a failed copy never fails the record', async () => {
    const copied: number[] = [];

    await recordVisualRound(T, roundFile([picture(CLOSED, [issue('medium')])]), {
      ...deps(),
      copyRound: (_ticket, record) => {
        copied.splice(copied.length, 0, record.round);
      },
    });
    const second = await recordVisualRound(
      T,
      roundFile([picture(CLOSED, [issue('medium')])]),
      {
        ...deps(),
        copyRound: () => {
          throw new Error('disk full');
        },
      }
    );

    expect(copied).toEqual([1]);
    expect(second.round).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  });
});

describe('lambda verdict visual record: refusals', () => {
  it('refuses round 8, leaving rounds.json byte-identical', async () => {
    seedRounds(7);
    const before = fs.readFileSync(roundsPath(), 'utf8');

    await expect(
      recordVisualRound(T, roundFile([picture(CLOSED, [])]), deps())
    ).rejects.toThrow(/round 8/);
    expect(fs.readFileSync(roundsPath(), 'utf8')).toBe(before);
  });

  it.each([
    [
      'a scenarioId of ../x',
      () => [{ ...picture(CLOSED, []), scenarioId: '../x' }],
    ],
    [
      'severity "High"',
      () => [
        {
          ...picture(CLOSED, []),
          issues: [{ ...issue('high'), severity: 'High' }],
        },
      ],
    ],
    [
      'a missing actual',
      () => [
        { ...picture(CLOSED, []), actual: '.lambda/verdicts/nope/missing.png' },
      ],
    ],
    [
      'an expected of /etc/passwd',
      () => [{ ...picture(CLOSED, []), expected: '/etc/passwd' }],
    ],
    [
      'an expected of ../../outside.png',
      () => [{ ...picture(CLOSED, []), expected: '../../outside.png' }],
    ],
    [
      'a scenarioId twice in one round',
      () => [picture(CLOSED, []), picture(CLOSED, [])],
    ],
    ['an empty pictures list', () => []],
    ['an empty situation', () => [{ ...picture(CLOSED, []), situation: '  ' }]],
  ])('refuses %s, writing nothing', async (_label, pictures) => {
    seedRounds(1);
    const before = fs.readFileSync(roundsPath(), 'utf8');

    await expect(
      recordVisualRound(T, roundFile(pictures()), deps())
    ).rejects.toThrow();
    expect(fs.readFileSync(roundsPath(), 'utf8')).toBe(before);
    expect(fs.existsSync(recordPath())).toBe(false);
  });

  it('refuses a symlink that leads out of the checkout', async () => {
    seedRounds(1);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.png'), 'png');
    fs.symlinkSync(
      path.join(outside, 'secret.png'),
      path.join(repo.root, 'link.png')
    );

    await expect(
      recordVisualRound(
        T,
        roundFile([{ ...picture(CLOSED, []), expected: 'link.png' }]),
        deps()
      )
    ).rejects.toThrow(/inside the checkout/);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('refuses ticket id PAWNEE-1/../x, writing nothing', async () => {
    const file = roundFile([picture(CLOSED, [])]);
    const before = fs.readdirSync(verdictsFolder());

    await expect(
      recordVisualRound('PAWNEE-1/../x', file, deps())
    ).rejects.toThrow(/isn't a ticket id/);
    expect(fs.readdirSync(verdictsFolder())).toEqual(before);
  });

  it('refuses a round after one that stopped but left no final record', async () => {
    fs.mkdirSync(visualDir(), { recursive: true });
    fs.writeFileSync(
      roundsPath(),
      JSON.stringify([
        {
          round: 1,
          at: AT,
          pictures: [{ scenarioId: CLOSED }],
          decision: { stop: true, reason: 'only-low' },
        },
      ])
    );

    await expect(
      recordVisualRound(T, roundFile([picture(CLOSED, [])]), deps())
    ).rejects.toThrow(/already stopped the loop/);
  });

  it('refuses a rounds.json entry without a boolean decision.stop', async () => {
    fs.mkdirSync(visualDir(), { recursive: true });
    fs.writeFileSync(
      roundsPath(),
      JSON.stringify([
        { round: 1, at: AT, pictures: [], decision: { stop: 'no' } },
      ])
    );

    await expect(
      recordVisualRound(T, roundFile([picture(CLOSED, [])]), deps())
    ).rejects.toThrow(/is not a round record/);
  });
});

describe('lambda verdict visual record: a new loop', () => {
  it('after a final MATCH: old rounds archived by recordedAt, this is round 1', async () => {
    await recordVisualRound(T, roundFile([picture(CLOSED, [])]), {
      ...deps(),
      now: () => new Date('2026-10-18T09:30:00.000Z'),
    });
    expect(fs.existsSync(recordPath())).toBe(true);

    const result = await recordVisualRound(
      T,
      roundFile([picture(HOME, [issue('medium')])]),
      deps()
    );

    expect(result.round).toBe(1);
    expect(result.lines[0]).toMatch(/^VISUAL: CONTINUE \(round 1\)/);
    expect(fs.existsSync(recordPath())).toBe(false);
    expect(
      fs.existsSync(
        path.join(visualDir(), 'rounds.2026-10-18T09-30-00-000Z.json')
      )
    ).toBe(true);
    expect(JSON.parse(fs.readFileSync(roundsPath(), 'utf8'))).toHaveLength(1);
  });

  it('after an unreadable record: archived with the time now, this is round 1', async () => {
    seedRounds(2);
    fs.writeFileSync(recordPath(), '{"result": "MAT');

    const result = await recordVisualRound(
      T,
      roundFile([picture(CLOSED, [issue('medium')])]),
      deps()
    );

    expect(result.round).toBe(1);
    expect(
      fs.existsSync(
        path.join(visualDir(), 'rounds.2026-10-19T12-00-00-000Z.json')
      )
    ).toBe(true);
    expect(fs.existsSync(recordPath())).toBe(false);
  });

  it('refuses when the archive name is already taken', async () => {
    seedRounds(2);
    fs.writeFileSync(recordPath(), '{"result": "MAT');
    fs.writeFileSync(
      path.join(visualDir(), 'rounds.2026-10-19T12-00-00-000Z.json'),
      '[]'
    );
    const before = fs.readFileSync(roundsPath(), 'utf8');

    await expect(
      recordVisualRound(T, roundFile([picture(CLOSED, [])]), deps())
    ).rejects.toThrow(/already exists/);
    expect(fs.readFileSync(roundsPath(), 'utf8')).toBe(before);
    expect(fs.existsSync(recordPath())).toBe(true);
  });
});

describe('a final record read back', () => {
  const plant = (overrides: Record<string, string>) => {
    fs.mkdirSync(verdictsFolder(), { recursive: true });
    fs.writeFileSync(
      recordPath(),
      JSON.stringify({
        ticketId: T,
        result: 'BLOCKED',
        rounds: 7,
        recordedAt: AT,
        issues: [
          {
            ...issue('high'),
            scenarioId: CLOSED,
            situation: 'Trail map — trail closed',
            expected: `.lambda/pulled/${T}/${CLOSED}.png`,
            actual: `.lambda/verdicts/${T}.visual/round-7/${CLOSED}.png`,
            ...overrides,
          },
        ],
      })
    );
  };

  it('is found when every path field stays inside its folder', () => {
    plant({});

    expect(readVisualVerdict(repo.root, T).state).toBe('found');
  });

  // Its fields become paths (composites, attachments, the pod's copy), so a
  // planted or corrupted record must refuse rather than lead out of them.
  it.each([
    ['a scenarioId of ../../x', { scenarioId: '../../x' }, 'scenarioId'],
    ['an absolute expected', { expected: '/etc/passwd' }, 'expected'],
    [
      'an expected of ../../outside.png',
      { expected: '../../outside.png' },
      'expected',
    ],
    ['an actual of ../x.png', { actual: '../x.png' }, 'actual'],
  ])('is unreadable with %s', (_label, overrides, field) => {
    plant(overrides);

    const lookup = readVisualVerdict(repo.root, T);

    expect(lookup.state).toBe('unreadable');
    expect(lookup.state === 'unreadable' && lookup.reason).toContain(field);
  });
});

describe('lambda verdict visual record: ticket ids', () => {
  it.each(['PAWNEE-5', 'PAWNEE-1c', 'PARK-12'])('accepts %s', async (id) => {
    const result = await recordVisualRound(
      id,
      roundFile([picture(CLOSED, [], id)]),
      deps()
    );

    expect(result.verdict?.ticketId).toBe(id);
    expect(fs.existsSync(recordPath(id))).toBe(true);
  });

  // A case-insensitive disk (a Mac's default) holds one file for both names,
  // so "two records" is asserted as what the code controls: each id is kept
  // as given, names its own record beside its own folder, and one id's record
  // is never read as the other's.
  it('keeps pawnee-5 and PAWNEE-5 apart, each next to its own .visual folder', async () => {
    const lower = await recordVisualRound(
      'pawnee-5',
      roundFile([picture(CLOSED, [], 'pawnee-5')]),
      deps()
    );

    expect(lower.verdict?.ticketId).toBe('pawnee-5');
    expect(lower.lines[1]).toBe(`   ${recordPath('pawnee-5')}`);
    expect(path.basename(recordPath('pawnee-5'))).toBe('pawnee-5.visual.json');
    expect(path.basename(recordPath(T))).toBe('PAWNEE-5.visual.json');
    expect(fs.readdirSync(verdictsFolder())).toEqual(
      expect.arrayContaining(['pawnee-5.visual', 'pawnee-5.visual.json'])
    );
    // Never PAWNEE-5's: on a disk where the names are one file, it reads as
    // another ticket's record, which refuses, never as a pass.
    expect(readVisualVerdict(repo.root, T).state).not.toBe('found');
  });

  it('records pawnee-5 and PAWNEE-5 as two records on a case-sensitive disk', async () => {
    const probe = path.join(repo.root, 'case-probe');
    fs.writeFileSync(probe, '');
    const caseSensitive = !fs.existsSync(path.join(repo.root, 'CASE-PROBE'));

    if (!caseSensitive) {
      // One file holds both names here; the test above covers what the code controls.
      return;
    }

    await recordVisualRound(
      'pawnee-5',
      roundFile([picture(CLOSED, [], 'pawnee-5')]),
      deps()
    );
    await recordVisualRound(T, roundFile([picture(CLOSED, [], T)]), deps());

    expect(readVisualVerdict(repo.root, 'pawnee-5').state).toBe('found');
    expect(readVisualVerdict(repo.root, T).state).toBe('found');
    expect(fs.existsSync(visualDir('pawnee-5'))).toBe(true);
    expect(fs.existsSync(visualDir(T))).toBe(true);
  });
});

describe('lambda verdict visual record and git', () => {
  it("keeps every record and picture out of a default ship's git add -A", async () => {
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: repo.root, encoding: 'utf8' });
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'leslie@pawnee.gov']);
    git(['config', 'user.name', 'Leslie Knope']);
    // The expected image lives outside the verdicts folder: committed first.
    const pictures = [picture(CLOSED, [issue('low')])];
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'start']);

    await recordVisualRound(T, roundFile(pictures), deps());
    git(['add', '-A']);

    expect(
      fs.readFileSync(path.join(verdictsFolder(), '.gitignore'), 'utf8')
    ).toBe('*\n');
    expect(
      git(['status', '--porcelain'])
        .split('\n')
        .filter((line) => line.includes('.lambda/verdicts'))
    ).toEqual([]);
  });
});

describe("the lambda verdict visual record command's pod", () => {
  const saved = process.env.POD_ID;

  afterEach(() => {
    jest.restoreAllMocks();

    if (saved === undefined) {
      delete process.env.POD_ID;
    } else {
      process.env.POD_ID = saved;
    }
  });

  // The caller's pod comes from the one place that says which pod a process
  // belongs to, never a second read of the environment.
  it("copies rounds for callerPodId's pod, and none outside a pod", () => {
    delete process.env.POD_ID;
    jest.spyOn(process, 'cwd').mockReturnValue(repo.root);
    const caller = jest.spyOn(podContext, 'callerPodId');

    caller.mockReturnValue('build-a1b2');
    expect(loadVisualDeps().copyRound).toBeInstanceOf(Function);

    caller.mockReturnValue(undefined);
    expect(loadVisualDeps().copyRound).toBeUndefined();
  });
});

describe('the lambda verdict visual record command', () => {
  const run = async (args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const visualDeps: VisualRecordCommandDeps = {
      projectRoot: repo.root,
      print: (line) => {
        out.splice(out.length, 0, line);
      },
      printError: (line) => {
        err.splice(err.length, 0, line);
      },
      postMisses,
    };
    const program = new Command().exitOverride();
    registerVerdictCommand(
      program,
      () => {
        throw new Error('not the check-ticket verdict');
      },
      () => visualDeps
    );
    await program.parseAsync([
      'node',
      'lambda',
      'verdict',
      'visual',
      'record',
      ...args,
    ]);
    const code = Number(process.exitCode ?? 0);
    process.exitCode = undefined;

    return { code, out, err };
  };

  it('prints the VISUAL: lines', async () => {
    const { code, out } = await run([
      T,
      '--round',
      roundFile([picture(CLOSED, [])]),
    ]);

    expect(code).toBe(0);
    expect(out).toEqual(['VISUAL: MATCH (round 1)', `   ${recordPath()}`]);
    // The temp folder isn't a git repository: provenance is left out, never faked.
    const lookup = readVisualVerdict(repo.root, T);
    expect(lookup.state).toBe('found');
    expect(lookup.state === 'found' && lookup.verdict).not.toHaveProperty(
      'headSha'
    );
  });

  it('exits 1 on a refusal, writing nothing', async () => {
    const { code, err } = await run([T, '--round', roundFile([])]);

    expect(code).toBe(1);
    expect(err.join('\n')).toContain('non-empty "pictures" list');
    expect(fs.existsSync(recordPath())).toBe(false);
  });
});
