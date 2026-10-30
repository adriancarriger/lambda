import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type Pod, type ThreadEntry, createPodStore } from '../../pod-store';
import { runChatHandoff } from '../fork';
import { deliverEntry } from '../messaging';
import './podProject';

/**
 * The chat hand-off gives the dev each chat message once. Its "last hand-off"
 * used to live only on the chat fork's record, so a re-created fork forgot it
 * and every later hand-off re-sent the whole chat.
 */

// No tmux in tests.
jest.mock('../messaging', () => ({
  sendMessage: jest.fn(),
  deliverEntry: jest.fn(async () => undefined),
  chatTopic: jest.fn(),
}));

const POD = 'pawnee-a1b2';

const pod: Pod = {
  id: POD,
  slug: 'pawnee',
  createdAt: '2026-10-15T00:00:00.000Z',
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
};

const chat = (id: string, at: string): ThreadEntry => ({
  id,
  podId: POD,
  from: 'human',
  mode: 'sync',
  chat: true,
  text: `Leslie asks about ${id}`,
  createdAt: at,
});

const handOff = async (thread: ThreadEntry[]): Promise<ThreadEntry[]> => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-handoff-'));
  const store = createPodStore(root);
  store.writePod(pod);
  thread.forEach((entry) => store.appendThread(entry));
  const saved = { ...process.env };
  process.env.LAMBDA_PODS_ROOT = root;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);

  try {
    await runChatHandoff(POD);
  } finally {
    process.env = saved;
  }

  return store.readThread(POD);
};

beforeEach(() => jest.mocked(deliverEntry).mockClear());

it('hands the chat over once', async () => {
  const thread = await handOff([
    chat('m1', '2026-10-16T10:00:00.000Z'),
    chat('m2', '2026-10-16T10:01:00.000Z'),
  ]);

  expect(thread.at(-1)?.text).toBe(
    'Sent the dev what you said in the chat (2 messages).'
  );
  expect(deliverEntry).toHaveBeenCalledTimes(1);
});

it('never re-sends what an earlier hand-off already gave the dev', async () => {
  const thread = await handOff([
    chat('m1', '2026-10-16T10:00:00.000Z'),
    {
      id: 'm2',
      podId: POD,
      from: 'system',
      mode: 'note',
      text: 'Sent the dev what you said in the chat (1 messages).',
      target: 'dev',
      createdAt: '2026-10-16T10:05:00.000Z',
    },
  ]);

  expect(deliverEntry).not.toHaveBeenCalled();
  expect(
    thread.filter((entry) => entry.text.startsWith('Sent the dev'))
  ).toHaveLength(1);
});
