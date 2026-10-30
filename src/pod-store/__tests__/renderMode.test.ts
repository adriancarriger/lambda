import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildWorkflowView } from '../../app/server/workflowView';
import { LAMBDA_HOME } from '../../pod/__tests__/podProject';
import { runRenderMode } from '../../pod/lifecycle';
import { type Pod, podRenderMode } from '../schemas';
import { createPodStore } from '../store';

const POD = 'pawnee-a1b2';

const pod = (overrides: Partial<Pod> = {}): Pod => ({
  id: POD,
  slug: 'pawnee',
  createdAt: '2026-10-19T00:00:00.000Z',
  status: 'active',
  phase: 4,
  completedCheckpoints: [],
  worktreePath: '/tmp/pawnee',
  ownsWorktree: false,
  managerCwd: '/tmp/pawnee',
  devCwd: '/tmp/pawnee',
  agentCommand: 'claude',
  sessions: { manager: 'm', dev: 'd' },
  ...overrides,
});

const seededStore = (overrides: Partial<Pod> = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-render-'));
  const store = createPodStore(root);
  store.writePod(pod(overrides));

  return { root, store };
};

describe('podRenderMode', () => {
  it.each([
    [undefined, { design: { available: true } }, 'full'],
    [undefined, { design: { available: false } }, 'ascii'],
    [undefined, {}, 'ascii'],
    ['ascii' as const, { design: { available: true } }, 'ascii'],
    ['full' as const, { design: { available: false } }, 'full'],
  ])(
    'renderMode %s on a machine with %j renders %s',
    (renderMode, machine, expected) => {
      expect(
        podRenderMode(renderMode === undefined ? {} : { renderMode }, machine)
      ).toBe(expected);
    }
  );
});

describe('lambda pod render-mode', () => {
  const printed = (body: () => void): string[] => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      body();

      return log.mock.calls.map((call) => String(call[0]));
    } finally {
      log.mockRestore();
    }
  };

  const withMachine = (config: Record<string, unknown>, body: () => void) => {
    const file = path.join(LAMBDA_HOME, 'config.json');
    fs.writeFileSync(file, `${JSON.stringify(config)}\n`);

    try {
      body();
    } finally {
      fs.writeFileSync(file, '{}\n');
    }
  };

  it('prints ascii for a pod with no renderMode on a computer where Claude Design is unavailable', () => {
    const { root } = seededStore();
    const saved = process.env.LAMBDA_PODS_ROOT;
    process.env.LAMBDA_PODS_ROOT = root;

    try {
      withMachine(
        {
          design: {
            available: false,
            checkedAt: '2026-10-20T00:00:00.000Z',
            reason: 'no Artifact tool',
          },
        },
        () => expect(printed(() => runRenderMode(POD))).toEqual(['ascii'])
      );
    } finally {
      process.env.LAMBDA_PODS_ROOT = saved;
    }
  });

  it('prints full for a pod with no renderMode on a computer where Claude Design is available', () => {
    const { root } = seededStore();
    const saved = process.env.LAMBDA_PODS_ROOT;
    process.env.LAMBDA_PODS_ROOT = root;

    try {
      withMachine(
        {
          design: {
            available: true,
            typeUrl: 'https://claude.ai/artifact/TestDesignType1',
            checkedAt: '2026-10-20T00:00:00.000Z',
          },
        },
        () => expect(printed(() => runRenderMode(POD))).toEqual(['full'])
      );
    } finally {
      process.env.LAMBDA_PODS_ROOT = saved;
    }
  });

  it("prints the pod's own mode whatever the computer says", () => {
    const { root } = seededStore({ renderMode: 'full' });
    const saved = process.env.LAMBDA_PODS_ROOT;
    process.env.LAMBDA_PODS_ROOT = root;

    try {
      withMachine({}, () =>
        expect(printed(() => runRenderMode(POD))).toEqual(['full'])
      );
    } finally {
      process.env.LAMBDA_PODS_ROOT = saved;
    }
  });
});

describe('the workflow view', () => {
  const time = { day: '2026-10-19', todayMs: 0, days: {}, pods: {} };

  it("renders ascii, with Full unavailable, when the pod's runner reports design.available false", () => {
    const { store } = seededStore();
    const view = buildWorkflowView(store, POD, time, {
      design: { available: false },
    });

    expect(view.renderMode).toBe('ascii');
    expect(view.designAvailable).toBe(false);
  });

  it('renders full when the runner reports Claude Design available', () => {
    const { store } = seededStore();
    const view = buildWorkflowView(store, POD, time, {
      design: { available: true },
    });

    expect(view.renderMode).toBe('full');
    expect(view.designAvailable).toBe(true);
  });

  it("doesn't call Full unavailable when the runner hasn't checked yet", () => {
    const { store } = seededStore({ renderMode: 'full' });
    const view = buildWorkflowView(store, POD, time, {});

    expect(view.renderMode).toBe('full');
    expect(view.designAvailable).toBeUndefined();
  });
});
