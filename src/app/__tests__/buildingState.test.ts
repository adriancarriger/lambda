import type { BuildTicketRun, BuildingState } from '../../pod-store';
import {
  buildingLine,
  buildingStateOf,
  headerBuilding,
  openTalks,
  takenTickets,
  ticketsRail,
} from '../shared/building';

const run = (
  id: string,
  extra: Partial<BuildTicketRun> = {}
): BuildTicketRun => ({
  id,
  title: `Ticket ${id}`,
  step: 'build',
  attempt: 1,
  startedAt: '2026-10-23T10:00:00.000Z',
  ...extra,
});

const shipped = (id: string) =>
  run(id, { step: 'ship', shippedAt: '2026-10-23T11:00:00.000Z' });

const blocked = (id: string) =>
  run(id, {
    blocked: {
      at: '2026-10-23T11:00:00.000Z',
      what: 'Lot 48 photos',
      problem: 'The photo storage key is missing',
      options: '1) add the key  2) skip photos for now',
      recommendation: 'add the key',
    },
  });

const state = (
  runs: BuildTicketRun[],
  upNext: string[] = []
): BuildingState => ({
  runs,
  upNext: upNext.map((id) => ({ id, title: `Ticket ${id}` })),
});

describe('a building pod in the sidebar', () => {
  it('reads its state from the current ticket’s step', () => {
    expect(
      buildingStateOf({ status: 'active' }, state([run('3', { step: 'test' })]))
        .state
    ).toBe('testing');
    expect(
      buildingStateOf({ status: 'active' }, state([run('3', { step: 'ship' })]))
        .state
    ).toBe('shipping');
    expect(
      buildingStateOf(
        { status: 'active' },
        state([run('3', { step: 'build' })])
      ).state
    ).toBe('building');
    expect(
      buildingStateOf(
        { status: 'active' },
        state([run('3', { step: 'a11y-check' })])
      ).state
    ).toBe('building');
  });

  it('is paused when paused, whatever its step', () => {
    expect(
      buildingStateOf(
        { status: 'paused' },
        state([run('3', { step: 'test', attempt: 2 })])
      ).state
    ).toBe('paused');
  });

  it('is idle with no current ticket', () => {
    expect(buildingStateOf({ status: 'active' }, state([])).state).toBe('idle');
    expect(
      buildingStateOf({ status: 'active' }, state([shipped('1')])).state
    ).toBe('idle');
  });

  it('is blocked when its last ticket went Blocked and nothing is takeable', () => {
    expect(
      buildingStateOf({ status: 'active' }, state([shipped('1'), blocked('5')]))
        .state
    ).toBe('blocked');
    expect(
      buildingStateOf(
        { status: 'active' },
        state([shipped('1'), blocked('5')], ['6'])
      ).state
    ).toBe('idle');
  });

  it('counts "ticket N of M": taken so far, plus what is still queued', () => {
    const view = buildingStateOf(
      { status: 'active' },
      state(
        [shipped('1'), shipped('2'), blocked('5'), run('3', { step: 'test' })],
        ['6', '7', '8']
      )
    );

    expect(view.position).toEqual({ n: 4, m: 7 });
    expect(view.current?.id).toBe('3');
  });

  it('counts a blocked ticket set back to Ready once, and once again when retaken', () => {
    const taken = [shipped('1'), shipped('2'), blocked('5')];
    // 3 went Blocked and was set back to Ready: it's in the runs and Up next.
    const setBack = buildingStateOf(
      { status: 'active' },
      state([...taken, blocked('3')], ['3', '6', '7', '8'])
    );
    const retaken = buildingStateOf(
      { status: 'active' },
      state(
        [...taken, blocked('3'), run('3', { step: 'test' })],
        ['6', '7', '8']
      )
    );

    expect(setBack.position).toEqual({ n: 4, m: 7 });
    expect(retaken.position).toEqual({ n: 4, m: 7 });
    expect(retaken.current?.id).toBe('3');
  });

  it('counts a ticket taken again later at its latest place', () => {
    const view = buildingStateOf(
      { status: 'active' },
      state([shipped('1'), blocked('5'), shipped('2'), run('5')], ['6'])
    );

    expect(view.position).toEqual({ n: 3, m: 4 });
  });

  it('counts each ticket once in "across N tickets"', () => {
    expect(takenTickets(state([shipped('1'), blocked('3'), run('3')]))).toEqual(
      ['1', '3']
    );
  });

  it('has no position before it has taken anything', () => {
    expect(
      buildingStateOf({ status: 'active' }, state([], ['1'])).position
    ).toBeNull();
  });
});

describe("a building pod's Tickets rail", () => {
  it('lists only shipped tickets under Done, never a blocked one', () => {
    const rail = ticketsRail(
      state(
        [shipped('1'), blocked('5'), shipped('2'), run('3', { step: 'test' })],
        ['6', '7']
      )
    );

    expect(rail.done.map((one) => one.id)).toEqual(['1', '2']);
    expect(rail.current?.id).toBe('3');
    expect(rail.upNext.map((one) => one.id)).toEqual(['6', '7']);
  });

  it('leaves out a ticket let go when its pod ended', () => {
    const released = run('4', { claim: 'released' });

    expect(ticketsRail(state([shipped('1'), released])).done).toEqual([
      expect.objectContaining({ id: '1' }),
    ]);
  });
});

describe('the sidebar line', () => {
  it('reads "testing · ticket 4 of 7"', () => {
    expect(
      buildingLine(
        buildingStateOf(
          { status: 'active' },
          state(
            [
              shipped('1'),
              shipped('2'),
              blocked('5'),
              run('3', { step: 'test' }),
            ],
            ['6', '7', '8']
          )
        )
      )
    ).toBe('testing · ticket 4 of 7');
  });

  it('reads the live state in the page header, not the page’s older read', () => {
    const polled = buildingStateOf(
      { status: 'active' },
      state([run('3', { step: 'test' })])
    );
    const live = buildingStateOf(
      { status: 'paused' },
      state([run('3', { step: 'test' })])
    );

    expect(buildingLine(headerBuilding(live, polled) ?? polled)).toBe(
      buildingLine(live)
    );
    expect(buildingLine(live)).not.toBe(buildingLine(polled));
    expect(headerBuilding(undefined, polled)).toBe(polled);
  });

  it('says why it is idle', () => {
    expect(
      buildingLine(
        buildingStateOf(
          { status: 'active' },
          { ...state([]), idleReason: 'Nothing ready to build' }
        )
      )
    ).toBe('idle · Nothing ready to build');
  });
});

describe('the sidebar’s Conversations', () => {
  const summary = (
    id: string,
    status: 'active' | 'done',
    talk?: { ticketId: string }
  ) => ({ status, pod: { id, kind: 'building' as const, talk } });

  it('lists each open "Talk about this ticket", never a building pod or a closed talk', () => {
    expect(
      openTalks([
        summary('build-a1b2', 'active'),
        summary('talk-c3d4', 'active', { ticketId: '3' }),
        summary('talk-e5f6', 'done', { ticketId: '4' }),
        summary('talk-0a0b', 'active', { ticketId: '5' }),
      ]).map((one) => one.pod.id)
    ).toEqual(['talk-c3d4', 'talk-0a0b']);
  });
});
