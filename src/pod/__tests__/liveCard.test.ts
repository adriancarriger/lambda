import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type Pod, createPodStore } from '../../pod-store';
import { runCheckpointPost } from '../questions';
import './podProject';

/**
 * A checkpoint's card is edited like a doc: posting records the files it was
 * built from, and `lambda pod checkpoint refresh` re-reads them — same checks —
 * updating the card in place. A bad edit keeps the last good card and says why.
 */

const POD = 'pawnee-a1b2';

const seed = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-live-card-'));
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
  } satisfies Pod);

  return root;
};

const withPod = async (root: string, body: () => Promise<void>) => {
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

const ticket = (number: string, title: string) => ({
  number,
  title,
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
});

const writeProposal = (file: string, tickets: unknown[]): void =>
  fs.writeFileSync(file, JSON.stringify({ tickets }));

const card = (root: string) => createPodStore(root).listQuestions(POD)[0];

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

it('an edit to the proposal file updates the same card in place', async () => {
  const root = seed();
  const proposal = path.join(root, 'proposal.json');
  writeProposal(proposal, [
    ticket('1', 'Closed trails show on the trail map'),
    ticket('2', 'Leslie gets a closure notice'),
  ]);

  await withPod(root, () =>
    runCheckpointPost({
      cp: '3',
      summary: 'Two tickets.',
      proposalFile: proposal,
    })
  );
  const before = card(root);
  expect(before?.checkpoint?.sources?.proposalFile).toBe(proposal);

  writeProposal(proposal, [
    ticket('1', 'Closed trails show on the trail map'),
    ticket('2', 'Ron gets a closure notice a day early'),
  ]);
  await withPod(root, () =>
    runCheckpointPost({ cp: '3', summary: '', refresh: true })
  );

  const after = card(root);
  expect(after?.id).toBe(before?.id);
  expect(after?.summary).toBe('Two tickets.');
  expect(after?.checkpoint?.proposal?.[1]?.title).toBe(
    'Ron gets a closure notice a day early'
  );
  expect(after?.checkpoint?.refreshedAt).toBeDefined();
  expect(after?.checkpoint?.refreshError).toBeUndefined();
});

it('a bad edit keeps the last good card, and says why', async () => {
  const root = seed();
  const proposal = path.join(root, 'proposal.json');
  writeProposal(proposal, [ticket('1', 'Closed trails show on the trail map')]);

  await withPod(root, () =>
    runCheckpointPost({
      cp: '3',
      summary: 'One ticket.',
      proposalFile: proposal,
    })
  );

  // A numbering gap fails the same check posting does.
  writeProposal(proposal, [
    ticket('1', 'Closed trails show on the trail map'),
    ticket('3', 'Ann gets a trail notice'),
  ]);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(process, 'exit').mockImplementation((): never => {
    throw new Error('exit');
  });

  await expect(
    withPod(root, () =>
      runCheckpointPost({ cp: '3', summary: '', refresh: true })
    )
  ).rejects.toThrow('exit');

  const after = card(root);
  expect(after?.checkpoint?.proposal?.map((t) => t.number)).toEqual(['1']);
  expect(after?.checkpoint?.refreshError).toMatch(/Number the tickets/);
});

it('a UX review edit that adds a second picture updates the same card', async () => {
  const root = seed();
  createPodStore(root).updatePod(POD, (pod) => ({ ...pod, source: 'ticket' }));
  const picture = (situation: string, slug: string) => {
    const after = `designs/trail-map/${slug}.annotated.png`;
    fs.mkdirSync(path.join(root, POD, 'designs/trail-map'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(root, POD, after), 'png');

    return { situation, after, legend: [{ n: 1, label: 'Show detour' }] };
  };
  const screensFile = path.join(root, 'ux-review.json');
  const writeScreens = (pictures: unknown[]): void =>
    fs.writeFileSync(
      screensFile,
      JSON.stringify({
        flows: [
          {
            name: 'Checking a closed trail',
            summary: 'Ann Perkins checks a closed trail.',
            screens: [
              {
                name: 'Trail map',
                change: 'new',
                after: '┌──┐\n│Closed│\n└──┘',
                changes: 'Ann sees why the trail is closed.',
                journey: {
                  who: 'Ann Perkins, a volunteer.',
                  before: 'Her trail was closed.',
                  here: 'She opens the detour.',
                  after: 'Leslie sees it inspected.',
                },
                tickets: ['1'],
                coldRead: { restatement: 'Ann takes the detour.', unclear: [] },
                pictures,
              },
            ],
          },
        ],
      })
    );
  writeScreens([picture('Trail closed', 'trail-closed')]);

  await withPod(root, () =>
    runCheckpointPost({
      cp: '4',
      summary: 'One screen.',
      understood: 'You want Ann to see why the trail is closed.',
      screensFile,
    })
  );
  const before = card(root);

  const pictures = [
    picture('Trail closed', 'trail-closed'),
    picture('Trail open', 'trail-open'),
  ];
  writeScreens(pictures);
  await withPod(root, () =>
    runCheckpointPost({ cp: '4', summary: '', refresh: true })
  );

  const after = card(root);
  expect(after?.id).toBe(before?.id);
  expect(after?.checkpoint?.screens?.[0]?.pictures).toHaveLength(2);
  expect(after?.checkpoint?.screens?.[0]?.pictures).toEqual(pictures);
});

it('says how to fix a card posted before live editing', async () => {
  const root = seed();
  const store = createPodStore(root);
  store.writeQuestion({
    id: 'q1',
    podId: POD,
    kind: 'checkpoint',
    phase: 3,
    status: 'open',
    blocksCheckpoint: true,
    dependsOn: [],
    createdAt: '2026-10-07T00:00:00.000Z',
    options: [],
    checkpoint: { cp: 3, decisionIds: [] },
  });

  await expect(
    withPod(root, () =>
      runCheckpointPost({ cp: '3', summary: '', refresh: true })
    )
  ).rejects.toThrow(/post it once more/);
});
