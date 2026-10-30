import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import '../../pod/__tests__/podProject';
import { runDone } from '../../pod/lifecycle';
import type { Message } from '../../protocol';
import { createBuildingRunner } from '../../runner/building';
import { RELEASES_FILE, leaveRelease, pendingReleases } from '../driver';
import { buildQueue } from '../queue';
import { buildingPodStore, fakeSource, ticket } from './fakes';

/**
 * `lambda pod done` on a building pod: its ticket's claim is left for the
 * runner (the pod's own state may already be gone with `delete`), and the
 * runner's next tick releases it and sets the ticket back to Ready.
 */

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

describe('a building pod ended with lambda pod done', () => {
  it('has its claim released by the runner, and its ticket Ready and takeable again', async () => {
    const { store, root, podId } = buildingPodStore('build-a1b2', RUNNER);
    process.env.LAMBDA_PODS_ROOT = store.root;
    const source = fakeSource([ticket('1', { status: 'building' })]);
    store.writeBuilding(podId, {
      runs: [
        {
          id: '1',
          title: 'Ticket 1',
          step: 'build',
          attempt: 1,
          startedAt: '2026-10-23T10:00:00.000Z',
          claim: 'claimed',
        },
      ],
      upNext: [],
    });
    const sent: { items: Message[] } = { items: [] };
    const runner = createBuildingRunner({
      runnerId: RUNNER,
      client: () => ({
        enqueue: (item) => {
          sent.items = [...sent.items, item];
        },
        request: async () => ({ claims: [] }),
      }),
      lambda: async () => '',
      tmux: () => '',
      owner: () => null,
      log: () => undefined,
      source: () => source,
    });

    runDone(podId);
    await runner.tick(new Map([[root, { store }]]));

    expect(
      sent.items.map((item) => [item.type, item.folder, item.ticketId])
    ).toEqual([['ticket-release', root, '1']]);
    expect(source.statusOf('1')).toBe('ready');
    expect(
      buildQueue({
        tickets: await source.list(),
        claims: [],
        runnerId: 'r-leslie-mini',
        skipped: [],
        isOwners: () => true,
      }).map((one) => one.id)
    ).toEqual(['1']);

    // Released once: the next tick has nothing left to release.
    await runner.tick(new Map([[root, { store }]]));
    expect(sent.items).toHaveLength(1);
  });

  it('reports a ship the runner never sent, keeping the claim: never released, never set back to Ready', async () => {
    const { store, root, podId } = buildingPodStore('build-a1b2', RUNNER);
    process.env.LAMBDA_PODS_ROOT = store.root;
    store.writePod({ ...store.requirePod(podId), projectId: 'p-pawnee' });
    const source = fakeSource([ticket('1', { status: 'done' })]);
    store.writeBuilding(podId, {
      runs: [
        {
          id: '1',
          title: 'Ticket 1',
          step: 'ship',
          attempt: 1,
          startedAt: '2026-10-23T10:00:00.000Z',
          claim: 'claimed',
          shippedAt: '2026-10-23T10:40:00.000Z',
        },
      ],
      upNext: [],
    });
    const sent: { items: Message[] } = { items: [] };
    const runner = createBuildingRunner({
      runnerId: RUNNER,
      client: () => ({
        enqueue: (item) => {
          sent.items = [...sent.items, item];
        },
        request: async () => ({ claims: [] }),
      }),
      lambda: async () => '',
      tmux: () => '',
      owner: () => null,
      log: () => undefined,
      source: () => source,
    });

    runDone(podId);
    await runner.tick(new Map([[root, { store }]]));

    expect(
      sent.items.map((item) => [item.type, item.ticketId, item.projectId])
    ).toEqual([['ticket-shipped', '1', 'p-pawnee']]);
    expect(source.statusOf('1')).toBe('done');

    // Sent once: the next tick has nothing left to report.
    await runner.tick(new Map([[root, { store }]]));
    expect(sent.items).toHaveLength(1);
  });

  it("sends the pod's project with its release, and still reads a release left before projects rode along", async () => {
    const { store, root, podId } = buildingPodStore('build-a1b2', RUNNER);
    process.env.LAMBDA_PODS_ROOT = store.root;
    store.writePod({ ...store.requirePod(podId), projectId: 'p-pawnee' });
    const source = fakeSource([
      ticket('1', { status: 'building' }),
      ticket('2', { status: 'building' }),
    ]);
    store.writeBuilding(podId, {
      runs: [
        {
          id: '1',
          title: 'Ticket 1',
          step: 'build',
          attempt: 1,
          startedAt: '2026-10-23T10:00:00.000Z',
          claim: 'claimed',
        },
      ],
      upNext: [],
    });
    const sent: { items: Message[] } = { items: [] };
    const runner = createBuildingRunner({
      runnerId: RUNNER,
      client: () => ({
        enqueue: (item) => {
          sent.items = [...sent.items, item];
        },
        request: async () => ({ claims: [] }),
      }),
      lambda: async () => '',
      tmux: () => '',
      owner: () => null,
      log: () => undefined,
      source: () => source,
    });

    runDone(podId);
    // An older runner's entry: the bare ticket id.
    const file = path.join(store.root, RELEASES_FILE);
    const left: unknown[] = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify([...left, '2']));
    await runner.tick(new Map([[root, { store }]]));

    expect(
      sent.items.map((item) => [item.type, item.ticketId, item.projectId])
    ).toEqual([
      ['ticket-release', '1', 'p-pawnee'],
      ['ticket-release', '2', undefined],
    ]);
    expect(source.statusOf('2')).toBe('ready');
  });

  it('keeps a release that failed for the next tick, and still releases the others', async () => {
    const { store, root } = buildingPodStore('build-a1b2', RUNNER);
    const source = fakeSource([
      ticket('1', { status: 'building' }),
      ticket('2', { status: 'building' }),
    ]);
    const sent: { items: Message[] } = { items: [] };
    const logged: string[] = [];
    const clock = { now: 0 };
    const runner = createBuildingRunner({
      runnerId: RUNNER,
      client: () => ({
        enqueue: (item) => {
          sent.items = [...sent.items, item];
        },
        request: async () => ({ claims: [] }),
      }),
      lambda: async () => '',
      tmux: () => '',
      owner: () => null,
      log: (line) => logged.splice(logged.length, 0, line),
      source: () => source,
      now: () => clock.now,
    });
    leaveRelease(store.root, '1');
    leaveRelease(store.root, '2');
    source.failNextUpdate('1');

    await runner.tick(new Map([[root, { store }]]));

    expect(source.statusOf('1')).toBe('building');
    expect(source.statusOf('2')).toBe('ready');
    expect(logged.join('\n')).toContain('Internal server error');

    // A failed release waits a minute before it's asked again.
    clock.now += 60_000;
    await runner.tick(new Map([[root, { store }]]));

    expect(source.statusOf('1')).toBe('ready');
    expect(sent.items.map((item) => item.ticketId)).toEqual(['2', '1']);
  });

  it('drops the release of a ticket the tracker no longer has, saying so once', async () => {
    const { store, root } = buildingPodStore('build-a1b2', RUNNER);
    const source = fakeSource([ticket('2', { status: 'building' })]);
    const sent: { items: Message[] } = { items: [] };
    const logged: string[] = [];
    const runner = createBuildingRunner({
      runnerId: RUNNER,
      client: () => ({
        enqueue: (item) => {
          sent.items = [...sent.items, item];
        },
        request: async () => ({ claims: [] }),
      }),
      lambda: async () => '',
      tmux: () => '',
      owner: () => null,
      log: (line) => logged.splice(logged.length, 0, line),
      source: () => source,
    });
    leaveRelease(store.root, '1');

    await runner.tick(new Map([[root, { store }]]));
    await runner.tick(new Map([[root, { store }]]));

    expect(logged.filter((line) => line.includes('1'))).toEqual([
      `1 is no longer in ${root}'s tracker: released its claim, nothing to set back to Ready.`,
    ]);
    expect(sent.items.map((item) => [item.type, item.ticketId])).toEqual([
      ['ticket-release', '1'],
    ]);
  });
});

describe("the runner's and lambda pod done's shared release list", () => {
  it('waits for the other writer to let go before adding to it', () => {
    const { store } = buildingPodStore();
    const lock = path.join(store.root, `${RELEASES_FILE}.lock`);
    fs.writeFileSync(lock, 'another writer\n');
    // The other writer lets go in 300 ms, from its own process.
    spawn(process.execPath, [
      '-e',
      `setTimeout(() => require('fs').rmSync(${JSON.stringify(lock)}), 300)`,
    ]);
    const started = Date.now();

    leaveRelease(store.root, '7');

    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(pendingReleases(store.root)).toEqual([{ ticketId: '7' }]);
  });
});
