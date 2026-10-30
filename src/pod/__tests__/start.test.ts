import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type PodStore, createPodStore } from '../../pod-store';
import { ensurePodRunning } from '../lifecycle';
import './podProject';

/**
 * Starting a pod from the boot, `lambda pod resume` and the watchdog at once
 * must still leave one manager and one dev. tmux, the agent launch and
 * delivery are faked; the
 * lock, the health check, the retry and the re-send are real.
 */

const POD = 'pawnee-a1b2';
const SESSION = `lambda-pod-${POD}`;

const windows = new Map<string, string[]>();
const fake: {
  /** Agents whose window dies right after starting, once each. */
  crashOnce: Set<string>;
  killed: number;
  /** Each agent launched, with how: `manager:resume`. */
  launches: string[];
  /** Each message sent: `dev:/pod-restarted`, or `manager:opening`. */
  messages: string[];
} = { crashOnce: new Set<string>(), killed: 0, launches: [], messages: [] };

jest.mock('../tmux', () => ({
  hasSession: (session: string) => windows.has(session),
  hasWindow: (session: string, window: string) =>
    (windows.get(session) ?? []).includes(window),
  listWindows: (session: string) => windows.get(session) ?? [],
  windowCount: (session: string, window: string) =>
    (windows.get(session) ?? []).filter((name) => name === window).length,
  killSession: (session: string) => {
    if (windows.delete(session)) {
      fake.killed += 1;
    }
  },
  sendToPane: async () => undefined,
  sleep: async () => undefined,
}));

jest.mock('../launch', () => ({
  DEV_BOOTSTRAP: () => '',
  MANAGER_BOOTSTRAP: () => '',
  writePodSettings: () => undefined,
  launchAgent: async (args: {
    pod: { id: string };
    agent: string;
    mode: { kind: string };
  }) => {
    fake.launches.splice(
      fake.launches.length,
      0,
      `${args.agent}:${args.mode.kind}`
    );
    // Yield, so two starts racing really interleave.
    await new Promise((resolve) => setImmediate(resolve));
    const session = `lambda-pod-${args.pod.id}`;

    if (fake.crashOnce.delete(args.agent)) {
      return false;
    }

    windows.set(session, [...(windows.get(session) ?? []), args.agent]);

    return true;
  },
}));

const mockDeliverEntry = jest.fn(
  async (_store: unknown, _entry: { id: string }) => undefined
);

jest.mock('../messaging', () => ({
  sendMessage: async (
    _store: unknown,
    message: { target: string; command: string }
  ) => {
    fake.messages.splice(
      fake.messages.length,
      0,
      `${message.target}:${
        message.command === '' ? 'opening' : message.command
      }`
    );
  },
  deliverEntry: (store: unknown, entry: { id: string }) =>
    mockDeliverEntry(store, entry),
}));

const delivered = (): string[] =>
  mockDeliverEntry.mock.calls.map(([, entry]) => entry.id);

const seed = (): PodStore => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-pod-start-'));
  const store = createPodStore(root);
  store.writePod({
    id: POD,
    slug: 'pawnee',
    createdAt: '2026-10-03T00:00:00.000Z',
    status: 'active',
    phase: 4,
    completedCheckpoints: [1, 2, 3],
    worktreePath: '/tmp/pawnee',
    ownsWorktree: false,
    managerCwd: '/tmp/pawnee',
    devCwd: '/tmp/pawnee',
    agentCommand: 'claude',
    sessions: { manager: 'm', dev: 'd' },
  });

  return store;
};

const restartNotes = (store: PodStore): string[] =>
  store
    .readSteps(POD)
    .filter((event) => event.step === 'restart')
    .map((event) => event.note ?? '');

beforeEach(() => {
  windows.clear();
  fake.crashOnce.clear();
  fake.killed = 0;
  fake.launches = [];
  fake.messages = [];
  mockDeliverEntry.mockClear();
});

/** A conversation Claude Code saved, in the test's temp CLAUDE_CONFIG_DIR. */
const savedConversation = (sessionId: string): void => {
  const dir = path.join(
    process.env.CLAUDE_CONFIG_DIR ?? '',
    'projects',
    '-tmp-pawnee'
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '{}\n');
};

