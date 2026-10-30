import { blockTicket } from '../blocked';
import { createBuildingDriver } from '../driver';
import { type BlockedParts, nudgeText } from '../stall';
import {
  LESLIE,
  buildingPodStore,
  fakeMothership,
  fakeSource,
  ticket,
} from './fakes';

const RUNNER = 'r-leslie-mac';
const T0 = Date.parse('2026-10-23T10:00:00.000Z');
const MINUTE = 60_000;

const setUp = async () => {
  const { store, root, podId } = buildingPodStore();
  const source = fakeSource([
    ticket('3', { title: 'Trail markers' }),
    ticket('4', { title: 'Lot 48 photos' }),
  ]);
  const mothership = fakeMothership();
  const clock = { now: T0 };
  const screen = { text: 'dev: running the map pin check' };
  const sent: { list: { target: string; text: string }[] } = { list: [] };
  const sendFails = { next: false };
  const driver = createBuildingDriver({
    store,
    podId,
    projectRoot: root,
    runnerId: RUNNER,
    source: () => source,
    owner: () => LESLIE,
    mothership: mothership.forRunner(RUNNER),
    interrupt: async () => undefined,
    send: async (target, text) => {
      if (sendFails.next) {
        sendFails.next = false;

        throw new Error("can't find window: engineering-manager");
      }
      sent.list = [...sent.list, { target, text }];
    },
    block: (ticketId, parts) =>
      blockTicket({ store, podId, ticketId, parts, source }),
    panes: () => screen.text,
    now: () => clock.now,
    log: () => undefined,
  });

  // Pick up ticket 3, and put it on Test.
  await driver.tick();
  store.updateBuilding(podId, (state) => ({
    ...state,
    runs: state.runs.map((run) => ({ ...run, step: 'test' })),
  }));
  sent.list = [];

  /** The clock moves on, and the runner looks again. */
  const after = async (minutes: number): Promise<void> => {
    clock.now += minutes * MINUTE;
    await driver.tick();
  };

  return {
    store,
    podId,
    source,
    mothership,
    clock,
    screen,
    sent,
    sendFails,
    after,
  };
};

const askedOwner = (store: ReturnType<typeof buildingPodStore>['store']) =>
  store
    .readThread('build-a1b2')
    .filter((message) => message.expectsReply === true);

