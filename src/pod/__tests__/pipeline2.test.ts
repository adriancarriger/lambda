import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  type Pod,
  ProposedTicketSchema,
  createPodStore,
} from '../../pod-store';
import { runReply } from '../messaging';
import { runCheckpointPost, runDecide } from '../questions';
import { runStep } from '../steps';
import './podProject';

/**
 * Pipeline 2 (pods from 2026-10-07): the split proposal at CP3, "what I
 * understood" + the change lists, no CP1/CP2 for an existing epic or ticket,
 * and a checkpoint showing every decision not shown at an earlier one.
 */

const POD = 'pawnee-a1b2';

const seed = (overrides: Partial<Pod> = {}): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-pod2-'));
  createPodStore(root).writePod({
    id: POD,
    slug: 'pawnee',
    createdAt: '2026-10-07T00:00:00.000Z',
    status: 'active',
    phase: 3,
    completedCheckpoints: [],
    worktreePath: '/tmp/pawnee',
    ownsWorktree: false,
    managerCwd: '/tmp/pawnee',
    devCwd: '/tmp/pawnee',
    agentCommand: 'claude',
    sessions: { manager: 'm', dev: 'd' },
    pipeline: 2,
    source: 'idea',
    ...overrides,
  });

  return root;
};

const withPod = async (
  root: string,
  body: () => Promise<void> | void
): Promise<void> => {
  const saved = { ...process.env };
  process.env.LAMBDA_PODS_ROOT = root;
  process.env.POD_ID = POD;
  process.env.POD_AGENT = 'dev';

  try {
    await body();
  } finally {
    process.env = saved;
  }
};

const writeJson = (root: string, name: string, data: unknown): string => {
  const file = path.join(root, name);
  fs.writeFileSync(file, JSON.stringify(data));

  return file;
};

const ticket = (number: string, overrides: Record<string, unknown> = {}) => ({
  number,
  title: 'Closed trails show on the trail map',
  what: 'A trail that is closed shows greyed out on the trail map instead of vanishing.',
  files: ['server/src/trails/map.ts:40'],
  dependsOn: [],
  e2e: {
    kind: 'new-tests',
    spec: 'tests/e2e/trails.spec.ts',
  },
  docs: [],
  overlaps: [],
  coldRead: {
    restatement: 'Closed trails stay on the map, greyed out.',
    unclear: [],
  },
  ...overrides,
});

/** process.exit → a throw, with what was printed to stderr. */
const refusal = () => {
  const errors: string[] = [];
  jest.spyOn(console, 'error').mockImplementation((line: string) => {
    errors.splice(errors.length, 0, line);
  });
  jest.spyOn(process, 'exit').mockImplementation((): never => {
    throw new Error('exit');
  });

  return errors;
};

afterEach(() => jest.restoreAllMocks());

