import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';

import { registerSystemCommands } from '../../../commands/design/system';
import { lambdaPackageDir } from '../../../process/workflow-file';
import { writePng as writePngFile } from '../../__tests__/pngFixture';
import {
  COMPOSITE_GUTTER,
  COMPOSITE_LABEL_BAND,
  pngSize,
} from '../../composite';
import { type DesignSeverity } from '../../loop';
import { lastSystemRound, recordSystemRound } from '../round';
import { tmpDir } from './gitFixture';

jest.setTimeout(60_000);

const POD = 'pawnee-setup';

const writePng = (
  file: string,
  width: number,
  height: number,
  rgb?: [number, number, number]
): string => {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  return writePngFile(file, width, height, rgb);
};

const savedPodsRoot = process.env.LAMBDA_PODS_ROOT;

/** This test's pods root: a fresh folder per test. */
const podsRoot = (): string => {
  const root = process.env.LAMBDA_PODS_ROOT;

  if (root === undefined) {
    throw new Error('LAMBDA_PODS_ROOT is not set.');
  }

  return root;
};

beforeEach(() => {
  process.env.LAMBDA_PODS_ROOT = tmpDir('lambda-ds-pods-');
});

afterEach(() => {
  fs.rmSync(podsRoot(), { recursive: true, force: true });

  if (savedPodsRoot === undefined) {
    delete process.env.LAMBDA_PODS_ROOT;

    return;
  }

  process.env.LAMBDA_PODS_ROOT = savedPodsRoot;
});

const systemDir = (pod: string = POD): string =>
  path.join(podsRoot(), pod, 'design-system');

const roundsFile = (): string => path.join(systemDir(), 'rounds.json');

/** A real photo and drawn PNG for a scenario, in the pod's design-system/. */
const pictureFiles = (
  scenarioId: string,
  pod: string = POD
): { photo: string; drawn: string } => ({
  photo: writePng(
    path.join(systemDir(pod), 'photos', `${scenarioId}.png`),
    8,
    6
  ),
  drawn: writePng(
    path.join(systemDir(pod), 'round-1', `${scenarioId}.png`),
    8,
    6,
    [40, 40, 200]
  ),
});

const issue = (severity: DesignSeverity) => ({
  severity,
  where: 'Buttons',
  what: `corners differ (${severity})`,
});

/** A round file grading each scenario with the severities given. */
const roundFile = (
  graded: Record<string, string[]>,
  overrides: Record<string, Record<string, unknown>> = {}
): string => {
  const file = path.join(tmpDir('lambda-ds-round-'), 'round.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      pictures: Object.entries(graded).map(([scenarioId, severities]) => ({
        scenarioId,
        ...pictureFiles(scenarioId),
        issues: severities.map((severity) => ({
          severity,
          where: 'Buttons',
          what: `corners differ (${severity})`,
        })),
        ...(overrides[scenarioId] ?? {}),
      })),
    })
  );

  return file;
};

const record = (graded: Record<string, string[]>): string =>
  recordSystemRound(roundFile(graded)).line;

/** Record `count` rounds that keep the loop going (a high on each). */
const continueFor = (count: number): void => {
  Array.from({ length: count }).forEach((_, index) => {
    expect(record({ 'parks-list': ['high'], 'park-page': [] })).toBe(
      `SYSTEM: CONTINUE (round ${index + 1}) — fix: parks-list`
    );
  });
};

const roundsText = (): string | null =>
  fs.existsSync(roundsFile()) ? fs.readFileSync(roundsFile(), 'utf8') : null;

