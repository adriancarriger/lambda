import * as fs from 'fs';

import { type PodStore, newId } from '../../pod-store';
import '../../pod/__tests__/podProject';
import { runChat } from '../../pod/questions';
import { buildingPodStore } from './fakes';

/**
 * The building page's answer box on a Blocked item: the owner's answer goes
 * to the Engineering manager, about that item, so it settles it. Without an
 * item the chat is still the Product manager's.
 */

const recorded: { pmChats: { podId: string; text: string }[] } = {
  pmChats: [],
};

jest.mock('../productManager', () => ({
  runPmChat: async (podId: string, text: string) => {
    recorded.pmChats = [...recorded.pmChats, { podId, text }];
  },
}));

// No tmux in tests: record what would be delivered.
jest.mock('../../pod/messaging', () => ({
  ...jest.requireActual('../../pod/messaging'),
  sendMessage: async (
    store: PodStore,
    args: {
      podId: string;
      target: string;
      text: string;
      wireText?: string;
      about?: string;
      mode: 'async' | 'sync' | 'note';
    }
  ) =>
    store.appendThread({
      id: newId('m'),
      podId: args.podId,
      from: 'human',
      mode: args.mode,
      text: args.text,
      wire: args.wireText ?? args.text,
      target: args.target,
      ...(args.about === undefined ? {} : { about: args.about }),
      createdAt: new Date().toISOString(),
    }),
}));

const roots: string[] = [];

const blockedPod = (): { store: PodStore; podId: string } => {
  const { store, root, podId } = buildingPodStore();
  roots.splice(roots.length, 0, root);
  store.updateBuilding(podId, (state) => ({
    ...state,
    runs: [
      {
        id: 'PNE-12',
        title: 'Map the Pawnee Commons trails',
        step: 'dev',
        attempt: 1,
        startedAt: '2026-10-23T10:00:00.000Z',
        blocked: {
          at: '2026-10-23T11:00:00.000Z',
          what: 'w',
          problem: 'p',
          options: 'o',
          recommendation: 'r',
          messageId: 'm-blocked',
        },
      },
    ],
  }));
  store.appendThread({
    id: 'm-blocked',
    podId,
    from: 'engineering-manager',
    mode: 'note',
    text: 'PNE-12 is blocked.',
    expectsReply: true,
    createdAt: '2026-10-23T11:00:00.000Z',
  });
  process.env.LAMBDA_PODS_ROOT = store.root;

  return { store, podId };
};

const saved = { ...process.env };

beforeEach(() => {
  recorded.pmChats = [];
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  process.env = { ...saved };
  roots
    .splice(0)
    .forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

it('sends an answer on a Blocked item to the Engineering manager, about it', async () => {
  const { store, podId } = blockedPod();

  await runChat(podId, 'Use the lot behind City Hall.', 'm-blocked');

  const answer = store.readThread(podId).at(-1);
  expect(answer).toMatchObject({
    from: 'human',
    about: 'm-blocked',
    target: 'engineering-manager',
    text: 'Use the lot behind City Hall.',
  });
  expect(answer?.wire).toContain('PNE-12');
  expect(answer?.wire).toContain('Use the lot behind City Hall.');
  expect(recorded.pmChats).toEqual([]);
});

it('still sends a chat with no item to the Product manager', async () => {
  const { store, podId } = blockedPod();

  await runChat(podId, 'How is it going?');

  expect(recorded.pmChats).toEqual([{ podId, text: 'How is it going?' }]);
  expect(store.readThread(podId).at(-1)?.id).toBe('m-blocked');
});

it('sends a chat about an unknown item to the Product manager', async () => {
  const { podId } = blockedPod();

  await runChat(podId, 'How is it going?', 'm-nope');

  expect(recorded.pmChats).toEqual([{ podId, text: 'How is it going?' }]);
});
