import * as fs from 'fs';

import { type PodStore, newId } from '../../pod-store';
import '../../pod/__tests__/podProject';
import { PM_IDLE_MS, sleepIdleProductManager } from '../productManager';
import { runTalkTicket, talkLockFile } from '../talkAboutTicket';
import { buildingPodStore, fakeSource, ticket } from './fakes';

/**
 * "Talk about this ticket" goes to whoever has the ticket in hand: the
 * building pod's Product manager, the planning dev, or — with neither — a
 * one-shot Product manager briefed with that ticket.
 */

const windows = new Set<string>();
const recorded: {
  launches: { podId: string; agent: string; command: string }[];
  sent: { podId: string; target: string; wire: string }[];
  chats: { podId: string; text: string }[];
  out: string[];
} = { launches: [], sent: [], chats: [], out: [] };

jest.mock('../../pod/launch', () => {
  const actual = jest.requireActual('../../pod/launch');

  return {
    ...actual,
    launchAgent: async (args: {
      pod: { id: string };
      store: PodStore;
      agent: string;
      mode: { kind: 'fresh'; sessionId: string };
    }) => {
      windows.add(`${args.pod.id}:${args.agent}`);
      recorded.launches = [
        ...recorded.launches,
        {
          podId: args.pod.id,
          agent: args.agent,
          command: actual.agentCommandLine(
            args.pod,
            args.store,
            args.agent,
            args.mode
          ),
        },
      ];

      return true;
    },
  };
});

jest.mock('../../pod/messaging', () => ({
  ...jest.requireActual('../../pod/messaging'),
  sendMessage: async (
    store: PodStore,
    args: { podId: string; target: string; text: string; wireText?: string }
  ) => {
    recorded.sent = [
      ...recorded.sent,
      {
        podId: args.podId,
        target: args.target,
        wire: args.wireText ?? args.text,
      },
    ];

    return store.appendThread({
      id: newId('m'),
      podId: args.podId,
      from: 'human',
      mode: 'sync',
      text: args.text,
      target: args.target,
      createdAt: new Date().toISOString(),
    });
  },
}));

jest.mock('../../pod/questions', () => ({
  runChat: async (podId: string, text: string) => {
    recorded.chats = [...recorded.chats, { podId, text }];
  },
}));

jest.mock('../../pod/tmux', () => ({
  ...jest.requireActual('../../pod/tmux'),
  hasWindow: (session: string, window: string) =>
    windows.has(`${session.replace(/^lambda-pod-/, '')}:${window}`),
  killWindow: (target: string) => {
    const [session = '', window = ''] = target
      .split(':')
      .map((part) => part.replace(/^=/, ''));
    windows.delete(`${session.replace(/^lambda-pod-/, '')}:${window}`);
  },
}));

const source = fakeSource([
  ticket('3', { title: 'Trail markers' }),
  ticket('7', { title: 'Harvest festival banner', status: 'planning' }),
  ticket('5', { title: 'Lot 48 photos' }),
]);

const reset = () => {
  windows.clear();
  recorded.launches = [];
  recorded.sent = [];
  recorded.chats = [];
};

const talk = (store: PodStore, ticketId: string, text: string) =>
  runTalkTicket(ticketId, text, {
    store,
    source,
    print: (line) => {
      recorded.out = [...recorded.out, line];
    },
  });

afterEach(() => {
  delete process.env.LAMBDA_PODS_ROOT;
});

