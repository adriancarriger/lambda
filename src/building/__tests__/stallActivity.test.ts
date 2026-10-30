import { blockTicket } from '../blocked';
import { createBuildingDriver } from '../driver';
import { type Activity, HUNG_MS, hungNudgeText, idleNudgeText } from '../stall';
import {
  LESLIE,
  buildingPodStore,
  fakeMothership,
  fakeSource,
  ticket,
} from './fakes';

/**
 * The stall watch by who is working (Adrian, 2026-10-28): nobody working on
 * an unfinished ticket is a lost handoff, nudged in minutes; a long E2E run
 * is one long turn, never a stall.
 */

const RUNNER = 'r-leslie-mac';
const T0 = Date.parse('2026-10-23T10:00:00.000Z');
const MINUTE = 60_000;

const IDLE: Activity = { busy: [], running: [] };

const setUp = async () => {
  const { store, root, podId } = buildingPodStore();
  const source = fakeSource([
    ticket('3', { title: 'Trail markers' }),
    ticket('4', { title: 'Lot 48 photos' }),
  ]);
  const clock = { now: T0 };
  const screen = { text: 'dev: running the map pin check' };
  const working: Activity = { busy: ['dev'], running: [] };
  const who = { now: working };
  const sent: { list: { target: string; text: string }[] } = { list: [] };
  const driver = createBuildingDriver({
    store,
    podId,
    projectRoot: root,
    runnerId: RUNNER,
    source: () => source,
    owner: () => LESLIE,
    mothership: fakeMothership().forRunner(RUNNER),
    interrupt: async () => undefined,
    send: async (target, text) => {
      sent.list = [...sent.list, { target, text }];
    },
    block: (ticketId, parts) =>
      blockTicket({ store, podId, ticketId, parts, source }),
    panes: () => screen.text,
    activity: () => who.now,
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

  const after = async (minutes: number): Promise<void> => {
    clock.now += minutes * MINUTE;
    await driver.tick();
  };

  const blocked = () =>
    store
      .readThread('build-a1b2')
      .filter((message) => message.expectsReply === true);

  return { store, podId, source, screen, who, sent, after, blocked };
};

describe('the stall watch, by who is working', () => {
  it('nudges within minutes when nobody is working and the ticket is not done', async () => {
    const { who, sent, after } = await setUp();

    await after(1);
    who.now = IDLE;
    await after(1);
    await after(2);

    expect(sent.list).toEqual([]);

    await after(1);

    expect(sent.list).toEqual([
      { target: 'engineering-manager', text: idleNudgeText('test') },
    ]);
  });

  it('never nudges a long E2E run under the hung limit: one long turn with frozen panes', async () => {
    const { sent, after, blocked } = await setUp();

    await after(1);
    await Array.from({ length: 12 }).reduce<Promise<void>>(async (done) => {
      await done;
      await after(10);
    }, Promise.resolve());

    expect(sent.list).toEqual([]);
    expect(blocked()).toEqual([]);
  });

  it('counts a command still running after its agent ended the turn as working', async () => {
    const { who, sent, after } = await setUp();

    await after(1);
    who.now = { busy: [], running: ['dev'] };
    await after(30);
    await after(30);

    expect(sent.list).toEqual([]);
  });

  it('nudges a turn whose panes stay frozen for the hung limit', async () => {
    const { sent, after } = await setUp();

    await after(1);
    await after(HUNG_MS / MINUTE - 1);

    expect(sent.list).toEqual([]);

    await after(1);

    expect(sent.list).toEqual([
      { target: 'engineering-manager', text: hungNudgeText('test') },
    ]);
  });

  it('starts over when work picks up after an idle nudge: the next lost handoff is nudged, not blocked', async () => {
    const { who, sent, after, blocked } = await setUp();

    await after(1);
    who.now = IDLE;
    await after(1);
    await after(3);
    expect(sent.list).toHaveLength(1);

    who.now = { busy: ['engineering-manager'], running: [] };
    await after(5);
    who.now = IDLE;
    await after(1);
    await after(3);

    expect(sent.list).toEqual([
      { target: 'engineering-manager', text: idleNudgeText('test') },
      { target: 'engineering-manager', text: idleNudgeText('test') },
    ]);
    expect(blocked()).toEqual([]);
  });

  it('blocks when nobody takes the step up again in the 20 minutes after a nudge, saying so', async () => {
    const { who, source, sent, after, blocked } = await setUp();

    await after(1);
    who.now = IDLE;
    await after(1);
    await after(3);
    await after(20);

    expect(sent.list).toHaveLength(1);
    expect(source.statusOf('3')).toBe('blocked');
    expect(blocked()[0]?.text).toContain(
      '**Problem:** Nobody took Test up again in the 20 minutes after a nudge'
    );
  });
});
