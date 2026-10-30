import { type BuildingDriverDeps, createBuildingDriver } from '../driver';
import { pickUp } from '../pickUp';
import { buildQueue } from '../queue';
import { runSkipTicket } from '../skipTicket';
import {
  LESLIE,
  buildingPodStore,
  fakeMothership,
  fakeSource,
  ticket,
} from './fakes';

const RUNNER_A = 'r-leslie-mac';
const RUNNER_B = 'r-leslie-mini';
const T0 = Date.parse('2026-10-23T10:00:00.000Z');

const ids = (tickets: { id: string }[]): string[] =>
  tickets.map((one) => one.id);

const driverFor = (
  overrides: Partial<BuildingDriverDeps> &
    Pick<BuildingDriverDeps, 'store' | 'podId' | 'projectRoot' | 'source'>
) => {
  const clock = { now: T0 };
  const sent: { texts: string[] } = { texts: [] };
  const mothership = fakeMothership();
  const deps: BuildingDriverDeps = {
    runnerId: RUNNER_A,
    owner: () => LESLIE,
    mothership: mothership.forRunner(RUNNER_A),
    interrupt: async () => undefined,
    send: async (_target, text) => {
      sent.texts = [...sent.texts, text];
    },
    block: async () => undefined,
    panes: () => '',
    now: () => clock.now,
    log: () => undefined,
    ...overrides,
  };

  return { driver: createBuildingDriver(deps), clock, sent, mothership };
};

describe('the next ticket', () => {
  it('passes a Ready ticket that waits on a Blocked one', () => {
    const tickets = [
      ticket('1', { status: 'blocked' }),
      ticket('2', { blockedBy: ['1'] }),
      ticket('3'),
    ];

    expect(
      ids(
        buildQueue({
          tickets,
          claims: [],
          runnerId: RUNNER_A,
          skipped: [],
          isOwners: () => true,
        })
      )
    ).toEqual(['3']);
  });

  it('hands two runners asking at once different tickets', async () => {
    const source = fakeSource([ticket('1'), ticket('2')]);
    const mothership = fakeMothership();
    const ask = (runnerId: string) =>
      pickUp({
        source,
        owner: LESLIE,
        runnerId,
        skipped: [],
        ...mothership.forRunner(runnerId),
      });

    const [a, b] = await Promise.all([ask(RUNNER_A), ask(RUNNER_B)]);
    const taken = [a, b].map((result) =>
      result.kind === 'picked' ? result.ticket.id : null
    );

    expect(taken.sort()).toEqual(['1', '2']);
  });

  it('skips a shipped ticket another copy still says is Ready', () => {
    // Runner B's markdown copy never heard that 1 shipped on runner A.
    expect(
      ids(
        buildQueue({
          tickets: [ticket('1'), ticket('2')],
          claims: [{ ticketId: '1', runnerId: RUNNER_A, shippedAt: T0 }],
          runnerId: RUNNER_B,
          skipped: [],
          isOwners: () => true,
        })
      )
    ).toEqual(['2']);
  });

  it('skips a ticket another runner is building', () => {
    expect(
      ids(
        buildQueue({
          tickets: [ticket('1'), ticket('2')],
          claims: [{ ticketId: '1', runnerId: RUNNER_A, shippedAt: null }],
          runnerId: RUNNER_B,
          skipped: [],
          isOwners: () => true,
        })
      )
    ).toEqual(['2']);
  });
});