describe('Talk about this ticket', () => {
  it("goes to the building pod's Product manager", async () => {
    reset();
    const { store, podId } = buildingPodStore();
    process.env.LAMBDA_PODS_ROOT = store.root;

    await talk(store, '3', 'why is this taking so long?');

    expect(recorded.sent.map(({ podId: to, target }) => [to, target])).toEqual([
      [podId, 'product-manager'],
    ]);
    expect(recorded.sent[0]?.wire).toContain('3 Trail markers');
    expect(JSON.parse(recorded.out.at(-1) ?? '')).toEqual({
      podId,
      target: 'product-manager',
    });
  });

  it('goes to the planning dev while the ticket is in planning, even with a building pod on the project', async () => {
    reset();
    // The building pod is live: planning still has the ticket in hand.
    const { store } = buildingPodStore('build-a1b2', 'r-leslie-mac');
    process.env.LAMBDA_PODS_ROOT = store.root;
    const planning = store.requirePod('build-a1b2');
    store.writePod({
      ...planning,
      id: 'pickup-c3d4',
      kind: undefined,
      runnerId: undefined,
      status: 'active',
      epicId: '7',
      sessions: { manager: 'm', dev: 'd' },
    });

    await talk(store, '7', 'can the banner be green?');

    expect(recorded.chats).toEqual([
      {
        podId: 'pickup-c3d4',
        text: expect.stringContaining('can the banner be green?'),
      },
    ]);
    expect(recorded.sent).toEqual([]);
    expect(JSON.parse(recorded.out.at(-1) ?? '')).toEqual({
      podId: 'pickup-c3d4',
      target: 'dev',
    });
  });

  it('starts a one-shot Product manager when no pod has it, closed after 30 idle minutes', async () => {
    reset();
    const { store } = buildingPodStore('build-a1b2', 'r-leslie-mac', {
      status: 'done',
    });
    process.env.LAMBDA_PODS_ROOT = store.root;

    await talk(store, '5', 'what does this need?');

    const { podId } = JSON.parse(recorded.out.at(-1) ?? '');
    const pod = store.requirePod(podId);
    expect(pod.talk).toEqual({ ticketId: '5' });
    expect(recorded.launches).toEqual([
      {
        podId,
        agent: 'product-manager',
        command: expect.stringContaining('pm-settings.json'),
      },
    ]);
    expect(recorded.sent[0]?.wire).toContain('5 Lot 48 photos');
    expect(recorded.sent[0]?.wire).toContain('What ticket 5 does.');

    const at = Date.parse(
      store.readBuilding(podId).productManager?.lastActivityAt ?? ''
    );
    expect(sleepIdleProductManager(store, podId, at + PM_IDLE_MS)).toBe(true);
    expect(windows.has(`${podId}:product-manager`)).toBe(false);
  });

  it('finds or makes the one-shot pod under a per-ticket lock, so two clicks share one', async () => {
    reset();
    const { store } = buildingPodStore('build-a1b2', 'r-leslie-mac', {
      status: 'done',
    });
    process.env.LAMBDA_PODS_ROOT = store.root;
    const lock = `${talkLockFile(store, '5')}.lock`;
    const locked: { atWrite: boolean[] } = { atWrite: [] };
    const watched: PodStore = {
      ...store,
      writePod: (pod) => {
        locked.atWrite = [...locked.atWrite, fs.existsSync(lock)];
        store.writePod(pod);
      },
    };

    await talk(watched, '5', 'what does this need?');
    await talk(watched, '5', 'and the photos?');

    expect(locked.atWrite).toEqual([true]);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('takes a fresh pod id when the first one it draws is taken', async () => {
    reset();
    const { store } = buildingPodStore('build-a1b2', 'r-leslie-mac', {
      status: 'done',
    });
    process.env.LAMBDA_PODS_ROOT = store.root;
    const earlier = store.requirePod('build-a1b2');
    store.writePod({
      ...earlier,
      id: 'talk-aaaa',
      talk: { ticketId: '3' },
    });
    const draws = ['aaaa', 'bbbb'];

    await runTalkTicket('5', 'what does this need?', {
      store,
      source,
      print: (line) => {
        recorded.out = [...recorded.out, line];
      },
      randomHex: () => draws.shift() ?? 'zzzz',
    });

    expect(JSON.parse(recorded.out.at(-1) ?? '').podId).toBe('talk-bbbb');
    expect(store.requirePod('talk-aaaa').talk).toEqual({ ticketId: '3' });
  });
});
