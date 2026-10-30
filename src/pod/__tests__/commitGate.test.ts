/**
 * The commit gate in front of the owner's inbox: a cold read, and the four
 * parts of a decision question, always — and no build-queue check.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type Question, createPodStore } from '../../pod-store';
import { runQuestionCommit } from '../questions';
import './podProject';

const POD = 'pawnee-a1b2';

const saved = { ...process.env };

const seed = (question: Partial<Question>): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-commit-'));
  const store = createPodStore(root);
  store.writePod({
    id: POD,
    slug: 'pawnee',
    createdAt: '2026-10-03T00:00:00.000Z',
    status: 'active',
    phase: 2,
    completedCheckpoints: [],
    worktreePath: '/tmp/pawnee',
    ownsWorktree: false,
    managerCwd: '/tmp/pawnee',
    devCwd: '/tmp/pawnee',
    agentCommand: 'claude',
    sessions: { manager: 'm', dev: 'd' },
  });
  store.writeQuestion({
    id: 'q1',
    podId: POD,
    kind: 'question',
    phase: 2,
    status: 'draft',
    blocksCheckpoint: false,
    dependsOn: [],
    createdAt: '2026-10-03T00:00:00.000Z',
    origin: { kind: 'work', phase: 2, doing: 'checking the gallery ticket' },
    options: [],
    ...question,
  });
  process.env.LAMBDA_PODS_ROOT = root;
  delete process.env.POD_ID;

  return root;
};

const COMPLETE: Partial<Question> = {
  summary: 'Should the Lot 48 gallery show photos people sent in?',
  context:
    'The gallery shows photos the parks department took. People have started sending their own.',
  problem:
    'Showing sent-in photos makes the gallery livelier, but someone has to look at each one first.',
  options: [
    {
      id: 'A',
      label: 'Show only department photos',
      detail: 'Nothing changes.',
      tradeoffs: 'No extra work, but the gallery stays thin.',
    },
    {
      id: 'B',
      label: 'Show sent-in photos once a ranger approves them',
      detail: 'A ranger looks at each first.',
      tradeoffs: 'A livelier gallery, for a few minutes of ranger time a day.',
    },
  ],
  recommendation: {
    optionId: 'B',
    why: 'People asked for it and a ranger already checks the lot daily.',
  },
};

const coldReadFile = (read: unknown): string => {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-cold-')),
    'cold.json'
  );
  fs.writeFileSync(file, JSON.stringify(read));

  return file;
};

/** process.exit → a throw, with what was printed to stderr. */
const refusal = (): string[] => {
  const errors: string[] = [];
  jest.spyOn(console, 'error').mockImplementation((line: string) => {
    errors.splice(errors.length, 0, line);
  });
  jest.spyOn(process, 'exit').mockImplementation((): never => {
    throw new Error('exit');
  });

  return errors;
};

afterEach(() => {
  process.env = { ...saved };
  jest.restoreAllMocks();
});

describe('lambda pod question commit', () => {
  it('refuses a question whose cold read still had to ask something', () => {
    seed(COMPLETE);
    const errors = refusal();

    expect(() =>
      runQuestionCommit('q1', {
        pod: POD,
        justification: 'Ready.',
        coldRead: coldReadFile({
          restatement: 'Something about photos.',
          choice: 'B',
          missing: ['who looks at the photos'],
        }),
      })
    ).toThrow('exit');
    expect(errors).toEqual([
      'Not committed — fix these and run commit again:',
      '  • The cold read still needed to ask: who looks at the photos. Revise the question so a reader without context could decide.',
    ]);
  });

  it('refuses a decision question missing one of its four parts', () => {
    const { problem: _problem, ...withoutProblem } = COMPLETE;
    seed(withoutProblem);
    const errors = refusal();

    expect(() =>
      runQuestionCommit('q1', {
        pod: POD,
        justification: 'Ready.',
        coldRead: coldReadFile({
          restatement:
            'Should the gallery show photos people send in, once a ranger approves them?',
          choice: 'B',
          missing: [],
        }),
      })
    ).toThrow('exit');
    expect(errors.join('\n')).toMatch(/problem/i);
  });

  it('commits a question that passes both, with no queue file anywhere', () => {
    const root = seed(COMPLETE);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    runQuestionCommit('q1', {
      pod: POD,
      justification: 'The owner asked about sent-in photos.',
      coldRead: coldReadFile({
        restatement:
          'Should the gallery show photos people send in, once a ranger approves them?',
        choice: 'B',
        missing: [],
      }),
    });

    expect(createPodStore(root).requireQuestion(POD, 'q1').status).toBe('open');
    expect(fs.readdirSync(path.join(root, POD))).not.toContain('queue.json');
  });

  it('exports no build-queue reader from any pod module', async () => {
    const dir = path.join(__dirname, '..');
    const modules = fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.ts'))
      .map((file) => path.join(dir, file));
    const exported = (
      await Promise.all(
        modules.map(async (file) => {
          const module: Record<string, unknown> = await import(file);

          return Object.keys(module).map(
            (name) => `${path.basename(file)}:${name}`
          );
        })
      )
    ).flat();

    expect(modules).toContain(path.join(dir, 'questions.ts'));
    expect(exported).toContain('questions.ts:runQuestionCommit');
    expect(
      exported.filter((name) => /:(readPodQueue|queueProblems)$/.test(name))
    ).toEqual([]);
  });
});