describe('the split proposal (CP3)', () => {
  it('posts the proposal — no plan needed, since no ticket exists yet', async () => {
    const root = seed();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await withPod(root, () =>
      runCheckpointPost({
        cp: '3',
        summary: 'Two tickets: the map, then the notice.',
        proposalFile: writeJson(root, 'proposal.json', {
          tickets: [
            ticket('1'),
            ticket('2', {
              e2e: {
                kind: 'new-file',
                spec: 'tests/e2e/notice.spec.ts',
                why: 'no spec covers closure notices today',
              },
            }),
          ],
        }),
      })
    );

    const [posted] = createPodStore(root).listQuestions(POD);
    expect(posted?.checkpoint?.cp).toBe(3);
    expect(posted?.checkpoint?.proposal?.map((t) => t.number)).toEqual([
      '1',
      '2',
    ]);
    // The cold read is checked, not stored.
    expect(posted?.checkpoint?.proposal?.[0]).not.toHaveProperty('coldRead');
  });

  it("keeps a ticket's lane, so the card can tag it and the label follows", async () => {
    const root = seed();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await withPod(root, () =>
      runCheckpointPost({
        cp: '3',
        summary: 'Two tickets.',
        proposalFile: writeJson(root, 'proposal.json', {
          tickets: [ticket('1'), ticket('2', { lane: 'quick-fix' })],
        }),
      })
    );

    const [posted] = createPodStore(root).listQuestions(POD);
    expect(posted?.checkpoint?.proposal?.map((t) => t.lane)).toEqual([
      undefined,
      'quick-fix',
    ]);
  });

  it('reads an older proposal: lane quick-update as quick-fix, helpArticles as docs', async () => {
    const root = seed();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const older = (number: string, extra: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(ticket(number, extra)).filter(([key]) => key !== 'docs')
      );

    await withPod(root, () =>
      runCheckpointPost({
        cp: '3',
        summary: 'Two tickets.',
        proposalFile: writeJson(root, 'proposal.json', {
          tickets: [
            older('1', { helpArticles: ['trails.md'] }),
            older('2', { lane: 'quick-update', helpArticles: [] }),
          ],
        }),
      })
    );

    const [posted] = createPodStore(root).listQuestions(POD);
    expect(posted?.checkpoint?.proposal?.map((t) => t.lane)).toEqual([
      undefined,
      'quick-fix',
    ]);
    expect(posted?.checkpoint?.proposal?.map((t) => t.docs)).toEqual([
      ['trails.md'],
      [],
    ]);
    expect(posted?.checkpoint?.proposal?.[0]).not.toHaveProperty(
      'helpArticles'
    );
    // A pod stored before the rename reads the same way.
    expect(
      ProposedTicketSchema.parse(
        older('3', { lane: 'quick-update', helpArticles: ['map.md'] })
      )
    ).toMatchObject({ lane: 'quick-fix', docs: ['map.md'] });
  });

  it('refuses a lane that is not one', async () => {
    const root = seed();

    await expect(
      withPod(root, () =>
        runCheckpointPost({
          cp: '3',
          summary: 'One ticket.',
          proposalFile: writeJson(root, 'proposal.json', {
            tickets: [ticket('1', { lane: 'quick' })],
          }),
        })
      )
    ).rejects.toThrow(/lane/);
  });

  it('refuses a new spec file with no reason, and a numbering gap', async () => {
    const root = seed();
    const errors = refusal();

    await expect(
      withPod(root, () =>
        runCheckpointPost({
          cp: '3',
          summary: 'Two tickets.',
          proposalFile: writeJson(root, 'proposal.json', {
            tickets: [
              ticket('1', {
                e2e: {
                  kind: 'new-file',
                  spec: 'tests/e2e/x.spec.ts',
                },
              }),
              ticket('3'),
            ],
          }),
        })
      )
    ).rejects.toThrow('exit');

    expect(errors.join('\n')).toMatch(/NEW spec file needs e2e\.why/);
    expect(errors.join('\n')).toMatch(/Number the tickets 1…2/);
  });

  // The split is a tree — each ticket depends only on earlier
  // tickets it needs, and says why.
  const postTickets = (root: string, tickets: unknown[]) =>
    withPod(root, () =>
      runCheckpointPost({
        cp: '3',
        summary: 'The tickets.',
        proposalFile: writeJson(root, 'proposal.json', { tickets }),
      })
    );

  it('refuses a dependency on a same- or higher-numbered ticket', async () => {
    const root = seed();
    const errors = refusal();

    await expect(
      postTickets(root, [
        ticket('1'),
        ticket('2', {
          dependsOn: ['3', '2'],
          dependsWhy: { '3': 'needs the notice', '2': 'itself' },
        }),
        ticket('3'),
      ])
    ).rejects.toThrow('exit');
    expect(errors.join('\n')).toMatch(
      /Ticket 2 depends on 3 — a dependency must have a lower build number/
    );
    expect(errors.join('\n')).toMatch(
      /Ticket 2 depends on 2 — a dependency must have a lower build number/
    );
  });

  it('refuses a dependency with no reason', async () => {
    const root = seed();
    const errors = refusal();

    await expect(
      postTickets(root, [ticket('1'), ticket('2', { dependsOn: ['1'] })])
    ).rejects.toThrow('exit');
    expect(errors.join('\n')).toMatch(
      /Ticket 2 depends on 1 with no reason — add dependsWhy\["1"\]/
    );
  });

  it('posts dependencies that each have a reason and a lower number (compared as numbers)', async () => {
    const root = seed();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const tickets = Array.from({ length: 10 }, (_unused, index) =>
      index === 9
        ? ticket('10', {
            dependsOn: ['9', '1'],
            dependsWhy: {
              '9': 'needs the export',
              '1': 'needs the claim code',
            },
          })
        : ticket(String(index + 1))
    );

    await postTickets(root, tickets);

    const [posted] = createPodStore(root).listQuestions(POD);
    expect(posted?.checkpoint?.proposal?.[9]?.dependsWhy).toEqual({
      '9': 'needs the export',
      '1': 'needs the claim code',
    });
  });
});

