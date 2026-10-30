import * as fs from 'fs';
import * as path from 'path';

import { buildingPodStore, fakeSource } from '../../building/__tests__/fakes';
import '../../pod/__tests__/podProject';
import { runDone } from '../../pod/lifecycle';
import { createBuildingRunner } from '../building';

/** A long-running runner forgets a building pod once it has ended. */

jest.mock('../../pod/tmux', () => ({
  ...jest.requireActual('../../pod/tmux'),
  hasSession: () => false,
  listWindows: () => [],
  killSession: () => undefined,
  killWindow: () => undefined,
}));

const RUNNER = 'r-leslie-mac';

afterEach(() => {
  delete process.env.LAMBDA_PODS_ROOT;
});

it('drops an ended pod’s driver and watch time', async () => {
  const { store, root, podId } = buildingPodStore('build-a1b2', RUNNER);
  process.env.LAMBDA_PODS_ROOT = store.root;
  const runner = createBuildingRunner({
    runnerId: () => RUNNER,
    client: () => ({
      enqueue: () => undefined,
      request: async () => ({ claims: [] }),
    }),
    lambda: async () => '',
    tmux: () => '',
    owner: () => null,
    log: () => undefined,
    source: () => fakeSource([]),
  });
  const hosts = new Map([[root, { store }]]);

  await runner.tick(hosts);
  expect(runner.tracked()).toEqual({ drivers: 1, watched: 1 });

  runDone(podId);
  await runner.tick(hosts);

  expect(runner.tracked()).toEqual({ drivers: 0, watched: 0 });
});

const runnerWith = (
  lambda: (args: string[]) => Promise<string>,
  extra: { isCurrent?: () => boolean; log?: (line: string) => void } = {}
) =>
  createBuildingRunner({
    runnerId: () => RUNNER,
    client: () => ({
      enqueue: () => undefined,
      request: async () => ({ claims: [] }),
    }),
    lambda,
    tmux: () => '',
    owner: () => null,
    log: extra.log ?? (() => undefined),
    source: () => fakeSource([]),
    isCurrent: extra.isCurrent,
  });

const watches = (ran: string[][]): string[][] =>
  ran.filter((args) => args[0] === 'pod' && args[1] === 'watch-building');

it("takes no tickets for a project this computer isn't on, but still puts its pods to sleep", async () => {
  const { store, root, podId } = buildingPodStore('build-a1b2', RUNNER);
  process.env.LAMBDA_PODS_ROOT = store.root;
  const ran: string[][] = [];
  const runner = runnerWith(
    async (args) => {
      ran.splice(ran.length, 0, args);

      return '';
    },
    { isCurrent: () => false }
  );

  await runner.tick(new Map([[root, { store }]]));

  expect(runner.tracked()).toEqual({ drivers: 0, watched: 1 });
  expect(watches(ran)).toEqual([['pod', 'watch-building', podId]]);
});

it('one unreadable pod.json leaves the other building pods ticking', async () => {
  const { store, root, podId } = buildingPodStore('build-a1b2', RUNNER);
  process.env.LAMBDA_PODS_ROOT = store.root;
  fs.mkdirSync(path.join(store.root, 'build-0000'));
  fs.writeFileSync(path.join(store.root, 'build-0000', 'pod.json'), '{ nope');
  const ran: string[][] = [];
  const logged: string[] = [];
  const runner = runnerWith(
    async (args) => {
      ran.splice(ran.length, 0, args);

      return '';
    },
    { log: (line) => logged.splice(logged.length, 0, line) }
  );

  await runner.tick(new Map([[root, { store }]]));

  expect(runner.tracked()).toEqual({ drivers: 1, watched: 1 });
  expect(watches(ran)).toEqual([['pod', 'watch-building', podId]]);
  expect(logged.some((line) => line.includes('build-0000'))).toBe(true);
});

it("one pod's failure doesn't skip the next pod's watch", async () => {
  const { store, root } = buildingPodStore('build-a1b2', RUNNER);
  process.env.LAMBDA_PODS_ROOT = store.root;
  const first = store.readPod('build-a1b2');

  if (first === null) {
    throw new Error('The fake building pod is missing.');
  }

  store.writePod({ ...first, id: 'build-b2c3' });
  const ran: string[][] = [];
  const runner = runnerWith(async (args) => {
    ran.splice(ran.length, 0, args);

    if (watches(ran).length === 1 && args[1] === 'watch-building') {
      throw new Error('tmux went away');
    }

    return '';
  });

  await runner.tick(new Map([[root, { store }]]));

  expect(
    watches(ran)
      .map((args) => args[2])
      .sort()
  ).toEqual(['build-a1b2', 'build-b2c3']);
});

it('ticks a pod stamped with the id the computer registered again under, mid-run', async () => {
  const { store, root } = buildingPodStore('build-a1b2', RUNNER);
  process.env.LAMBDA_PODS_ROOT = store.root;
  // A reset mothership: `lambda start` writes a new id while this runs.
  const id = { current: 'r-leslie-mac-before-reset' };
  const runner = createBuildingRunner({
    runnerId: () => id.current,
    client: () => ({
      enqueue: () => undefined,
      request: async () => ({ claims: [] }),
    }),
    lambda: async () => '',
    tmux: () => '',
    owner: () => null,
    log: () => undefined,
    source: () => fakeSource([]),
  });
  const hosts = new Map([[root, { store }]]);

  await runner.tick(hosts);
  expect(runner.tracked().drivers).toBe(0);

  id.current = RUNNER;
  await runner.tick(hosts);

  expect(runner.tracked().drivers).toBe(1);
});