describe('round record: the stop rule over the whole set', () => {
  it('continues at round 2 with a medium-low left, naming the picture to fix', () => {
    continueFor(1);

    expect(record({ 'parks-list': ['low'], 'park-page': ['medium-low'] })).toBe(
      'SYSTEM: CONTINUE (round 2) — fix: park-page'
    );
  });

  it('stops CLOSE at round 4 with medium-low the worst', () => {
    continueFor(3);

    expect(record({ 'parks-list': ['low'], 'park-page': ['medium-low'] })).toBe(
      'SYSTEM: CLOSE'
    );
  });

  it('continues at round 4 with a medium left, and stops CLOSE with a medium at round 7', () => {
    continueFor(3);

    expect(record({ 'parks-list': ['medium'], 'park-page': ['low'] })).toBe(
      'SYSTEM: CONTINUE (round 4) — fix: parks-list'
    );
    expect(record({ 'parks-list': ['medium'], 'park-page': ['low'] })).toBe(
      'SYSTEM: CONTINUE (round 5) — fix: parks-list'
    );
    expect(record({ 'parks-list': ['medium'], 'park-page': ['low'] })).toBe(
      'SYSTEM: CONTINUE (round 6) — fix: parks-list'
    );
    expect(record({ 'parks-list': ['medium'], 'park-page': ['low'] })).toBe(
      'SYSTEM: CLOSE'
    );
  });

  it('is MATCH at round 1 with only low issues', () => {
    expect(record({ 'parks-list': ['low'], 'park-page': [] })).toBe(
      'SYSTEM: MATCH'
    );
    expect(lastSystemRound(roundsFile())).toMatchObject({
      round: 1,
      result: 'MATCH',
    });
  });

  it('is BLOCKED with a high left at round 7', () => {
    continueFor(6);

    expect(record({ 'parks-list': ['high'], 'park-page': ['low'] })).toBe(
      'SYSTEM: BLOCKED'
    );
  });

  it('works out the round number itself and appends to rounds.json', () => {
    continueFor(2);
    const rounds: unknown = JSON.parse(roundsText() ?? '[]');

    expect(Array.isArray(rounds) && rounds.length).toBe(2);
    expect(lastSystemRound(roundsFile())).toMatchObject({
      round: 2,
      result: 'CONTINUE',
      pictures: [
        { scenarioId: 'parks-list', issues: [issue('high')] },
        { scenarioId: 'park-page', issues: [] },
      ],
    });
  });
});

describe('round record: refusals write nothing', () => {
  it('refuses round 8, leaving rounds.json byte-identical', () => {
    continueFor(6);
    record({ 'parks-list': ['medium'], 'park-page': [] });
    const before = roundsText();

    expect(() =>
      recordSystemRound(roundFile({ 'parks-list': [], 'park-page': [] }))
    ).toThrow('Refusing round 8');
    expect(roundsText()).toBe(before);
  });

  it('refuses another round once the loop has ended', () => {
    record({ 'parks-list': [], 'park-page': [] });
    const before = roundsText();

    expect(() =>
      recordSystemRound(roundFile({ 'parks-list': [], 'park-page': [] }))
    ).toThrow('Round 1 already ended the loop (MATCH)');
    expect(roundsText()).toBe(before);
  });

  it('refuses a scenarioId of ../x', () => {
    const file = roundFile(
      { 'parks-list': [] },
      { 'parks-list': { scenarioId: '../x' } }
    );

    expect(() => recordSystemRound(file)).toThrow('scenarioId "../x"');
    expect(roundsText()).toBeNull();
  });

  it("refuses a drawn picture outside the pod's design-system/", () => {
    const outside = writePng(
      path.join(podsRoot(), POD, 'designs', 'parks-list.png'),
      8,
      6
    );
    const file = roundFile(
      { 'parks-list': [] },
      { 'parks-list': { drawn: outside } }
    );

    expect(() => recordSystemRound(file)).toThrow(
      'must be a PNG under <pods root>/<pod>/design-system/'
    );
    expect(roundsText()).toBeNull();
  });

  it('refuses a drawn picture outside the pods root altogether', () => {
    const outside = writePng(
      path.join(tmpDir('lambda-ds-elsewhere-'), 'design-system', 'x.png'),
      8,
      6
    );
    const file = roundFile(
      { 'parks-list': [] },
      { 'parks-list': { drawn: outside } }
    );

    expect(() => recordSystemRound(file)).toThrow('must be a PNG under');
    expect(roundsText()).toBeNull();
  });

  it('refuses a picture that is not a PNG', () => {
    const fake = path.join(systemDir(), 'photos', 'fake.png');
    fs.mkdirSync(path.dirname(fake), { recursive: true });
    fs.writeFileSync(fake, 'not a picture');
    const file = roundFile(
      { 'parks-list': [] },
      { 'parks-list': { photo: fake } }
    );

    expect(() => recordSystemRound(file)).toThrow('must be a PNG under');
    expect(roundsText()).toBeNull();
  });

  it('refuses a photo and drawn picture in different pods', () => {
    const other = pictureFiles('parks-list', 'other-pod');
    const file = roundFile(
      { 'parks-list': [] },
      { 'parks-list': { drawn: other.drawn } }
    );

    expect(() => recordSystemRound(file)).toThrow('are in different pods');
  });

  it('refuses severity "High"', () => {
    const file = roundFile(
      { 'parks-list': [] },
      {
        'parks-list': {
          issues: [{ severity: 'High', where: 'Buttons', what: 'corners' }],
        },
      }
    );

    expect(() => recordSystemRound(file)).toThrow('unknown severity "High"');
    expect(roundsText()).toBeNull();
  });

  it("refuses round 2 with a different set of ids from round 1's", () => {
    continueFor(1);
    const before = roundsText();

    expect(() =>
      recordSystemRound(roundFile({ 'parks-list': [], 'bench-row': [] }))
    ).toThrow('Every round grades the same screens');
    expect(roundsText()).toBe(before);
  });

  it('refuses the same scenario twice, an empty list and a missing file', () => {
    const twice = path.join(tmpDir('lambda-ds-round-'), 'round.json');
    const picture = {
      scenarioId: 'parks-list',
      ...pictureFiles('parks-list'),
      issues: [],
    };
    fs.writeFileSync(twice, JSON.stringify({ pictures: [picture, picture] }));
    const empty = path.join(tmpDir('lambda-ds-round-'), 'round.json');
    fs.writeFileSync(empty, JSON.stringify({ pictures: [] }));

    expect(() => recordSystemRound(twice)).toThrow('names parks-list twice');
    expect(() => recordSystemRound(empty)).toThrow('non-empty "pictures"');
    expect(() => recordSystemRound(path.join(podsRoot(), 'none.json'))).toThrow(
      'does not exist'
    );
    expect(roundsText()).toBeNull();
  });
});