describe('a stuck building pod', () => {
  it('is nudged after 20 silent minutes, and blocked after another 20', async () => {
    const { store, podId, source, mothership, sent, after } = await setUp();

    await after(1);
    await after(20);

    expect(sent.list).toEqual([
      { target: 'engineering-manager', text: nudgeText('test') },
    ]);
    expect(askedOwner(store)).toEqual([]);

    await after(20);

    expect(sent.list).toHaveLength(1);
    expect(askedOwner(store)).toHaveLength(1);
    expect(source.statusOf('3')).toBe('blocked');
    expect(mothership.rows.has('3')).toBe(false);
    expect(store.readBuilding(podId).runs[0]?.blocked).toBeDefined();

    // The pod moves on: the next look takes ticket 4.
    await after(1);

    expect(sent.list.at(-1)).toEqual({
      target: 'engineering-manager',
      text: expect.stringMatching(/^Picked up 4 Lot 48 photos /),
    });
    expect(mothership.rows.get('4')?.runnerId).toBe(RUNNER);
  });

  it('never counts a nudge that failed to send: the next look nudges again instead of blocking', async () => {
    const { store, source, sent, sendFails, after } = await setUp();

    await after(1);
    sendFails.next = true;
    await after(20).catch(() => undefined);
    await after(20);

    expect(sent.list).toEqual([
      { target: 'engineering-manager', text: nudgeText('test') },
    ]);
    expect(askedOwner(store)).toEqual([]);
    expect(source.statusOf('3')).toBe('building');
  });

  it('sends exactly the nudge text from the ticket', () => {
    expect(nudgeText('test')).toBe(
      'No progress on Test for 20 minutes. Check the dev and qa, then report the step with `lambda pod step` or block the ticket with `lambda pod blocked`.'
    );
  });

  it('puts the second stall in the inbox in four parts', async () => {
    const { store, after } = await setUp();

    await after(1);
    await after(20);
    await after(20);

    expect(askedOwner(store)[0]?.text).toBe(
      [
        '**What:** Trail markers',
        '**Problem:** No progress on Test for 40 minutes',
        '**Options:** 1) look at the Agents tab  2) set it back to Ready to retry',
        '**Recommendation:** Check the Agents tab. This Lambda moved on to the next ticket.',
      ].join('\n')
    );
  });

  it('starts the count again after a step event', async () => {
    const { store, podId, sent, after } = await setUp();

    await after(1);
    await after(20);
    expect(sent.list).toHaveLength(1);

    store.appendStep(podId, {
      at: new Date(T0 + 30 * MINUTE).toISOString(),
      step: 'test',
      event: 'note',
      by: 'engineering-manager',
      ticket: '3',
    });
    await after(10);
    await after(10);

    expect(askedOwner(store)).toEqual([]);
  });

  it('is not silent while a pane changes', async () => {
    const { store, screen, sent, after } = await setUp();

    await after(1);
    await after(10);
    screen.text = 'dev: the pin loaded; re-running the check';
    await after(10);
    await after(10);

    expect(sent.list).toEqual([]);
    expect(askedOwner(store)).toEqual([]);
  });

  it('is not silent while only a test run’s counts change', async () => {
    const { store, screen, sent, after } = await setUp();
    const progress = (done: number) =>
      `qa: lambda e2e parks-map.spec\n[${done}/40] Tests: ${done} passed`;

    screen.text = progress(1);
    await after(1);
    screen.text = progress(12);
    await after(10);
    screen.text = progress(27);
    await after(10);
    screen.text = progress(38);
    await after(10);

    expect(sent.list).toEqual([]);
    expect(askedOwner(store)).toEqual([]);
  });

  it("is silent while only a stuck tool's elapsed timer and spinner tick", async () => {
    const { sent, screen, after } = await setUp();
    const stuck = (glyph: string, time: string) =>
      `dev: running the map pin check\n${glyph} Running… (${time} · ↓ 1.2k tokens · esc to interrupt)`;

    screen.text = stuck('✻', '45s');
    await after(1);
    screen.text = stuck('✶', '10m 45s');
    await after(10);
    screen.text = stuck('✢', '20m 45s');
    await after(10);

    expect(sent.list).toEqual([
      { target: 'engineering-manager', text: nudgeText('test') },
    ]);
  });
});

describe('lambda pod blocked', () => {
  const parts: BlockedParts = {
    what: 'Upload park photos to the shared album',
    problem: 'The photo storage key is missing',
    options: '1) add the key  2) skip photos for now',
    recommendation: 'add the key; this Lambda moved on',
  };

  it('refuses without all four parts, writing nothing', async () => {
    const { store, podId, source, mothership } = await setUp();

    await expect(
      blockTicket({
        store,
        podId,
        ticketId: '3',
        parts: { ...parts, recommendation: '' },
        source,
      })
    ).rejects.toThrow(
      'Blocked needs all four parts: --what, --problem, --options and --recommendation.'
    );
    expect(askedOwner(store)).toEqual([]);
    expect(source.statusOf('3')).toBe('building');
    expect(mothership.rows.has('3')).toBe(true);
    expect(store.readBuilding(podId).runs[0]?.blocked).toBeUndefined();
  });

  it("refuses a ticket that isn't the one being built", async () => {
    const { store, podId, source } = await setUp();

    await expect(
      blockTicket({ store, podId, ticketId: '4', parts, source })
    ).rejects.toThrow("4 isn't the ticket this pod is building.");
    expect(askedOwner(store)).toEqual([]);
    expect(source.statusOf('4')).toBe('ready');
  });

  it('blocks the ticket with its reason and asks the owner', async () => {
    const { store, podId, source } = await setUp();

    await blockTicket({ store, podId, ticketId: '3', parts, source });

    expect(source.statusOf('3')).toBe('blocked');
    expect(source.updates.at(-1)).toEqual({
      id: '3',
      input: { status: 'blocked', reason: 'The photo storage key is missing' },
    });
    expect(askedOwner(store)[0]?.from).toBe('engineering-manager');
    // The run names its inbox item, so the item settles once the ticket is back.
    expect(store.readBuilding(podId).runs[0]?.blocked?.messageId).toBe(
      askedOwner(store)[0]?.id
    );
  });

  it('marks only the current run, never an earlier blocked run of the same ticket', async () => {
    const { store, podId, source } = await setUp();
    const earlier = {
      at: '2026-10-22T09:00:00.000Z',
      what: 'Trail markers',
      problem: 'No progress on Test for 40 minutes',
      options: '1) look at the Agents tab  2) set it back to Ready to retry',
      recommendation: 'Check the Agents tab.',
    };
    store.updateBuilding(podId, (state) => ({
      ...state,
      runs: state.runs.flatMap((run) => [{ ...run, blocked: earlier }, run]),
    }));

    await blockTicket({ store, podId, ticketId: '3', parts, source });

    const [first, second] = store.readBuilding(podId).runs;
    expect(first?.blocked).toEqual(earlier);
    expect(second?.blocked?.problem).toBe('The photo storage key is missing');
  });
});