describe('an existing epic or lone ticket', () => {
  it('has no CP1 or CP2', async () => {
    const root = seed({ source: 'epic', phase: 1 });

    await expect(
      withPod(root, () =>
        runCheckpointPost({ cp: '1', summary: 'Read it.', plan: 'The plan.' })
      )
    ).rejects.toThrow(/no CP1 or CP2/);
  });

  it('opens the UX review with what was understood, and shows every decision since the start', async () => {
    const root = seed({ source: 'ticket', phase: 3 });
    const store = createPodStore(root);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    // A decision from the review (phase 2) — there was no CP2 to show it.
    store.updatePod(POD, (pod) => ({ ...pod, phase: 2 }));
    await withPod(root, () =>
      runDecide('Drew the closed trail in grey on the map', {
        autonomous: true,
        before:
          'A closed trail looked the same as an open one on the trail map.',
        why: 'Hikers should see at a glance which trails are closed.',
        instead: 'A separate list of closed trails under the map.',
        means: 'Closed trails show grey on the trail map.',
        intentRef: 'Hikers can tell a closed trail from an open one.',
      })
    );
    store.updatePod(POD, (pod) => ({ ...pod, phase: 3 }));
    const [decision] = store.readAutonomousDecisions(POD);

    await withPod(root, () =>
      runCheckpointPost({
        cp: '4',
        summary: 'One screen changes.',
        understood:
          'You want closed trails to still be seen, greyed out on the map.',
        screensFile: writeJson(root, 'ux.json', {
          flows: [
            {
              name: 'Checking a closed trail',
              summary: 'Ann Perkins hears a trail is closed and checks it.',
              screens: [
                {
                  name: 'Trail map',
                  change: 'changed',
                  before: '┌──┐\n│Map│\n└──┘',
                  after: '┌──┐\n│Closed│\n└──┘',
                  changes: 'Ann sees the closed trail and a detour button.',
                  journey: {
                    who: 'Ann Perkins, a volunteer.',
                    before: 'She hears that a trail is closed.',
                    here: 'She checks it.',
                    after: 'Leslie sees it inspected.',
                  },
                  tickets: ['1'],
                  coldRead: { restatement: 'Ann checks a trail.', unclear: [] },
                },
              ],
            },
          ],
        }),
        decisionsColdRead: writeJson(root, 'reads.json', [
          {
            id: decision?.id,
            situation: 'A closed trail looked like an open one.',
            restatement: 'Closed trails are grey on the map.',
            unclear: [],
            unexplained: [],
          },
        ]),
      })
    );

    const posted = store
      .listQuestions(POD)
      .find((question) => question.checkpoint?.cp === 4);
    expect(posted?.checkpoint?.understood).toMatch(/still be seen/);
    expect(posted?.checkpoint?.decisionIds).toEqual([decision?.id]);
  });

  describe('pictures and the prototype link (full render mode)', () => {
    const PICTURES = [
      {
        situation: 'Trail closed',
        scenarioId: 'trail-map-closed',
        before: 'designs/trail-map/trail-closed.before.png',
        after: 'designs/trail-map/trail-closed.annotated.png',
        legend: [{ n: 1, label: 'Why the trail is closed' }],
      },
    ];
    const PROTOTYPE = 'https://claude.ai/design/p/trail-map';

    const postWithPictures = (root: string) =>
      withPod(root, () =>
        runCheckpointPost({
          cp: '4',
          summary: 'One screen changes.',
          understood: 'You want Ann to see why the trail is closed.',
          screensFile: writeJson(root, 'ux.json', {
            flows: [
              {
                name: 'Checking a closed trail',
                summary: 'Ann Perkins checks a closed trail.',
                screens: [
                  {
                    name: 'Trail map',
                    change: 'changed',
                    before: '┌──┐\n│Map│\n└──┘',
                    after: '┌──┐\n│Closed│\n└──┘',
                    changes: 'Ann sees why the trail is closed.',
                    journey: {
                      who: 'Ann Perkins, a volunteer.',
                      before: 'Her trail was closed.',
                      here: 'She opens the detour.',
                      after: 'Leslie sees it inspected.',
                    },
                    tickets: ['1'],
                    coldRead: {
                      restatement: 'Ann takes the detour.',
                      unclear: [],
                    },
                    pictures: PICTURES,
                    prototypeUrl: PROTOTYPE,
                  },
                ],
              },
            ],
          }),
        })
      );

    const writePng = (root: string, podRelative: string): void => {
      const file = path.join(root, POD, podRelative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'png');
    };

    it('keeps them on the stored screen', async () => {
      const root = seed({ source: 'ticket', phase: 3 });
      jest.spyOn(console, 'log').mockImplementation(() => undefined);
      writePng(root, PICTURES[0]?.before ?? '');
      writePng(root, PICTURES[0]?.after ?? '');

      await postWithPictures(root);

      const posted = createPodStore(root)
        .listQuestions(POD)
        .find((question) => question.checkpoint?.cp === 4);
      expect(posted?.checkpoint?.screens?.[0]?.pictures).toEqual(PICTURES);
      expect(posted?.checkpoint?.screens?.[0]?.prototypeUrl).toBe(PROTOTYPE);
    });

    it('refuses a picture whose PNG is not in the pod folder', async () => {
      const root = seed({ source: 'ticket', phase: 3 });
      writePng(root, PICTURES[0]?.before ?? '');
      const errors = refusal();

      await expect(postWithPictures(root)).rejects.toThrow('exit');
      expect(errors.join('\n')).toContain(
        'designs/trail-map/trail-closed.annotated.png'
      );
      expect(createPodStore(root).listQuestions(POD)).toEqual([]);
    });
  });

  it("keeps a screen's decisions, and refuses one that isn't on the checkpoint", async () => {
    const root = seed({ source: 'ticket', phase: 3 });
    const store = createPodStore(root);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await withPod(root, () =>
      runDecide('Put the penguin feeding times on the zoo map', {
        autonomous: true,
        before: 'Feeding times were only on a sign by the penguin exhibit.',
        why: 'Visitors plan their walk from the map.',
        instead: 'A printed handout at the gate.',
        means: 'The zoo map shows when the penguins are fed.',
        intentRef: 'Visitors can find the penguin feeding times.',
      })
    );
    const [decision] = store.readAutonomousDecisions(POD);
    const post = (decisions: string[]) =>
      withPod(root, () =>
        runCheckpointPost({
          cp: '4',
          summary: 'One screen changes.',
          understood: 'You want visitors to find the penguin feeding times.',
          screensFile: writeJson(root, 'ux.json', {
            flows: [
              {
                name: 'Finding the penguin feeding',
                summary: 'Ann Perkins plans her walk to see the penguins fed.',
                screens: [
                  {
                    name: 'Zoo map',
                    change: 'changed',
                    before: '┌──┐\n│Map│\n└──┘',
                    after: '┌──┐\n│Feeding 2pm│\n└──┘',
                    changes: 'The penguin exhibit shows its feeding times.',
                    journey: {
                      who: 'Ann Perkins, a visitor.',
                      before: 'She opens the zoo map.',
                      here: 'She finds the feeding time.',
                      after: 'She is at the penguins by two.',
                    },
                    tickets: ['1'],
                    decisions,
                    coldRead: {
                      restatement: 'Ann finds the feeding time.',
                      unclear: [],
                    },
                  },
                ],
              },
            ],
          }),
          decisionsColdRead: writeJson(root, 'reads.json', [
            {
              id: decision?.id,
              situation: 'Feeding times were only on a sign.',
              restatement: 'The zoo map shows when the penguins are fed.',
              unclear: [],
              unexplained: [],
            },
          ]),
        })
      );
    const errors = refusal();

    await expect(post(['d-not-here'])).rejects.toThrow('exit');
    expect(errors.join('\n')).toMatch(/isn't on this checkpoint/);

    await post([decision?.id ?? '']);

    const posted = store
      .listQuestions(POD)
      .find((question) => question.checkpoint?.cp === 4);
    expect(posted?.checkpoint?.screens?.[0]?.decisions).toEqual([decision?.id]);
  });

  it('refuses a UX review without "what I understood"', async () => {
    const root = seed({ source: 'epic' });
    const errors = refusal();

    await expect(
      withPod(root, () =>
        runCheckpointPost({
          cp: '4',
          summary: 'No screens yet.',
          screensFile: writeJson(root, 'ux.json', { flows: [] }),
        })
      )
    ).rejects.toThrow('exit');
    expect(errors.join('\n')).toMatch(/--understood/);
  });
});

describe('lambda pod step', () => {
  it('needs --found when a repeated step finishes a pass', async () => {
    const root = seed();

    await withPod(root, () => {
      expect(() =>
        runStep('proposal-red-flags', 'done', { pass: '1' })
      ).toThrow(/--found/);
      expect(() => runStep('research', 'start', { pass: '1' })).toThrow(
        /not a repeated step/
      );
    });
  });

  it('records a skipped split proposal', async () => {
    const root = seed({ source: 'epic' });
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await withPod(root, () =>
      runStep('split-proposal', 'skip', { note: 'has 6 children' })
    );

    expect(createPodStore(root).readSteps(POD)).toMatchObject([
      { step: 'split-proposal', event: 'skip', note: 'has 6 children' },
    ]);
  });
});

describe('the Chat panel fork (fork-chat)', () => {
  it('tags its replies as chat, about the item it was asked about — or the whole pod', async () => {
    const root = seed();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const saved = { ...process.env };
    process.env.LAMBDA_PODS_ROOT = root;
    process.env.POD_ID = POD;
    process.env.POD_AGENT = 'fork-chat';

    try {
      runReply('Ticket 0 is a checklist because nothing in it is code.', {
        qid: 'q7',
      });
      runReply('Waiting on you at the split proposal.', {});
    } finally {
      process.env = saved;
    }

    const [aboutItem, aboutPod] = createPodStore(root).readThread(POD);
    expect(aboutItem).toMatchObject({ from: 'fork', chat: true, qid: 'q7' });
    // Not "chat" — the whole pod has no qid.
    expect(aboutPod?.chat).toBe(true);
    expect(aboutPod?.qid).toBeUndefined();
  });
});
