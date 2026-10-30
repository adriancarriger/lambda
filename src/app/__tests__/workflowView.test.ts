import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type Pod, createPodStore } from '../../pod-store';
import { buildWorkflowView } from '../server/workflowView';

const pod = (id: string, overrides: Partial<Pod> = {}): Pod => ({
  id,
  slug: id,
  createdAt: '2026-10-19T00:00:00.000Z',
  status: 'active',
  phase: 3,
  completedCheckpoints: [],
  worktreePath: `/tmp/${id}`,
  ownsWorktree: false,
  managerCwd: `/tmp/${id}`,
  devCwd: `/tmp/${id}`,
  agentCommand: 'claude',
  sessions: { manager: 'm', dev: 'd' },
  pipeline: 2,
  source: 'idea',
  ...overrides,
});

describe('buildWorkflowView', () => {
  it('carries the pod render mode for the Render switch, full when unset on a computer with Claude Design', () => {
    const store = createPodStore(
      fs.mkdtempSync(path.join(os.tmpdir(), 'pods-workflow-'))
    );
    store.writePod(pod('pawnee-a1b2', { renderMode: 'ascii' }));
    store.writePod(pod('eagleton-c3d4'));
    const time = { day: '2026-10-19', todayMs: 0, days: {}, pods: {} };
    const available = { design: { available: true } };

    expect(
      buildWorkflowView(store, 'pawnee-a1b2', time, available).renderMode
    ).toBe('ascii');
    expect(
      buildWorkflowView(store, 'eagleton-c3d4', time, available).renderMode
    ).toBe('full');
  });
});
