/**
 * `lambda pod step` takes the codebase's own planning steps: one its
 * workflow.json adds is accepted, one it drops is refused.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createPodStore } from '../../pod-store';
import { runStep } from '../steps';
import { usePodProject } from './podProject';

const POD = 'pawnee-a1b2';
const saved = { ...process.env };

/** A project adding a11y-check after the UX review and dropping duplicate-check. */
const project = (): { root: string; pods: string } => {
  const root = usePodProject();
  fs.mkdirSync(path.join(root, '.lambda', 'planning'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.lambda', 'planning', 'workflow.json'),
    JSON.stringify({
      extends: 'standard',
      add: [
        {
          id: 'a11y-check',
          label: 'Accessibility',
          run: '/a11y-check {tickets}',
          after: 'ux-review',
        },
      ],
      drop: ['duplicate-check'],
    })
  );
  fs.writeFileSync(
    path.join(root, '.lambda', 'planning', 'a11y-check.md'),
    '# Check every screen with a screen reader\n'
  );
  const pods = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-steps-'));
  createPodStore(pods).writePod({
    id: POD,
    slug: 'pawnee',
    createdAt: '2026-10-03T00:00:00.000Z',
    status: 'active',
    phase: 3,
    completedCheckpoints: [],
    worktreePath: '/tmp/pawnee',
    ownsWorktree: false,
    managerCwd: '/tmp/pawnee',
    devCwd: '/tmp/pawnee',
    agentCommand: 'claude',
    sessions: { manager: 'm', dev: 'd' },
  });
  process.env.LAMBDA_PODS_ROOT = pods;

  return { root, pods };
};

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  process.env = { ...saved };
  jest.restoreAllMocks();
});

describe('lambda pod step', () => {
  it("refuses a checkpoint's post step done before the checkpoint is posted", () => {
    const { root, pods } = project();

    expect(() => runStep('cp5-post', 'done', { pod: POD }, root)).toThrow(
      "Checkpoint 5 isn't posted yet"
    );

    createPodStore(pods).writeQuestion({
      id: 'q3',
      podId: POD,
      kind: 'checkpoint',
      phase: 5,
      status: 'open',
      blocksCheckpoint: true,
      dependsOn: [],
      createdAt: '2026-10-25T16:44:14.206Z',
      options: [],
      summary: 'Final check passed: the hello.txt ticket is ready to build.',
      checkpoint: { cp: 5, decisionIds: [] },
    });

    expect(() => runStep('cp5-post', 'done', { pod: POD }, root)).not.toThrow();
  });

  it('accepts a step the project adds, and records it', () => {
    const { root, pods } = project();

    runStep('a11y-check', 'start', { pod: POD }, root);

    expect(
      createPodStore(pods)
        .readSteps(POD)
        .map((event) => [event.step, event.event])
    ).toEqual([['a11y-check', 'start']]);
  });

  it('refuses --pass on an added step: it is not a repeated step', () => {
    const { root } = project();

    expect(() =>
      runStep('a11y-check', 'done', { pod: POD, pass: '1' }, root)
    ).toThrow('a11y-check is not a repeated step; drop --pass.');
  });

  it('lets an added step finish without --found', () => {
    const { root } = project();

    expect(() =>
      runStep('a11y-check', 'done', { pod: POD }, root)
    ).not.toThrow();
  });

  it('refuses a step the project dropped, listing the steps it has', () => {
    const { root } = project();

    expect(() =>
      runStep('duplicate-check', 'start', { pod: POD }, root)
    ).toThrow(/^Unknown step "duplicate-check"\. Steps: .*\ba11y-check\b.*\.$/);
    expect(() =>
      runStep('duplicate-check', 'start', { pod: POD }, root)
    ).not.toThrow(/\bduplicate-check,/);
  });

  it("reads the steps from the pod's own folder, where its commands come from, not the current one", () => {
    const { root: podFolder } = project();
    const pods = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-steps-'));
    createPodStore(pods).writePod({
      id: POD,
      slug: 'pawnee',
      createdAt: '2026-10-03T00:00:00.000Z',
      status: 'active',
      phase: 3,
      completedCheckpoints: [],
      worktreePath: podFolder,
      ownsWorktree: false,
      managerCwd: podFolder,
      devCwd: podFolder,
      agentCommand: 'claude',
      sessions: { manager: 'm', dev: 'd' },
    });
    process.env.LAMBDA_PODS_ROOT = pods;
    // The current folder is another checkout, with no workflow.json.
    usePodProject();

    runStep('a11y-check', 'start', { pod: POD });

    expect(
      createPodStore(pods)
        .readSteps(POD)
        .map((event) => [event.step, event.event])
    ).toEqual([['a11y-check', 'start']]);
  });

  it('still needs --found when a standard repeated step finishes a pass', () => {
    const { root } = project();

    expect(() =>
      runStep('tickets-red-flags', 'done', { pod: POD, pass: '1' }, root)
    ).toThrow('tickets-red-flags is a repeated step: pass --found <n>');
    expect(() =>
      runStep(
        'tickets-red-flags',
        'done',
        { pod: POD, pass: '1', found: '0' },
        root
      )
    ).not.toThrow();
  });
});
