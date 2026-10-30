import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type Pod, createPodStore } from '../../pod-store';
import { runRequestAdd, runRequestDone, runRequestStart } from '../requests';
import './podProject';

// No tmux in tests: record what would have been pasted into an agent.
const sent: { target: string; command: string; text: string }[] = [];
jest.mock('../messaging', () => ({
  sendMessage: jest.fn(
    async (
      _store: unknown,
      args: { target: string; command: string; text: string }
    ) => {
      sent.splice(sent.length, 0, args);

      return { id: 'm1' };
    }
  ),
}));

const POD = 'pawnee-a1b2';

const seed = (overrides: Partial<Pod> = {}): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-req-'));
  createPodStore(root).writePod({
    id: POD,
    slug: 'pawnee',
    createdAt: '2026-10-07T00:00:00.000Z',
    status: 'active',
    phase: 3,
    completedCheckpoints: [3],
    worktreePath: '/tmp/pawnee',
    ownsWorktree: false,
    managerCwd: '/tmp/pawnee',
    devCwd: '/tmp/pawnee',
    agentCommand: 'claude',
    sessions: { manager: 'm', dev: 'd' },
    pipeline: 2,
    source: 'epic',
    ...overrides,
  });

  return root;
};

const withPod = async (
  root: string,
  agent: string,
  body: () => Promise<void>
): Promise<void> => {
  const saved = { ...process.env };
  process.env.LAMBDA_PODS_ROOT = root;
  process.env.POD_ID = POD;
  process.env.POD_AGENT = agent;

  try {
    await body();
  } finally {
    process.env = saved;
  }
};

beforeEach(() => {
  sent.splice(0, sent.length);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe('work requests', () => {
  it("queues with the owner's words and wakes the manager; starting hands it to the dev", async () => {
    const root = seed();

    await withPod(root, 'fork-chat', () =>
      runRequestAdd('Rebase on Epic 1 and its children', {
        quote: 'rebase this on epic 1 and its tickets',
        qid: 'q12',
      })
    );
    const store = createPodStore(root);
    expect(store.activeRequest(POD)).toMatchObject({
      id: 'r1',
      status: 'queued',
      qid: 'q12',
    });
    expect(sent.at(-1)).toMatchObject({
      target: 'manager',
      command: '/pod-request-queued',
    });

    await withPod(root, 'manager', () => runRequestStart('r1', {}));
    expect(store.readRequest(POD, 'r1')?.status).toBe('working');
    expect(sent.at(-1)).toMatchObject({
      target: 'dev',
      command: '/pod-request',
    });
  });

  it('done: withdraws the stale checkpoint, tells the chat and the manager', async () => {
    const root = seed();
    const store = createPodStore(root);
    store.writeQuestion({
      id: 'q12',
      podId: POD,
      kind: 'checkpoint',
      phase: 3,
      status: 'open',
      blocksCheckpoint: true,
      dependsOn: [],
      createdAt: '2026-10-07T01:00:00.000Z',
      options: [],
      checkpoint: { cp: 4, decisionIds: [] },
    });
    store.writeRequest({
      id: 'r1',
      podId: POD,
      summary: 'Rebase on Epic 1',
      quote: 'rebase on epic 1',
      status: 'working',
      createdAt: '2026-10-07T02:00:00.000Z',
    });

    await withPod(root, 'dev', () =>
      runRequestDone('r1', {
        result: '4 tickets changed, 2 decisions logged',
        invalidates: 'tickets,ux-review',
      })
    );

    // The UX review's checkpoint (CP4) was stale: withdrawn, to be re-posted.
    expect(store.readQuestion(POD, 'q12')?.status).toBe('withdrawn');
    expect(store.activeRequest(POD)).toBeUndefined();
    expect(store.readRequest(POD, 'r1')?.invalidates).toEqual([
      'tickets',
      'ux-review',
    ]);
    expect(
      store.readThread(POD).find((message) => message.chat === true)?.text
    ).toMatch(/^Done: Rebase on Epic 1\. 4 tickets changed/);
    expect(sent.at(-1)).toMatchObject({
      target: 'manager',
      command: '/pod-request-done',
    });
  });

  it('refuses a stage this pod does not have', async () => {
    const root = seed();
    createPodStore(root).writeRequest({
      id: 'r1',
      podId: POD,
      summary: 'x',
      quote: 'x',
      status: 'working',
      createdAt: '2026-10-07T02:00:00.000Z',
    });

    // An existing epic has no CP2 stage of its own… and no "split".
    await expect(
      withPod(root, 'dev', () =>
        runRequestDone('r1', { result: 'done', invalidates: 'split' })
      )
    ).rejects.toThrow(/Unknown stage split/);
  });
});
