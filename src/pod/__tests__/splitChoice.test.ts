import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type Pod, createPodStore } from '../../pod-store';
import { sendMessage } from '../messaging';
import { runCheckpointComplete } from '../questions';
import './podProject';

/** A lone ticket's split proposal (CP3) closes as the split or as one ticket. */

// No tmux in tests: closing a checkpoint wakes the manager by message.
jest.mock('../messaging', () => ({
  sendMessage: jest.fn(async () => ({ id: 'm1' })),
  deliverEntry: jest.fn(),
  chatTopic: jest.fn(),
}));

const POD = 'pawnee-a1b2';

const lone: Pod = {
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
  source: 'ticket',
  epicId: 'PAWNEE-37',
};

const close = async (
  pod: Pod,
  cp: string,
  options: { keepOne?: boolean } = {}
): Promise<Pod> => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-split-'));
  const store = createPodStore(root);
  store.writePod(pod);
  const saved = { ...process.env };
  process.env.LAMBDA_PODS_ROOT = root;
  process.env.POD_ID = POD;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);

  try {
    await runCheckpointComplete(POD, cp, options);
  } finally {
    process.env = saved;
  }

  return store.requirePod(POD);
};

const lastMessage = (): string =>
  jest.mocked(sendMessage).mock.calls.at(-1)?.[1].text ?? '';

beforeEach(() => jest.mocked(sendMessage).mockClear());

it('accepting the split makes the lone ticket an epic', async () => {
  const pod = await close(lone, '3');

  expect(pod.split).toBe('accepted');
  expect(pod.source).toBe('epic');
  expect(pod.epicId).toBe('PAWNEE-37');
  expect(lastMessage()).toMatch(/accepted the split/);
});

it('keeping one ticket leaves it a lone ticket and drops the proposal', async () => {
  const pod = await close(lone, '3', { keepOne: true });

  expect(pod.split).toBe('one-ticket');
  expect(pod.source).toBe('ticket');
  expect(pod.completedCheckpoints).toContain(3);
  expect(lastMessage()).toMatch(/kept it ONE ticket/);
});

it('an epic closes CP3 without a split choice', async () => {
  const pod = await close({ ...lone, source: 'epic' }, '3');

  expect(pod.split).toBeUndefined();
  expect(lastMessage()).not.toMatch(/split|ONE ticket/);
});

it('refuses --keep-one anywhere but a lone ticket CP3', async () => {
  await expect(close(lone, '5', { keepOne: true })).rejects.toThrow(
    /checkpoint 3/
  );
  await expect(
    close({ ...lone, source: 'epic' }, '3', { keepOne: true })
  ).rejects.toThrow(/lone ticket/);
});