describe('lambda design system round record', () => {
  const runCli = async (file: string): Promise<string[]> => {
    const printed: string[] = [];
    const log = jest
      .spyOn(console, 'log')
      .mockImplementation((line: unknown) => {
        printed.splice(printed.length, 0, String(line));
      });
    const savedExit = process.exitCode;

    try {
      const program = new Command('lambda').exitOverride();
      registerSystemCommands(program.command('design'));
      await program.parseAsync(
        ['design', 'system', 'round', 'record', '--round', file],
        { from: 'user' }
      );

      return [...printed, `exit ${process.exitCode ?? 0}`];
    } finally {
      log.mockRestore();
      process.exitCode = savedExit;
    }
  };

  const composite = (scenarioId: string, round = 1): string =>
    path.join(systemDir(), `round-${round}`, `composite-${scenarioId}.png`);

  /** Every composite under the pod's design-system/. */
  const composites = (): string[] =>
    fs.existsSync(systemDir())
      ? fs
          .readdirSync(systemDir(), { recursive: true, encoding: 'utf8' })
          .filter((rel) => path.basename(rel).startsWith('composite-'))
      : [];

  it('prints the result line, then one composite per screen', async () => {
    expect(
      await runCli(roundFile({ 'parks-list': ['low'], 'park-page': [] }))
    ).toEqual([
      'SYSTEM: MATCH',
      `Composite: ${composite('parks-list')}`,
      `Composite: ${composite('park-page')}`,
      'exit 0',
    ]);
  });

  it('writes each composite beside the drawn picture: photo | drawn, a 24px gutter and the 48px label band', async () => {
    const photo = writePng(
      path.join(systemDir(), 'photos', 'parks-list.png'),
      10,
      6
    );
    const drawn = writePng(
      path.join(systemDir(), 'round-1', 'parks-list.png'),
      8,
      12,
      [40, 40, 200]
    );
    const file = path.join(tmpDir('lambda-ds-round-'), 'round.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        pictures: [{ scenarioId: 'parks-list', photo, drawn, issues: [] }],
      })
    );

    expect(await runCli(file)).toEqual([
      'SYSTEM: MATCH',
      `Composite: ${composite('parks-list')}`,
      'exit 0',
    ]);
    expect(composites()).toEqual([
      path.join('round-1', 'composite-parks-list.png'),
    ]);
    expect(pngSize(composite('parks-list'))).toEqual({
      width: 10 + COMPOSITE_GUTTER + 8,
      height: COMPOSITE_LABEL_BAND + 12,
    });
    expect(COMPOSITE_GUTTER).toBe(24);
    expect(COMPOSITE_LABEL_BAND).toBe(48);
  });

  it('prints Refused: and exits 1 on a structural refusal, never SYSTEM: ERROR', async () => {
    const file = roundFile(
      { 'parks-list': [] },
      { 'parks-list': { scenarioId: '../x' } }
    );
    const [line, exit] = await runCli(file);

    expect(line).toMatch(/^Refused: Picture 1 has scenarioId "\.\.\/x"/);
    expect(exit).toBe('exit 1');
    expect(roundsText()).toBeNull();
  });

  it("prints SYSTEM: ERROR and exits 1 when the judge's issues fail its format", async () => {
    const file = roundFile(
      { 'parks-list': [] },
      {
        'parks-list': {
          issues: [{ severity: 'High', where: 'Buttons', what: 'corners' }],
        },
      }
    );
    const [line, exit] = await runCli(file);

    expect(line).toMatch(/^SYSTEM: ERROR — Picture 1 \(parks-list\): .*"High"/);
    expect(exit).toBe('exit 1');
    expect(roundsText()).toBeNull();
  });

  it("prints SYSTEM: ERROR, records nothing and leaves no composite when a composite can't be drawn", async () => {
    const file = roundFile({ 'parks-list': [], 'park-page': [] });
    const { pictures } = JSON.parse(fs.readFileSync(file, 'utf8'));
    // A PNG signature and nothing after it: past the round check, unreadable
    // to the composite.
    fs.writeFileSync(
      pictures[1].drawn,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );

    expect(await runCli(file)).toEqual([
      expect.stringMatching(
        /^SYSTEM: ERROR — The round's composites couldn't be drawn: /
      ),
      'exit 1',
    ]);
    expect(roundsText()).toBeNull();
    expect(composites()).toEqual([]);
  });

  it('prints Refused: for a round file that is not JSON', async () => {
    const file = path.join(tmpDir('lambda-ds-round-'), 'round.json');
    fs.writeFileSync(file, '{ pictures: ');
    const [line, exit] = await runCli(file);

    expect(line).toMatch(/^Refused: .*round\.json is not valid JSON: /);
    expect(exit).toBe('exit 1');
  });

  it('writes no composite on a refused round', async () => {
    continueFor(6);
    record({ 'parks-list': ['medium'], 'park-page': [] });
    const before = composites();
    const [line, exit] = await runCli(
      roundFile({ 'parks-list': [], 'park-page': [] })
    );

    expect(line).toMatch(/^Refused: Refusing round 8/);
    expect(exit).toBe('exit 1');
    expect(before).toEqual([]);
    expect(composites()).toEqual([]);
  });
});

describe('the setup instructions post one composite per screen', () => {
  const text = fs.readFileSync(
    path.join(
      lambdaPackageDir(),
      'instructions',
      'building',
      'design-system-setup.md'
    ),
    'utf8'
  );
  const imageLines = text
    .split('\n')
    .filter(
      (line) =>
        line.includes('lambda tickets comment') && line.includes('--image')
    );

  it('posts composite- pictures with lambda tickets comment', () => {
    expect(imageLines.length).toBeGreaterThan(0);
    imageLines.forEach((line) =>
      expect({ line, composite: /--image \S*composite-/.test(line) }).toEqual({
        line,
        composite: true,
      })
    );
    expect(text).toContain('round-<n>/composite-<scenario id>.png');
  });

  it('never posts a separate photo and drawn picture', () => {
    expect(text).not.toMatch(/--image\s+\S*photo\S*\s+--image\s+\S*drawn/i);
    imageLines.forEach((line) =>
      expect(line).not.toMatch(/--image <(photo|drawn)>/)
    );
  });
});