describe('claims as pods end, stop and block', () => {
  // A pod ended with `lambda pod done`: podDone.test.ts, through the runner.
  // `lambda stop`: lifecycle.test.ts, through the real stop.

  it('keeps the claim of a pod paused, so no other runner takes it', async () => {
    const { store, root, podId } = buildingPodStore();
    const source = fakeSource([ticket('1'), ticket('2')]);
    const { driver, mothership } = driverFor({
      store,
      podId,
      projectRoot: root,
      source: () => source,
    });

    await driver.tick();
    store.updatePod(podId, (pod) => ({ ...pod, status: 'paused' }));
    await driver.tick();

    expect(mothership.rows.get('1')?.runnerId).toBe(RUNNER_A);
    expect(
      ids(
        buildQueue({
          tickets: await source.list(),
          claims: [...mothership.rows.values()],
          runnerId: RUNNER_B,
          skipped: [],
          isOwners: () => true,
        })
      )
    ).toEqual(['2']);
  });

  it('tells the mothership a shipped ticket shipped, once, and remembers it did', async () => {
    const { store, root, podId } = buildingPodStore();
    const source = fakeSource([ticket('1')]);
    const { driver, mothership } = driverFor({
      store,
      podId,
      projectRoot: root,
      source: () => source,
    });
    await driver.tick();
    const told: { shipped: string[] } = { shipped: [] };
    const { shipped } = mothership.forRunner(RUNNER_A);
    const spied = createBuildingDriver({
      store,
      podId,
      projectRoot: root,
      runnerId: RUNNER_A,
      source: () => source,
      owner: () => LESLIE,
      mothership: {
        ...mothership.forRunner(RUNNER_A),
        shipped: (ticketId) => {
          told.shipped = [...told.shipped, ticketId];
          shipped(ticketId);
        },
      },
      interrupt: async () => undefined,
      send: async () => undefined,
      block: async () => undefined,
      panes: () => '',
      now: () => T0,
      log: () => undefined,
    });
    // `lambda ship` stamped the run.
    store.updateBuilding(podId, (state) => ({
      ...state,
      runs: state.runs.map((run) => ({
        ...run,
        shippedAt: new Date(T0).toISOString(),
      })),
    }));

    await spied.tick();
    await spied.tick();

    expect(told.shipped).toEqual(['1']);
    expect(mothership.rows.get('1')?.shippedAt).not.toBeNull();
    expect(store.readBuilding(podId).runs[0]?.shipReported).toBe(true);
  });

  it('deletes the claim of a ticket that goes blocked', async () => {
    const { store, root, podId } = buildingPodStore();
    const source = fakeSource([ticket('1')]);
    const { driver, mothership } = driverFor({
      store,
      podId,
      projectRoot: root,
      source: () => source,
    });

    await driver.tick();
    store.updateBuilding(podId, (state) => ({
      ...state,
      runs: state.runs.map((run) => ({
        ...run,
        blocked: {
          at: new Date(T0).toISOString(),
          what: 'Ticket 1',
          problem: 'The photo storage key is missing',
          options: '1) add the key  2) skip photos for now',
          recommendation: 'add the key',
        },
      })),
    }));
    await driver.tick();

    expect(mothership.rows.has('1')).toBe(false);
  });
});

describe('lambda pod skip-ticket', () => {
  const setUp = async () => {
    const { store, root, podId } = buildingPodStore();
    const source = fakeSource([
      ticket('3'),
      ticket('4'),
      ticket('5'),
      ticket('6'),
    ]);
    const { driver, mothership } = driverFor({
      store,
      podId,
      projectRoot: root,
      source: () => source,
    });
    await driver.tick();

    return { store, podId, source, driver, mothership };
  };

  it('leaves ticket 4 out of next and Up next, its status and claims as they were', async () => {
    const { store, podId, source, driver, mothership } = await setUp();

    await runSkipTicket(podId, '4', {
      store,
      source,
      caller: 'engineering-manager',
    });

    expect(store.requirePod(podId).skipped).toEqual(['4']);
    expect(source.statusOf('4')).toBe('ready');
    expect(mothership.rows.has('4')).toBe(false);
    expect(
      ids(
        buildQueue({
          tickets: await source.list(),
          claims: [...mothership.rows.values()],
          runnerId: RUNNER_A,
          skipped: ['4'],
          current: '3',
          isOwners: () => true,
        })
      )
    ).toEqual(['5', '6']);

    // The rail's Up next follows at the next pick-up.
    store.updateBuilding(podId, (state) => ({
      ...state,
      runs: state.runs.map((run) => ({
        ...run,
        shippedAt: new Date(T0).toISOString(),
      })),
    }));
    await driver.tick();
    expect(store.readBuilding(podId).runs.map((run) => run.id)).toEqual([
      '3',
      '5',
    ]);
    expect(ids(store.readBuilding(podId).upNext)).toEqual(['6']);
  });

  it("defaults the pod to the caller's POD_ID when none is given", async () => {
    const { store, podId, source } = await setUp();
    const before = process.env.POD_ID;
    process.env.POD_ID = podId;

    try {
      await runSkipTicket(undefined, '4', {
        store,
        source,
        caller: 'engineering-manager',
      });
    } finally {
      if (before === undefined) {
        delete process.env.POD_ID;
      } else {
        process.env.POD_ID = before;
      }
    }

    expect(store.requirePod(podId).skipped).toEqual(['4']);
  });

  it('refuses with no pod given and no POD_ID', async () => {
    const { store, podId, source } = await setUp();
    const before = process.env.POD_ID;
    delete process.env.POD_ID;

    try {
      await expect(
        runSkipTicket(undefined, '4', {
          store,
          source,
          caller: 'engineering-manager',
        })
      ).rejects.toThrow('No pod given.');
    } finally {
      if (before !== undefined) {
        process.env.POD_ID = before;
      }
    }
    expect(store.requirePod(podId).skipped ?? []).toEqual([]);
  });

  it('refuses the current ticket and an unknown one, changing nothing', async () => {
    const { store, podId, source } = await setUp();

    await expect(
      runSkipTicket(podId, '3', {
        store,
        source,
        caller: 'engineering-manager',
      })
    ).rejects.toThrow(
      '3 is being built now. Use `lambda pod blocked` to set it aside.'
    );
    await expect(
      runSkipTicket(podId, '99', {
        store,
        source,
        caller: 'engineering-manager',
      })
    ).rejects.toThrow('No ticket 99 in this codebase.');
    expect(store.requirePod(podId).skipped ?? []).toEqual([]);
  });

  it('skipping a ticket already skipped changes nothing', async () => {
    const { store, podId, source } = await setUp();

    await runSkipTicket(podId, '4', {
      store,
      source,
      caller: 'engineering-manager',
    });
    await runSkipTicket(podId, '4', {
      store,
      source,
      caller: 'engineering-manager',
    });

    expect(store.requirePod(podId).skipped).toEqual(['4']);
  });
});

