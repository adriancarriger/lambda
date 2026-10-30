import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type Pod, createPodStore, readKnowledge } from '../../pod-store';
import { runCheckpointComplete } from '../questions';
import './podProject';

// No tmux in tests: closing a checkpoint wakes the manager by message.
jest.mock('../messaging', () => ({
  sendMessage: jest.fn(async () => ({ id: 'm1' })),
  deliverEntry: jest.fn(),
  chatTopic: jest.fn(),
}));

const POD = 'pawnee-a1b2';

const pod: Pod = {
  id: POD,
  slug: 'pawnee',
  createdAt: '2026-10-07T00:00:00.000Z',
  status: 'active',
  phase: 5,
  completedCheckpoints: [4],
  worktreePath: '/tmp/pawnee',
  ownsWorktree: false,
  managerCwd: '/tmp/pawnee',
  devCwd: '/tmp/pawnee',
  agentCommand: 'claude',
  sessions: { manager: 'm', dev: 'd' },
  pipeline: 2,
  source: 'epic',
  epicId: 'PAWNEE-46',
};

it('closing the final checkpoint keeps exactly the judgements the owner ticked', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-judgements-'));
  const store = createPodStore(root);
  store.writePod(pod);
  store.writeQuestion({
    id: 'q20',
    podId: POD,
    kind: 'checkpoint',
    phase: 5,
    status: 'open',
    blocksCheckpoint: true,
    dependsOn: [],
    createdAt: '2026-10-07T20:00:00.000Z',
    options: [],
    checkpoint: {
      cp: 5,
      decisionIds: [],
      suggestedJudgements: [
        {
          kind: 'judgement',
          statement:
            'A closed trail stays on the map, greyed out, never hidden.',
          why: 'Hikers plan their walks around what the map shows.',
          quote: 'Just grey it out, people still need to see it.',
        },
        {
          kind: 'judgement',
          statement: 'Never put a marker on the map without its trail name.',
          why: 'A nameless marker only confuses hikers.',
          quote: 'every marker needs the trail name on it',
        },
      ],
      keptJudgements: [0],
    },
  });
  const saved = { ...process.env };
  process.env.LAMBDA_PODS_ROOT = root;
  process.env.POD_ID = POD;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);

  try {
    await runCheckpointComplete(POD, '5');
  } finally {
    process.env = saved;
  }

  const kept = readKnowledge(path.join(root, '_knowledge'));
  expect(kept.map((entry) => entry.statement)).toEqual([
    'A closed trail stays on the map, greyed out, never hidden.',
  ]);
  expect(kept[0]?.quote).toBe('Just grey it out, people still need to see it.');
  expect(kept[0]?.source).toMatch(/PAWNEE-46/);
  expect(store.requirePod(POD).completedCheckpoints).toContain(5);
});
