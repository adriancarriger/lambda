/**
 * CP5's dependency links go through `lambda tickets block --checkpoint`,
 * whose gate reads Lambda's pod store: a checkpoint `lambda pod checkpoint
 * complete` closed passes, an open one is refused — in a markdown-tickets
 * project too. Run the way the dev runs it: the command's own deps, `POD_ID`
 * set, the owner named (or not) in the machine settings.
 */
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';

import { registerTicketsCommand } from '../../commands/tickets';
import { createPodStore } from '../../pod-store';
import { runCheckpointComplete } from '../questions';
import { setOwnerName, usePodProject } from './podProject';

jest.mock('../messaging', () => ({
  ...jest.requireActual('../messaging'),
  sendMessage: jest.fn(async () => ({ id: 'm1' })),
}));

const POD = 'pawnee-a1b2';
const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
  setOwnerName(undefined);
  jest.restoreAllMocks();
});

/** `lambda tickets block PAWNEE-2 --by PAWNEE-1 --checkpoint q9`, as the dev. */
const block = (): Promise<unknown> => {
  const program = new Command().exitOverride();
  registerTicketsCommand(program);
  process.env.POD_ID = POD;

  return program.parseAsync([
    'node',
    'lambda',
    'tickets',
    'block',
    'PAWNEE-2',
    '--by',
    'PAWNEE-1',
    '--checkpoint',
    'q9',
  ]);
};

/** A markdown-tickets project whose pod has CP5 open as q9. */
const openCp5 = (): string => {
  const root = usePodProject({ tickets: { source: 'markdown' } });
  fs.writeFileSync(
    path.join(root, 'TASKS.md'),
    '# Pawnee Parks app\n\n- [ ] PAWNEE-1: Park map page\n  - [ ] PAWNEE-2: Pins\n'
  );
  delete process.env.LAMBDA_PODS_ROOT;
  delete process.env.POD_ID;
  const store = createPodStore(path.join(root, '.lambda', 'pods'));
  store.writePod({
    id: POD,
    slug: 'pawnee',
    createdAt: '2026-10-03T00:00:00.000Z',
    status: 'active',
    phase: 5,
    completedCheckpoints: [1, 2, 3, 4],
    worktreePath: root,
    ownsWorktree: false,
    managerCwd: root,
    devCwd: root,
    agentCommand: 'claude',
    sessions: { manager: 'm', dev: 'd' },
    epicId: 'PAWNEE-1',
    pipeline: 2,
    source: 'epic',
  });
  store.writeQuestion({
    id: 'q9',
    podId: POD,
    kind: 'checkpoint',
    phase: 5,
    status: 'open',
    blocksCheckpoint: true,
    dependsOn: [],
    createdAt: '2026-10-03T00:00:00.000Z',
    options: [],
    checkpoint: { cp: 5, decisionIds: [] },
  });

  return root;
};

it('refuses an open CP5, and passes it once lambda pod checkpoint complete closed it', async () => {
  openCp5();
  const printed: string[] = [];
  jest.spyOn(console, 'log').mockImplementation((line: string) => {
    printed.splice(printed.length, 0, line);
  });

  await expect(block()).rejects.toThrow(
    "q9 (CP5) is open — the owner hasn't closed it yet."
  );

  delete process.env.POD_ID;
  await runCheckpointComplete(POD, '5');
  await block();

  expect(printed).toContain('PAWNEE-2 is now blocked by PAWNEE-1.');
});

it('names the owner in the refusal when a name is set', async () => {
  openCp5();
  setOwnerName('Leslie Knope');

  await expect(block()).rejects.toThrow(
    "q9 (CP5) is open — Leslie Knope hasn't closed it yet."
  );
});
