/**
 * The owner is named from ~/.lambda/config.json. With no name: "you" in the
 * person's terminal, "the owner" in what an agent reads — and never a
 * pronoun for the owner anywhere in the pod code or commands.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createPodStore } from '../../pod-store';
import { lambdaPackageDir } from '../../process/workflow-file';
import { CARRY_ON } from '../attention';
import { SKIPPED } from '../intake';
import { DELETE_REFUSED, RENAME_REFUSED, runRename } from '../lifecycle';
import { ownerName } from '../owner';
import { COMMITTED, runDecide } from '../questions';
import { setOwnerName } from './podProject';

afterEach(() => setOwnerName(undefined));

const commitLine = (): string => COMMITTED('q3');

describe("the owner's name", () => {
  it('uses the name from the machine settings, for the person and for agents', () => {
    setOwnerName('Leslie Knope');

    expect(ownerName()).toBe('Leslie Knope');
    expect(commitLine()).toBe(
      "Committed q3 — it is now in Leslie Knope's inbox."
    );
    expect(CARRY_ON()).toMatch(/^Leslie Knope has nothing more to add/);
    expect(RENAME_REFUSED('Leslie Knope')).toBe(
      'Leslie Knope named this pod — keeping that name.'
    );
  });

  it('with no name, says "you" to the person and "the owner" to an agent', () => {
    setOwnerName(undefined);

    expect(commitLine()).toBe('Committed q3 — it is now in your inbox.');
    expect(RENAME_REFUSED()).toBe('You named this pod — keeping your name.');
    expect(DELETE_REFUSED()).toBe(
      'Pod agents cannot delete pods — only you can.'
    );
    expect(CARRY_ON()).toMatch(/^The owner has nothing more to add/);
    expect(SKIPPED('3 Research', 'research')).toBe(
      'The owner skipped 3 Research (research).'
    );
  });
});

describe('a decision refused for a missing --instead', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
    jest.restoreAllMocks();
  });

  /** What `lambda pod decide --autonomous` prints to the dev with no --instead. */
  const refusal = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-decide-'));
    createPodStore(root).writePod({
      id: 'pawnee-a1b2',
      slug: 'pawnee',
      createdAt: '2026-10-03T00:00:00.000Z',
      status: 'active',
      phase: 3,
      completedCheckpoints: [],
      worktreePath: '/tmp/pawnee',
      ownsWorktree: false,
      managerCwd: '/tmp/pawnee',
      devCwd: '/tmp/pawnee',
      agentCommand: 'claude',
      sessions: { manager: 'm', dev: 'd' },
    });
    process.env.LAMBDA_PODS_ROOT = root;
    const printed: string[] = [];
    jest.spyOn(console, 'error').mockImplementation((line: string) => {
      printed.splice(printed.length, 0, line);
    });
    jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });

    expect(() =>
      runDecide('Keep the Ice Town rink open late on Fridays', {
        pod: 'pawnee-a1b2',
        autonomous: true,
        why: 'Volunteers asked for later skating at the town forum.',
        intentRef: 'intent.md:3',
      })
    ).toThrow('exit');

    return printed.join('\n');
  };

  it('names the owner when a name is set', () => {
    setOwnerName('Leslie Knope');

    expect(refusal()).toContain(
      'no real alternative Leslie Knope might have preferred'
    );
  });

  it('says "the owner" to the dev with no name', () => {
    setOwnerName(undefined);

    expect(refusal()).toContain(
      'no real alternative the owner might have preferred'
    );
  });
});

// Built from parts, so this file passes its own scan.
const WORDS = ['h' + 'imself', 'h' + 'is', 'h' + 'im'];
describe('lambda pod rename, refused for an agent', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
    jest.restoreAllMocks();
  });

  /** What `lambda pod rename` prints when the dev renames a pod the owner named. */
  const refusal = (): string[] => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-rename-'));
    createPodStore(root).writePod({
      id: 'pawnee-a1b2',
      slug: 'pawnee',
      title: 'Ice Town hours',
      titleBy: 'owner',
      createdAt: '2026-10-03T00:00:00.000Z',
      status: 'active',
      phase: 1,
      completedCheckpoints: [],
      worktreePath: '/tmp/pawnee',
      ownsWorktree: false,
      managerCwd: '/tmp/pawnee',
      devCwd: '/tmp/pawnee',
      agentCommand: 'claude',
      sessions: { manager: 'm', dev: 'd' },
    });
    process.env.LAMBDA_PODS_ROOT = root;
    process.env.POD_ID = 'pawnee-a1b2';
    process.env.POD_AGENT = 'dev';
    const printed: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((line: string) => {
      printed.splice(printed.length, 0, line);
    });

    runRename('pawnee-a1b2', 'Something else');

    return printed;
  };

  it('names the owner once when a name is set', () => {
    setOwnerName('Leslie Knope');

    expect(refusal()).toEqual([
      'Leslie Knope named this pod — keeping that name.',
    ]);
  });

  it('says "you" with no name', () => {
    setOwnerName(undefined);

    expect(refusal()).toEqual(['You named this pod — keeping your name.']);
  });
});

const PRONOUN = new RegExp(`\\b(${WORDS.join('|')})\\b`, 'i');

const files = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          return files(full);
        }

        return /\.(ts|md)$/.test(entry.name) ? [full] : [];
      })
    : [];

const withPronoun = (dir: string): string[] =>
  files(dir).flatMap((file) =>
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, index) =>
        PRONOUN.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : []
      )
  );

describe('no pronoun for the owner', () => {
  it('finds none in the pod code or the pod commands', () => {
    const lambda = lambdaPackageDir();

    expect([
      ...withPronoun(path.join(lambda, 'src', 'pod')),
      ...withPronoun(path.join(lambda, 'commands', 'pod')),
    ]).toEqual([]);
  });

  it('catches one planted in a copy, in any case', () => {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-pronoun-'));
    const planted = `Quote ${WORDS[1] ?? ''} exact words.`;
    const capital = `${(WORDS[1] ?? '').toUpperCase()} words, quoted.`;
    fs.writeFileSync(
      path.join(copy, 'human.md'),
      `Record it with the exact words.\n${planted}\n${capital}\n`
    );

    expect(withPronoun(copy)).toEqual([
      `${path.join(copy, 'human.md')}:2: ${planted}`,
      `${path.join(copy, 'human.md')}:3: ${capital}`,
    ]);
  });
});