describe('ensurePodRunning', () => {
  it('resumes a saved conversation, and starts fresh one Claude Code never saw, with its opening', async () => {
    const store = seed();
    // The manager talked before; the dev's first start never got going.
    savedConversation('m');

    await ensurePodRunning(store, store.requirePod(POD));

    expect(fake.launches).toEqual(['manager:resume', 'dev:fresh']);
    expect(fake.messages.sort()).toEqual(
      ['dev:opening', 'manager:/pod-restarted'].sort()
    );
  });

  it('starts a pod once when two callers race (boot + watchdog)', async () => {
    const store = seed();
    const pod = store.requirePod(POD);

    const [first, second] = await Promise.all([
      ensurePodRunning(store, pod),
      ensurePodRunning(store, pod),
    ]);

    expect([first.result, second.result].sort()).toEqual([
      'started',
      'starting',
    ]);
    expect(windows.get(SESSION)).toEqual(['manager', 'dev']);
  });

  it('leaves a healthy pod alone', async () => {
    const store = seed();
    windows.set(SESSION, ['manager', 'dev']);

    const outcome = await ensurePodRunning(store, store.requirePod(POD));

    expect(outcome.result).toBe('running');
    expect(fake.killed).toBe(0);
  });

  it('replaces a doubled session instead of adding to it', async () => {
    const store = seed();
    windows.set(SESSION, ['manager', 'dev', 'manager', 'dev']);

    const outcome = await ensurePodRunning(store, store.requirePod(POD));

    expect(outcome.result).toBe('started');
    expect(fake.killed).toBe(1);
    expect(windows.get(SESSION)).toEqual(['manager', 'dev']);
  });

  it('retries a start whose window died, and logs it to the workflow', async () => {
    const store = seed();
    fake.crashOnce.add('manager');

    const outcome = await ensurePodRunning(store, store.requirePod(POD));

    expect(outcome.result).toBe('started');
    expect(windows.get(SESSION)).toEqual(['manager', 'dev']);
    expect(restartNotes(store)).toEqual([
      'Restart failed (after starting, its windows were: dev); trying once more.',
    ]);
  });

  it('gives up after one retry, with the reason on the workflow', async () => {
    const store = seed();
    const pod = store.requirePod(POD);
    fake.crashOnce.add('manager');
    // The retry's launch crashes too.
    jest
      .spyOn(fake.crashOnce, 'delete')
      .mockImplementation((agent) => agent === 'manager');

    await expect(ensurePodRunning(store, pod)).rejects.toThrow('did not start');
    expect(restartNotes(store)).toHaveLength(2);
    // The lock was released: the next attempt is not refused as "starting".
    jest.restoreAllMocks();
    expect((await ensurePodRunning(store, pod)).result).toBe('started');
  });

  it('re-sends an answer the dev never took in, but not stale restart notices', async () => {
    const store = seed();
    const recent = new Date(Date.now() - 60 * 60_000).toISOString();
    store.appendThread({
      id: 'mq4answer',
      podId: POD,
      qid: 'q4',
      from: 'human',
      mode: 'async',
      text: 'Either switch turns it on.',
      wire: '/human-async q4 [m:mq4answer]',
      target: 'dev',
      createdAt: recent,
    });
    store.appendDelivery(POD, {
      msgId: 'mq4answer',
      status: 'delivered',
      at: recent,
    });
    store.appendThread({
      id: 'mrestarted',
      podId: POD,
      from: 'system',
      mode: 'note',
      text: '',
      wire: '/pod-restarted [m:mrestarted]',
      target: 'dev',
      createdAt: recent,
    });

    const outcome = await ensurePodRunning(store, store.requirePod(POD));

    expect(outcome.resent).toEqual(['mq4answer']);
    expect(delivered()).toEqual(['mq4answer']);
    expect(restartNotes(store)).toEqual([
      'Re-sent 1 message(s) the agents never took in.',
    ]);
  });
});