describe('with nothing Ready', () => {
  it('is idle, asks the source again after 60 seconds, and takes what turned Ready', async () => {
    const { store, root, podId } = buildingPodStore();
    const source = fakeSource([ticket('1', { status: 'planning' })]);
    const listed = jest.spyOn(source, 'list');
    const { driver, clock, sent } = driverFor({
      store,
      podId,
      projectRoot: root,
      source: () => source,
    });

    await driver.tick();
    expect(store.readBuilding(podId).idleReason).toBe('Nothing ready to build');
    const asked = listed.mock.calls.length;

    await source.update('1', { status: 'ready' });
    clock.now += 59_000;
    await driver.tick();
    expect(listed.mock.calls.length).toBe(asked);
    expect(store.readBuilding(podId).runs).toEqual([]);

    clock.now += 1_000;
    await driver.tick();
    expect(store.readBuilding(podId).runs.map((run) => run.id)).toEqual(['1']);
    expect(store.readBuilding(podId).idleReason).toBeUndefined();
    expect(sent.texts).toHaveLength(1);
  });
});

describe('blockers the tracker keeps out of its list', () => {
  const tickets = [ticket('1', { blockedBy: ['PAW-9'] })];

  it('hands out a Ready ticket whose outside blocker is done, as next would', () => {
    const queued = (outside: ReadonlyMap<string, 'done' | 'ready'>) =>
      ids(
        buildQueue({
          tickets,
          outside,
          claims: [],
          runnerId: RUNNER_A,
          skipped: [],
          isOwners: () => true,
        })
      );

    expect(queued(new Map([['PAW-9', 'done']]))).toEqual(['1']);
    expect(queued(new Map([['PAW-9', 'ready']]))).toEqual([]);
    expect(queued(new Map())).toEqual([]);
  });

  it('pick-up reads them from the ticket source', async () => {
    const source = fakeSource(tickets, new Map([['PAW-9', 'done']]));
    expect(await source.next()).toMatchObject({ id: '1' });
    const result = await pickUp({
      source,
      owner: LESLIE,
      runnerId: RUNNER_A,
      skipped: [],
      ...fakeMothership().forRunner(RUNNER_A),
    });

    expect(result.kind === 'picked' ? result.ticket.id : result.kind).toBe('1');
  });
});