describe('lambda pod blocked goes through lambda tickets update', () => {
  it('blocks with a problem that spans lines: its first line is the reason, the inbox keeps it all', async () => {
    const { store, podId, source } = await setUp();
    const problem = 'The rec center feed is down\nsince Tuesday';

    await blockTicket({
      store,
      podId,
      ticketId: '3',
      parts: {
        what: 'Trail markers',
        problem,
        options: '1) wait  2) skip',
        recommendation: 'wait',
      },
      source,
    });

    expect(source.statusOf('3')).toBe('blocked');
    expect(source.updates.at(-1)).toEqual({
      id: '3',
      input: { status: 'blocked', reason: 'The rec center feed is down' },
    });
    expect(store.readBuilding(podId).runs[0]?.blocked?.problem).toBe(problem);
  });
});

describe('two lambda pod blocked for one ticket at once', () => {
  const parts: BlockedParts = {
    what: 'Trail markers',
    problem: 'The rec center feed is down',
    options: '1) wait  2) skip',
    recommendation: 'wait',
  };

  /** The other block finishes, and the pod picks up ticket 4. */
  const otherBlockThenTicket4 = (
    store: ReturnType<typeof buildingPodStore>['store'],
    podId: string
  ) =>
    store.updateBuilding(podId, (state) => ({
      ...state,
      runs: [
        ...state.runs.map((run) => ({
          ...run,
          blocked: { at: '2026-10-23T10:05:00.000Z', ...parts },
        })),
        {
          id: '4',
          title: 'Lot 48 photos',
          step: 'pick-up' as const,
          attempt: 1,
          startedAt: '2026-10-23T10:06:00.000Z',
          claim: 'claimed' as const,
        },
      ],
    }));

  const expectTicket4LeftAlone = (
    store: ReturnType<typeof buildingPodStore>['store'],
    podId: string
  ) => {
    const { runs } = store.readBuilding(podId);
    expect(runs.map((run) => run.id)).toEqual(['3', '4']);
    expect(runs[1]?.blocked).toBeUndefined();
    expect(askedOwner(store)).toEqual([]);
  };

  it('leaves the next ticket alone when the other block got there while the tracker answered', async () => {
    const { store, podId, source } = await setUp();
    const racing = {
      ...source,
      update: async (
        id: string,
        input: Parameters<typeof source.update>[1]
      ) => {
        const updated = await source.update(id, input);
        otherBlockThenTicket4(store, podId);

        return updated;
      },
    };

    await blockTicket({ store, podId, ticketId: '3', parts, source: racing });

    expectTicket4LeftAlone(store, podId);
  });

  it('leaves the next ticket alone when the other block got there while the work was set aside', async () => {
    const { store, podId, source } = await setUp();
    // A clean checkout, and the race lands while git looks at it.
    const git = () => {
      otherBlockThenTicket4(store, podId);

      return '';
    };

    await blockTicket({ store, podId, ticketId: '3', parts, source, git });

    expectTicket4LeftAlone(store, podId);
  });
});
