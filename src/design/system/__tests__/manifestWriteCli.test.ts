import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';

import { registerSystemCommands } from '../../../commands/design/system';
import { lambdaPackageDir } from '../../../process/workflow-file';
import { cloneOfUpstream, put, tmpDir } from './gitFixture';

/**
 * `lambda design system manifest write` as the setup ticket runs it: the real
 * commander command in a fixture checkout, and every command line the setup
 * instructions show, run as written.
 */

const DIR = '.lambda/design-system';
const MANIFEST = `${DIR}/design-system.json`;
const POD = 'pawnee-setup';
const TICKET = 'PAWNEE-12';

const SETUP = path.join(
  lambdaPackageDir(),
  'instructions',
  'building',
  'design-system-setup.md'
);

const savedPodsRoot = process.env.LAMBDA_PODS_ROOT;
const pods = { root: '' };

beforeEach(() => {
  pods.root = tmpDir('lambda-ds-pods-');
  process.env.LAMBDA_PODS_ROOT = pods.root;
});

afterEach(() => {
  fs.rmSync(pods.root, { recursive: true, force: true });

  if (savedPodsRoot === undefined) {
    delete process.env.LAMBDA_PODS_ROOT;

    return;
  }

  process.env.LAMBDA_PODS_ROOT = savedPodsRoot;
});

const podSystemDir = (): string => path.join(pods.root, POD, 'design-system');

/** The setup ticket's checkout: the app on origin/main, the design system written but not committed. */
const setupCheckout = (): string => {
  const { clone } = cloneOfUpstream({
    'lambda.json': JSON.stringify({ name: 'Pawnee parks map' }),
    '.gitignore': 'node_modules/\n',
    'src/components/ParkCard.tsx': 'export const ParkCard = () => null;\n',
  });
  put(
    clone,
    `${DIR}/index.tsx`,
    "export { ParkCard } from '../../src/components/ParkCard';\n"
  );
  put(
    clone,
    `${DIR}/sources.json`,
    JSON.stringify({
      system: [`${DIR}/`],
      tokens: [],
      components: { ParkCard: 'src/components/ParkCard.tsx' },
      patterns: {},
    })
  );

  return clone;
};

/** A rounds.json as round record writes it, ending in MATCH at round 1. */
const writeRounds = (): string => {
  const file = path.join(podSystemDir(), 'rounds.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify([
      {
        round: 1,
        pictures: [
          {
            scenarioId: 'parks-list',
            photo: path.join(podSystemDir(), 'photos', 'parks-list.png'),
            drawn: path.join(podSystemDir(), 'round-1', 'parks-list.png'),
            issues: [
              { severity: 'low', where: 'Buttons', what: 'corners differ' },
            ],
          },
        ],
        result: 'MATCH',
      },
    ])
  );

  return file;
};

const LEFT_OUT = [
  { name: 'MapView', why: 'it loads the map library at import' },
];