describe("this runner's own claim on a ticket it isn't building", () => {
  it('is a pick-up that never finished: takeable again, even marked building', () => {
    expect(
      ids(
        buildQueue({
          tickets: [ticket('1', { status: 'building' })],
          claims: [{ ticketId: '1', runnerId: RUNNER_A, shippedAt: null }],
          runnerId: RUNNER_A,
          skipped: [],
          isOwners: () => true,
        })
      )
    ).toEqual(['1']);
  });

  it.each([
    ['skipped by this pod', { skipped: ['1'], isOwners: () => true }],
    ['reported by someone else', { skipped: [], isOwners: () => false }],
  ])('is still left out when %s', (_, rule) => {
    expect(
      ids(
        buildQueue({
          tickets: [ticket('1', { status: 'building' })],
          claims: [{ ticketId: '1', runnerId: RUNNER_A, shippedAt: null }],
          runnerId: RUNNER_A,
          ...rule,
        })
      )
    ).toEqual([]);
  });
});

describe('only the Engineering manager skips a ticket', () => {
  it.each([['product-manager'], ['dev'], [undefined]])(
    'refuses %s, changing nothing',
    async (caller) => {
      const { store, podId } = buildingPodStore();
      const source = fakeSource([ticket('3'), ticket('4')]);

      await expect(
        runSkipTicket(podId, '4', { store, source, caller })
      ).rejects.toThrow('Only the Engineering manager can skip a ticket.');
      expect(store.requirePod(podId).skipped ?? []).toEqual([]);
    }
  );
});

describe('a sub-issue someone else reported', () => {
  const RON = { name: 'Ron Swanson', email: 'ron@pawnee.gov' };
  const queued = (children: ReturnType<typeof ticket>[]) =>
    ids(
      buildQueue({
        tickets: [
          ticket('P', { children: children.map((one) => one.id) }),
          ...children.map((one) => ({ ...one, parent: 'P' })),
        ],
        claims: [],
        runnerId: RUNNER_A,
        skipped: [],
        isOwners: (reporter) => reporter?.email !== RON.email,
      })
    );

  it('is never in the queue, so never in Up next or "ticket N of M"', () => {
    expect(queued([ticket('c1'), ticket('c2', { reporter: RON })])).toEqual([
      'c1',
    ]);
  });

  it("holds back the owner's later children, keeping the epic's order", () => {
    expect(queued([ticket('c1', { reporter: RON }), ticket('c2')])).toEqual([]);
  });
});

describe('tickets assigned to a computer', () => {
  const queueFor = (computer: string) =>
    ids(
      buildQueue({
        tickets: [
          ticket('1', { assignee: "Ann's Mac mini" }),
          ticket('2'),
          ticket('3', { assignee: "leslie's macbook pro" }),
        ],
        claims: [],
        runnerId: RUNNER_A,
        skipped: [],
        isOwners: () => true,
        computer,
      })
    );

  it('takes unassigned tickets and its own, in queue order, never another computer’s', () => {
    expect(queueFor("Leslie's MacBook Pro")).toEqual(['2', '3']);
    expect(queueFor("Ann's Mac mini")).toEqual(['1', '2']);
  });

  it('knows its own name however the apostrophe is typed', () => {
    expect(queueFor('Leslie\u2019s MacBook Pro')).toEqual(['2', '3']);
  });

  it('never takes a ticket a person has taken to do by hand', () => {
    expect(
      ids(
        buildQueue({
          tickets: [ticket('1', { assignee: 'Leslie Knope' }), ticket('2')],
          claims: [],
          runnerId: RUNNER_A,
          skipped: [],
          isOwners: () => true,
          computer: "Leslie's MacBook Pro",
        })
      )
    ).toEqual(['2']);
  });

  it('keeps a child assigned elsewhere in its place, so its later siblings wait', () => {
    const tickets = [
      ticket('E', { children: ['E1', 'E2'] }),
      ticket('E1', { parent: 'E', assignee: "Ann's Mac mini" }),
      ticket('E2', { parent: 'E' }),
      ticket('4'),
    ];

    expect(
      ids(
        buildQueue({
          tickets,
          claims: [],
          runnerId: RUNNER_A,
          skipped: [],
          isOwners: () => true,
          computer: "Leslie's MacBook Pro",
        })
      )
    ).toEqual(['4']);
  });

  it('picks up through the driver with this computer’s name', async () => {
    const source = fakeSource([
      ticket('1', { assignee: "Ann's Mac mini" }),
      ticket('2'),
    ]);
    const result = await pickUp({
      source,
      owner: LESLIE,
      runnerId: RUNNER_A,
      computer: "Leslie's MacBook Pro",
      skipped: [],
      claims: async () => [],
      claim: async () => 'claimed',
      release: () => undefined,
    });

    expect(result.kind === 'picked' ? result.ticket.id : null).toBe('2');
  });
});
