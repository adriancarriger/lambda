import { blockTicket } from '../blocked';
import {
  createBuildingDriver,
  leftLambdaBlock,
  leftLambdaStopText,
} from '../driver';
import {
  LESLIE,
  buildingPodStore,
  fakeMothership,
  fakeSource,
  ticket,
} from './fakes';

/**
 * A ticket taken out of Lambda (its λ label removed in the tracker) while it
 * is being built: the build stops on it and the owner is asked, and its
 * status in the tracker is left alone — it isn't Lambda's to change now.
 */

const RUNNER = 'r-leslie-mac';
const T0 = Date.parse('2026-10-23T10:00:00.000Z');
const MINUTE = 60_000;

const setUp = async (options: { stopFails?: boolean } = {}) => {
  const { store, root, podId } = buildingPodStore();
  const tracked = fakeSource([
    ticket('3', { title: 'Trail markers' }),
    ticket('4', { title: 'Lot 48 photos' }),
  ]);
  const removed = new Set<string>();
  const failing = { now: false };
  const source = {
    ...tracked,
    kind: 'linear' as const,
    isMember: async (id: string): Promise<boolean> => {
      if (failing.now) {
        throw new Error('Linear is unreachable.');
      }

      return !removed.has(id);
    },
  };
  const mothership = fakeMothership();
  const clock = { now: T0 };
  /** What the driver did to the pod's agents, in order. */
  const happened: { list: string[] } = { list: [] };
  const driver = createBuildingDriver({
    store,
    podId,
    projectRoot: root,
    runnerId: RUNNER,
    source: () => source,
    owner: () => LESLIE,
    mothership: mothership.forRunner(RUNNER),
    interrupt: async (agent) => {
      if (options.stopFails === true) {
        throw new Error(`The ${agent} window is gone.`);
      }

      happened.list = [...happened.list, `stop ${agent}`];
    },
    send: async (target, text) => {
      happened.list = [...happened.list, `${target}: ${text}`];
    },
    block: async (ticketId, parts, how) => {
      happened.list = [...happened.list, `block ${ticketId}`];
      await blockTicket({
        store,
        podId,
        ticketId,
        parts,
        source,
        leftLambda: how?.leftLambda === true,
      });
    },
    panes: () => 'dev: running the map pin check',
    now: () => clock.now,
    log: () => undefined,
  });

  // Pick up ticket 3.
  await driver.tick();
  happened.list = [];

  const after = async (minutes: number): Promise<void> => {
    clock.now += minutes * MINUTE;
    await driver.tick();
  };

  return {
    store,
    podId,
    tracked,
    mothership,
    removed,
    failing,
    happened,
    after,
  };
};

const askedOwner = (store: ReturnType<typeof buildingPodStore>['store']) =>
  store
    .readThread('build-a1b2')
    .filter((message) => message.expectsReply === true);

describe('a ticket taken out of Lambda mid-build', () => {
  it('keeps building while it is still Lambda’s', async () => {
    const { store, tracked, after } = await setUp();

    await after(1);

    expect(askedOwner(store)).toEqual([]);
    expect(tracked.statusOf('3')).toBe('building');
  });

  it('stops on it and asks, leaving its tracker status alone', async () => {
    const { store, podId, tracked, mothership, removed, after } = await setUp();
    removed.add('3');

    await after(1);

    expect(askedOwner(store)[0]?.text).toBe(
      [
        '**What:** Trail markers',
        "**Problem:** Removed from Lambda in Linear: 3 lost Lambda's label while it was being built.",
        '**Options:** 1) Add the label back in Linear, then set it to Ready to build it again  2) Leave it out of Lambda: its work stays set aside',
        '**Recommendation:** Leave it out unless the label came off by mistake. This Lambda moved on to the next ticket.',
      ].join('\n')
    );
    // Never written to the tracker: no Blocked there.
    expect(tracked.statusOf('3')).toBe('building');
    expect(
      tracked.updates.some((update) => update.input.status === 'blocked')
    ).toBe(false);
    expect(store.readBuilding(podId).runs[0]?.blocked).toBeDefined();
    expect(mothership.rows.has('3')).toBe(false);

    // The pod moves on.
    await after(1);

    expect(mothership.rows.get('4')?.runnerId).toBe(RUNNER);
  });

  it('stops the dev and QA before setting the work aside, then stands the manager down', async () => {
    const { removed, happened, after } = await setUp();
    removed.add('3');

    await after(1);

    expect(happened.list.slice(0, 4)).toEqual([
      'stop dev',
      'stop qa',
      'block 3',
      `engineering-manager: ${leftLambdaStopText(
        { id: '3', title: 'Trail markers' },
        'linear'
      )}`,
    ]);
    expect(
      leftLambdaStopText({ id: '3', title: 'Trail markers' }, 'linear')
    ).toBe(
      "Stop: 3 Trail markers was taken out of Lambda in Linear while it was being built. The dev and QA were stopped, its work is set aside, and the owner has been asked. Send them nothing more for it and don't ship it: the runner tells you when it picks up the next ticket."
    );
  });

  it('still blocks the ticket when an agent can’t be stopped', async () => {
    const { store, podId, removed, happened, after } = await setUp({
      stopFails: true,
    });
    removed.add('3');

    await after(1);

    expect(store.readBuilding(podId).runs[0]?.blocked).toBeDefined();
    expect(happened.list[0]).toBe('block 3');
  });

  it('decides nothing on a tracker that doesn’t answer', async () => {
    const { store, tracked, removed, failing, after } = await setUp();
    removed.add('3');
    failing.now = true;

    await after(1);

    expect(askedOwner(store)).toEqual([]);
    expect(tracked.statusOf('3')).toBe('building');
  });

  it('asks the tracker once a minute, not on every look', async () => {
    const { store, removed, after } = await setUp();
    await after(1);
    removed.add('3');

    await after(0.25);

    expect(askedOwner(store)).toEqual([]);

    await after(1);

    expect(askedOwner(store)).toHaveLength(1);
  });

  it('names Jira for a Jira codebase', () => {
    expect(
      leftLambdaBlock({ id: 'PAWNEE-3', title: 'Trail markers' }, 'jira').problem
    ).toBe(
      "Removed from Lambda in Jira: PAWNEE-3 lost Lambda's label while it was being built."
    );
  });
});
