import * as fs from 'fs';

import {
  buildingPodStore,
  fakeSource,
  ticket,
} from '../../building/__tests__/fakes';
import { leaveRelease, pendingReleases } from '../../building/driver';
import '../../pod/__tests__/podProject';
import type { Message } from '../../protocol';
import { createBuildingRunner } from '../building';

/**
 * The claims an ended pod left, as the runner releases them: a tracker that
 * refuses is asked again after a wait, not every tick; a ticket another
 * runner has claimed since is never set back to Ready.
 */

jest.mock('../../pod/tmux', () => ({
  ...jest.requireActual('../../pod/tmux'),
  hasSession: () => false,
  listWindows: () => [],
  killSession: () => undefined,
  killWindow: () => undefined,
}));

const RUNNER = 'r-leslie-mac';

const made: string[] = [];

afterEach(() => {
  made.splice(0).forEach((root) => fs.rmSync(root, { recursive: true }));
});

const setup = (claims: unknown[] = []) => {
  const { store, root } = buildingPodStore('build-a1b2', RUNNER);
  made.splice(made.length, 0, root);
  const source = fakeSource([ticket('1', { status: 'building' })]);
  const clock = { now: Date.parse('2026-10-23T10:00:00.000Z') };
  const sent: Message[] = [];
  const logged: string[] = [];
  const runner = createBuildingRunner({
    runnerId: () => RUNNER,
    client: () => ({
      enqueue: (item) => {
        sent.splice(sent.length, 0, item);
      },
      request: async () => ({ claims }),
    }),
    lambda: async () => '',
    tmux: () => '',
    owner: () => null,
    log: (line) => logged.splice(logged.length, 0, line),
    now: () => clock.now,
    source: () => source,
    // Only the releases: the pod itself takes nothing.
    isCurrent: () => false,
  });
  const tick = () => runner.tick(new Map([[root, { store }]]));

  return { store, source, clock, sent, logged, tick };
};

describe('a release the tracker refused', () => {
  it('is asked again once the wait is over, not every tick', async () => {
    const { store, source, clock, sent, logged, tick } = setup();
    leaveRelease(store.root, '1');
    source.failNextUpdate('1');

    await tick();
    // Still down for the next try.
    source.failNextUpdate('1');
    clock.now += 5_000;
    await tick();

    // One refused try, one log line: the 5-second tick waits.
    expect(logged.filter((line) => line.includes('Internal'))).toHaveLength(1);
    expect(source.statusOf('1')).toBe('building');

    clock.now += 60_000;
    await tick();
    expect(logged.filter((line) => line.includes('Internal'))).toHaveLength(2);

    clock.now += 60_000;
    await tick();
    expect(source.statusOf('1')).toBe('ready');
    expect(sent.map((item) => item.ticketId)).toEqual(['1']);
    expect(pendingReleases(store.root)).toEqual([]);
  });
});

describe('a release whose ticket another runner has claimed since', () => {
  it('leaves the ticket building, and still drops the release', async () => {
    const { store, source, sent, tick } = setup([
      { ticketId: '1', runnerId: 'r-ann-laptop', shippedAt: null },
    ]);
    leaveRelease(store.root, '1');

    await tick();

    expect(source.statusOf('1')).toBe('building');
    expect(source.updates).toEqual([]);
    expect(sent.map((item) => [item.type, item.ticketId])).toEqual([
      ['ticket-release', '1'],
    ]);
    expect(pendingReleases(store.root)).toEqual([]);
  });

  it('still sets back to Ready a ticket only this runner holds', async () => {
    const { store, source, tick } = setup([
      { ticketId: '1', runnerId: RUNNER, shippedAt: null },
    ]);
    leaveRelease(store.root, '1');

    await tick();

    expect(source.statusOf('1')).toBe('ready');
  });
});
