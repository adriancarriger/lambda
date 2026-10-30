import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { type BuildTicketRun } from '../../pod-store';
import { LAMBDA_HOME } from '../../pod/__tests__/podProject';
import { runDelete, runDone } from '../../pod/lifecycle';
import { pendingReleases } from '../driver';
import { BUILDING_FILE } from '../lifecycle';
import { buildingPodStore } from './fakes';

/**
 * A building pod ending (`lambda pod done`, `delete`), whatever tmux and the
 * checkout look like: its claims are left for the runner, the computer's
 * record is cleared, and its ticket's uncommitted work is set aside.
 */

jest.mock('../../pod/tmux', () => ({
  ...jest.requireActual('../../pod/tmux'),
  hasSession: () => false,
  listWindows: () => [],
  killSession: () => undefined,
  killWindow: () => undefined,
}));

const RUNNER = 'r-leslie-mac';

const claimedRun = (
  id: string,
  extra: Partial<BuildTicketRun> = {}
): BuildTicketRun => ({
  id,
  title: `Ticket ${id}`,
  step: 'build',
  attempt: 1,
  startedAt: '2026-10-23T10:00:00.000Z',
  claim: 'claimed',
  ...extra,
});

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

const left = (podsRoot: string): string[] =>
  pendingReleases(podsRoot).map((release) => release.ticketId);

const roots: string[] = [];

const podStore = (extra: Record<string, unknown> = {}) => {
  const setup = buildingPodStore('build-a1b2', RUNNER, extra);
  roots.splice(roots.length, 0, setup.root);
  process.env.LAMBDA_PODS_ROOT = setup.store.root;

  return setup;
};

afterEach(() => {
  delete process.env.LAMBDA_PODS_ROOT;
  roots
    .splice(0)
    .forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

describe('ending a building pod', () => {
  it("ends when the codebase's tmux session isn't running: claim left, record cleared", () => {
    const { store, podId } = podStore({
      tmuxSession: 'lambda-test-no-such-session',
    });
    store.writeBuilding(podId, { runs: [claimedRun('1')], upNext: [] });
    const record = path.join(LAMBDA_HOME, BUILDING_FILE);
    fs.writeFileSync(
      record,
      JSON.stringify({ podId, podsRoot: store.root, project: 'Pawnee' })
    );

    expect(() => runDone(podId)).not.toThrow();
    expect(left(store.root)).toEqual(['1']);
    expect(fs.existsSync(record)).toBe(false);
  });

  it('leaves the claim of a blocked run the runner never released, as well as the current one', () => {
    const { store, podId } = podStore();
    store.writeBuilding(podId, {
      runs: [
        claimedRun('1', {
          blocked: {
            at: '2026-10-23T10:30:00.000Z',
            what: 'Ticket 1',
            problem: 'No key',
            options: '1) add it',
            recommendation: 'add it',
          },
        }),
        claimedRun('2'),
      ],
      upNext: [],
    });

    runDone(podId);

    expect(left(store.root)).toEqual(['1', '2']);
  });

  it('waits for a pick-up holding the building lock, and leaves the run it added', async () => {
    const { store, podId } = podStore();
    store.writeBuilding(podId, { runs: [claimedRun('1')], upNext: [] });
    const file = path.join(store.root, podId, 'building.json');
    // Another process (the runner's pick-up) holds the lock: it appends a
    // run, then lets go.
    fs.writeFileSync(`${file}.lock`, 'runner-pick-up');
    const later = {
      runs: [
        claimedRun('1', { shippedAt: '2026-10-23T10:20:00.000Z' }),
        claimedRun('2'),
      ],
      upNext: [],
    };
    const pickUp = spawn(process.execPath, [
      '-e',
      `setTimeout(() => {
        const fs = require('fs');
        fs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(
        JSON.stringify(later)
      )});
        fs.rmSync(${JSON.stringify(`${file}.lock`)});
      }, 300);`,
    ]);
    const exited = new Promise((resolve) => pickUp.on('exit', resolve));

    try {
      runDone(podId);
    } finally {
      await exited;
    }

    expect(left(store.root)).toEqual(['2']);
  });

  it("sets the current ticket's uncommitted work aside in git stash", () => {
    const { store, root, podId } = podStore();
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'leslie@pawnee.gov']);
    git(root, ['config', 'user.name', 'Leslie Knope']);
    fs.writeFileSync(path.join(root, '.gitignore'), '.lambda/\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'start']);
    store.writeBuilding(podId, { runs: [claimedRun('1')], upNext: [] });
    fs.writeFileSync(path.join(root, 'lot-48.md'), 'Half done.\n');

    runDone(podId);

    expect(git(root, ['stash', 'list'])).toContain('lambda: 1 ended');
    expect(git(root, ['status', '--porcelain'])).toBe('');
  });

  it('is set done before it ends when deleted, so a racing pick-up takes nothing', () => {
    const { store, podId } = podStore();
    store.writeBuilding(podId, { runs: [claimedRun('1')], upNext: [] });

    runDelete(podId);

    // A pick-up appends a run only to an active pod: the pod went to the
    // trash already done, and its claim was left for the runner.
    const trash = path.join(store.root, '.trash');
    const [trashed = ''] = fs.readdirSync(trash);
    const pod = JSON.parse(
      fs.readFileSync(path.join(trash, trashed, 'pod.json'), 'utf8')
    );
    expect(pod.status).toBe('done');
    expect(left(store.root)).toEqual(['1']);
  });
});
