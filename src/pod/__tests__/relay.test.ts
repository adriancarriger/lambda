import { buildingPodStore } from '../../building/__tests__/fakes';
import { type PodStore, parseMsgId } from '../../pod-store';
import { runReply } from '../messaging';
import { RELAY_PREFIX, runRelay } from '../relay';
import './podProject';

/**
 * The Product manager relays the owner's calls to the Engineering manager;
 * every role's `lambda pod reply` is credited to that role.
 */

const windows = new Set<string>();
const recorded: { pasted: { target: string; text: string }[] } = {
  pasted: [],
};
const state: { store: PodStore | null } = { store: null };

jest.mock('../tmux', () => ({
  ...jest.requireActual('../tmux'),
  hasWindow: (_session: string, window: string) => windows.has(window),
  sendKey: () => undefined,
  sleep: async () => undefined,
  // The agent takes the message at once: its hook marks it received.
  sendToPane: async (target: string, text: string) => {
    recorded.pasted = [...recorded.pasted, { target, text }];
    const msgId = parseMsgId(text);

    if (msgId !== null && state.store !== null) {
      state.store.appendDelivery('build-a1b2', {
        msgId,
        status: 'received',
        at: new Date().toISOString(),
      });
    }
  },
}));

const setUp = () => {
  const made = buildingPodStore();
  state.store = made.store;
  process.env.LAMBDA_PODS_ROOT = made.store.root;
  windows.clear();
  // The Engineering manager's window is `manager`.
  ['manager', 'dev', 'qa', 'product-manager'].forEach((name) =>
    windows.add(name)
  );
  recorded.pasted = [];

  return made;
};

afterEach(() => {
  delete process.env.LAMBDA_PODS_ROOT;
  delete process.env.POD_ID;
  delete process.env.POD_AGENT;
});

describe('lambda pod relay', () => {
  it("delivers the owner's call to the Engineering manager, prefixed", async () => {
    const { podId } = setUp();

    await runRelay('skip the next ticket', { pod: podId });

    expect(recorded.pasted).toHaveLength(1);
    expect(recorded.pasted[0]?.target).toBe(`lambda-pod-${podId}:manager`);
    expect(recorded.pasted[0]?.text).toContain(
      `${RELAY_PREFIX} skip the next ticket`
    );
    expect(RELAY_PREFIX).toBe('From the owner, via the Product manager:');
  });

  it('refuses on a paused pod and delivers nothing', async () => {
    const { store, podId } = setUp();
    store.updatePod(podId, (pod) => ({ ...pod, status: 'paused' }));
    windows.clear();

    await expect(
      runRelay('skip the next ticket', { pod: podId })
    ).rejects.toThrow('This pod is paused. Resume it first, then ask again.');
    expect(recorded.pasted).toEqual([]);
  });

  it('refuses on an ended pod, saying so rather than "paused"', async () => {
    const { store, podId } = setUp();
    store.updatePod(podId, (pod) => ({ ...pod, status: 'done' }));

    await expect(
      runRelay('skip the next ticket', { pod: podId })
    ).rejects.toThrow('This pod has ended, so there is no one to relay to.');
    expect(recorded.pasted).toEqual([]);
  });
});

describe('lambda pod reply from a building pod’s roles', () => {
  it.each(['engineering-manager', 'qa', 'product-manager'])(
    'credits %s',
    (agent) => {
      const { store, podId } = setUp();
      process.env.POD_ID = podId;
      process.env.POD_AGENT = agent;

      runReply('Engineering manager: skipped ticket 4', { fyi: true });

      expect(store.readThread(podId).at(-1)?.from).toBe(agent);
    }
  );
});