/** The left-out list, in the pod's folder (outside the checkout). */
const writeLeftOut = (): string => {
  const file = path.join(podSystemDir(), 'left-out.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(LEFT_OUT));

  return file;
};

const runCli = async (cwd: string, args: string[]): Promise<string[]> => {
  const printed: string[] = [];
  const log = jest.spyOn(console, 'log').mockImplementation((line: unknown) => {
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
    const program = new Command('lambda').exitOverride().configureOutput({
      writeErr: (text) => printed.splice(printed.length, 0, `error: ${text}`),
    });
    registerSystemCommands(program.command('design').exitOverride());
    await program
      .parseAsync(args, { from: 'user' })
      .catch((thrown: unknown) => {
        printed.splice(
          printed.length,
          0,
          `thrown: ${thrown instanceof Error ? thrown.message : String(thrown)}`
        );
        process.exitCode = 1;
      });

    return [...printed, `exit ${process.exitCode ?? 0}`];
  } finally {
    process.chdir(savedCwd);
    log.mockRestore();
    error.mockRestore();
    process.exitCode = savedExit;
  }
};

const manifestOf = (root: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8'));

const write = (root: string, args: string[]): Promise<string[]> =>
  runCli(root, ['design', 'system', 'manifest', 'write', ...args]);

describe('lambda design system manifest write', () => {
  jest.setTimeout(30_000);

  it('--rounds: syncedBy is the ticket and check comes from the rounds file', async () => {
    const root = setupCheckout();

    expect(
      await write(root, ['--ticket', TICKET, '--rounds', writeRounds()])
    ).toEqual([expect.stringContaining(path.join(root, MANIFEST)), 'exit 0']);
    expect(manifestOf(root)).toMatchObject({
      namespace: 'PawneeParksMap',
      version: 1,
      syncedBy: TICKET,
      source: 'code+photos',
      check: {
        result: 'match',
        rounds: 1,
        photos: 1,
        issues: [{ severity: 'low', where: 'Buttons', what: 'corners differ' }],
      },
      components: ['ParkCard'],
      leftOut: [],
    });
  });

  it('--not-checked "<reason>": check is not-checked with that reason', async () => {
    const root = setupCheckout();
    const reason = 'there are no screenshot scenarios to photograph yet';

    expect(
      await write(root, ['--ticket', TICKET, '--not-checked', reason])
    ).toEqual([expect.stringContaining('Wrote'), 'exit 0']);
    expect(manifestOf(root)).toMatchObject({
      syncedBy: TICKET,
      source: 'code',
      check: {
        result: 'not-checked',
        rounds: 0,
        photos: 0,
        issues: [],
        reason,
      },
    });
  });

  it('--left-out <file>: records what was left out', async () => {
    const root = setupCheckout();

    await write(root, [
      '--ticket',
      TICKET,
      '--rounds',
      writeRounds(),
      '--left-out',
      writeLeftOut(),
    ]);

    expect(manifestOf(root)).toMatchObject({ leftOut: LEFT_OUT });
  });

  it('refuses --rounds together with --not-checked, writing nothing', async () => {
    const root = setupCheckout();
    const printed = await write(root, [
      '--ticket',
      TICKET,
      '--rounds',
      writeRounds(),
      '--not-checked',
      'there are no screenshot scenarios to photograph yet',
    ]);

    expect(printed.at(-1)).toBe('exit 1');
    expect(printed.join('\n')).toContain(
      'either --rounds or --not-checked, never both'
    );
    expect(fs.existsSync(path.join(root, MANIFEST))).toBe(false);
  });

  it('refuses a --left-out file that is not JSON, naming it', async () => {
    const root = setupCheckout();
    const file = writeLeftOut();
    fs.writeFileSync(file, '[{ "name": ');
    const printed = await write(root, [
      '--ticket',
      TICKET,
      '--rounds',
      writeRounds(),
      '--left-out',
      file,
    ]);

    expect(printed.at(-1)).toBe('exit 1');
    expect(printed.join('\n')).toContain(`${file} is not valid JSON: `);
    expect(fs.existsSync(path.join(root, MANIFEST))).toBe(false);
  });

  it('refuses with neither --rounds nor --not-checked, writing nothing', async () => {
    const root = setupCheckout();
    const printed = await write(root, ['--ticket', TICKET]);

    expect(printed.at(-1)).toBe('exit 1');
    expect(printed.join('\n')).toContain('--not-checked <reason>');
    expect(fs.existsSync(path.join(root, MANIFEST))).toBe(false);
  });
});

/** Split a command line into words, honouring double quotes. */
const words = (line: string): string[] =>
  Array.from(line.matchAll(/"([^"]*)"|(\S+)/g), (match) =>
    match[1] !== undefined ? match[1] : match[2] ?? ''
  );

/** Every `manifest write` command line the setup instructions show (code blocks and inline code with options). */
const commandLines = (text: string): string[] =>
  Array.from(
    text.matchAll(/lambda design system manifest write( [^`\n]*)?/g),
    (match) => match[0].trim()
  ).filter((line) => line.includes(' --'));

describe('the setup instructions: every manifest write line runs as written', () => {
  jest.setTimeout(60_000);

  const text = fs.readFileSync(SETUP, 'utf8');
  const lines = commandLines(text);
  const fenced = Array.from(
    text.matchAll(/```bash\n([\s\S]*?)```/g),
    (m) => m[1] ?? ''
  ).join('\n');

  it('shows a --rounds line and a --not-checked line in a bash block, each with --ticket', () => {
    const inBlocks = commandLines(fenced);

    expect(inBlocks.some((line) => line.includes('--rounds '))).toBe(true);
    expect(inBlocks.some((line) => line.includes('--not-checked '))).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    lines.forEach((line) =>
      expect({ line, ticket: line.includes('--ticket ') }).toEqual({
        line,
        ticket: true,
      })
    );
  });

  it('documents --left-out with its JSON shape, and the three not-checked reasons exactly', () => {
    expect(lines.some((line) => line.includes('--left-out '))).toBe(true);
    expect(text).toContain('[{ "name": "<piece>", "why": "<why>" }]');
    [
      '"this project has no photo hook (commands.shot in lambda.json)"',
      '"there are no screenshot scenarios to photograph yet"',
      '"the photo hook failed for every screen (<its last output line>)"',
    ].forEach((reason) => expect(text).toContain(reason));
  });

  it.each(lines.map((line) => [line]))('%s', async (line) => {
    const root = setupCheckout();
    const rounds = writeRounds();
    const leftOut = writeLeftOut();
    const substituted = line
      .replace(/\$ARGUMENTS|<id>|<ticket id>/g, TICKET)
      .replace(/\$LAMBDA_PODS_ROOT|<pods root>/g, pods.root)
      .replace(/\$POD_ID|<pod-id>/g, POD)
      .replace(
        /"<reason>"/g,
        '"there are no screenshot scenarios to photograph yet"'
      );

    expect(substituted).not.toMatch(/[<>$]/);

    const [lambda, ...args] = words(substituted);
    const printed = await runCli(root, args);

    expect(lambda).toBe('lambda');
    expect(printed.join('\n')).not.toMatch(/required option|missing|error:/i);
    expect(printed.at(-1)).toBe('exit 0');
    expect(manifestOf(root)).toMatchObject({ syncedBy: TICKET });

    if (line.includes('--rounds ')) {
      expect(rounds).toBe(path.join(podSystemDir(), 'rounds.json'));
      expect(manifestOf(root)).toMatchObject({ check: { result: 'match' } });
    }

    if (line.includes('--left-out ')) {
      expect(leftOut).toBe(path.join(podSystemDir(), 'left-out.json'));
      expect(manifestOf(root)).toMatchObject({ leftOut: LEFT_OUT });
    }
  });
});
