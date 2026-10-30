import * as fs from 'fs';
import * as path from 'path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { buildingPodStore } from '../../building/__tests__/fakes';
import {
  copyRoundToPod,
  readVisualRounds,
} from '../../building/visualPictures';
import { writePng } from '../../design/__tests__/pngFixture';
import { VisualPairs } from '../client/BuildingPodScreen';
import {
  shippedTicketDurations,
  thisTicketMs,
  ticketTimeline,
  typicalTicketMs,
  wholeRun,
} from '../shared/buildTimeline';
import { type TimelineEvent, visualRail } from '../shared/building';

// react-markdown is ESM-only, and the terminal pulls in xterm's CSS.
jest.mock('../client/Message', () => ({ Markdown: () => null }));
jest.mock('../client/TerminalView', () => ({ TerminalView: () => null }));

const MIN = 60_000;

const STEPS = [
  { id: 'pick-up', label: 'Pick up the next ticket' },
  { id: 'build', label: 'Build it' },
  { id: 'self-review', label: 'Review the change' },
  { id: 'check-ticket', label: 'Check against the ticket' },
  { id: 'test', label: 'Test it' },
  { id: 'ship', label: 'Ship it' },
];

const event = (
  type: string,
  minute: number,
  extra: Partial<TimelineEvent> = {}
): TimelineEvent => ({
  type,
  name: null,
  ticket: '3',
  attempt: null,
  pod: 'pawnee-build-a1b2',
  result: null,
  at: minute * MIN,
  ...extra,
});

const step = (
  name: string,
  from: number,
  to: number | null,
  attempt = 1,
  ticket = '3'
): TimelineEvent[] => [
  event('stage.start', from, { name, attempt, ticket }),
  ...(to === null ? [] : [event('stage.end', to, { name, attempt, ticket })]),
];

/** One ticket, pick-up to ship, as the ticket's Test Plan fixes it. */
const PICKUP_TIMES = [
  ...step('pick-up', 0, 1),
  ...step('build', 1, 13),
  ...step('self-review', 13, 16),
  ...step('check-ticket', 16, 18),
  ...step('test', 18, 22, 1),
  ...step('test', 25, 32, 2),
  ...step('ship', 32, 36),
  event('ship.start', 32),
  event('stage.start', 32, { name: 'security-review' }),
  event('attempt.start', 32, { attempt: 1 }),
  event('stage.end', 34, { name: 'security-review' }),
  event('attempt.end', 34, { attempt: 1, result: 'fail' }),
  event('attempt.start', 35, { attempt: 2 }),
  event('attempt.end', 36, { attempt: 2, result: 'pass' }),
  event('ship.end', 36),
];

/** A shipped ticket of `minutes`, pick-up start to ship done. */
const shippedTicket = (ticket: string, minutes: number): TimelineEvent[] => [
  ...step('pick-up', 0, 1, 1, ticket),
  ...step('ship', minutes - 1, minutes, 1, ticket),
];

describe('the Workflow rail’s timeline', () => {
  it('shows a step done that ended without a reported start, as Ship did', () => {
    const events = [
      ...step('pick-up', 0, 1),
      ...step('build', 1, 2),
      // `lambda ship` closed it; the Engineering manager never said it began.
      event('stage.end', 3, { name: 'ship', attempt: 1 }),
    ];
    const of = (id: string) =>
      ticketTimeline(events, '3', STEPS).steps.find((one) => one.id === id);

    expect(of('ship')).toEqual(
      expect.objectContaining({ status: 'done', ms: 0 })
    );
    expect(of('test')?.status).toBe('todo');
  });

  it('times each step of the current ticket, retries summed', () => {
    const timeline = ticketTimeline(PICKUP_TIMES, '3', STEPS);
    const of = (id: string) => timeline.steps.find((one) => one.id === id);

    expect(of('build')?.ms).toBe(12 * MIN);
    expect(of('test')?.ms).toBe(11 * MIN);
    expect(of('test')?.label).toBe('Test · attempt 2');
    expect(of('build')?.label).toBe('Build');
  });

  it('opens Ship into its stages, in the order first reported', () => {
    expect(ticketTimeline(PICKUP_TIMES, '3', STEPS).shipStages).toEqual([
      'Attempt 2',
      'Security review 2m',
      'Fixing 1m',
    ]);
  });

  it('opens Ship into the latest ship run, not a failed earlier one', () => {
    const reshipped = [
      ...step('pick-up', 0, 1),
      event('ship.start', 10),
      event('stage.start', 10, { name: 'security-review' }),
      event('stage.end', 12, { name: 'security-review' }),
      event('ship.end', 12, { result: 'fail' }),
      event('ship.start', 20),
      event('stage.start', 20, { name: 'deploy' }),
      event('stage.end', 25, { name: 'deploy' }),
      event('ship.end', 25, { result: 'pass' }),
    ];

    expect(ticketTimeline(reshipped, '3', STEPS).shipStages).toEqual([
      'Deploy 5m',
    ]);
  });

  it('runs a ticket from its pick-up start to its ship done', () => {
    expect(ticketTimeline(PICKUP_TIMES, '3', STEPS).totalMs).toBe(36 * MIN);
  });

  it('runs a ticket blocked and taken again from its last pick-up, not its first', () => {
    const DAY = 24 * 60;
    const retaken = [
      ...step('pick-up', 0, 1),
      ...step('build', 1, 10),
      // Blocked on day 1, set back to Ready, taken again on day 3.
      ...step('pick-up', 2 * DAY, 2 * DAY + 1),
      ...step('build', 2 * DAY + 1, 2 * DAY + 12),
      ...step('ship', 2 * DAY + 12, 2 * DAY + 20),
    ];

    expect(ticketTimeline(retaken, '3', STEPS).totalMs).toBe(20 * MIN);
    expect(shippedTicketDurations(retaken)).toEqual([20 * MIN]);
  });

  it('marks the active step while a ticket is still going', () => {
    const going = [...step('pick-up', 0, 1), ...step('build', 1, null)];
    const timeline = ticketTimeline(going, '3', STEPS, 5 * MIN);

    expect(timeline.steps.map((one) => [one.id, one.status, one.ms])).toEqual([
      ['pick-up', 'done', 1 * MIN],
      ['build', 'active', 4 * MIN],
      ['self-review', 'todo', 0],
      ['check-ticket', 'todo', 0],
      ['test', 'todo', 0],
      ['ship', 'todo', 0],
    ]);
    expect(timeline.totalMs).toBeNull();
  });
});

describe('This ticket', () => {
  const run = {
    startedAt: new Date(0).toISOString(),
  };

  it('is the pick-up-to-ship time once it has shipped', () => {
    expect(thisTicketMs(run, 36 * MIN, 500 * MIN)).toBe(36 * MIN);
  });

  it('counts up to now while it is going', () => {
    expect(thisTicketMs(run, null, 30 * MIN)).toBe(30 * MIN);
  });

  it('stops at the moment a ticket was blocked', () => {
    const blocked = {
      ...run,
      blocked: { at: new Date(30 * MIN).toISOString() },
    };

    expect(thisTicketMs(blocked, null, 250 * MIN)).toBe(30 * MIN);
  });
});

describe('Typical ticket', () => {
  it('is not shown with one shipped ticket', () => {
    expect(
      typicalTicketMs(shippedTicketDurations(shippedTicket('1', 18)))
    ).toBeNull();
  });

  it('is the median of the shipped tickets, the mean of the middle two for an even count', () => {
    const four = [
      ...shippedTicket('1', 18),
      ...shippedTicket('2', 33),
      ...shippedTicket('3', 24),
      ...shippedTicket('4', 40),
    ];
    const three = [
      ...shippedTicket('1', 18),
      ...shippedTicket('2', 33),
      ...shippedTicket('3', 24),
    ];

    expect(typicalTicketMs(shippedTicketDurations(four))).toBe(28.5 * MIN);
    expect(typicalTicketMs(shippedTicketDurations(three))).toBe(24 * MIN);
  });

  it('counts only shipped tickets', () => {
    expect(
      shippedTicketDurations([
        ...shippedTicket('1', 18),
        ...step('pick-up', 0, 1, 1, '2'),
      ])
    ).toEqual([18 * MIN]);
  });
});

describe('Whole run', () => {
  it('shows each step’s share of the time across every ticket so far', () => {
    const events = [
      ...step('build', 0, 10, 1, '1'),
      ...step('test', 10, 15, 1, '1'),
      ...step('build', 20, 40, 1, '2'),
      ...step('test', 40, 55, 1, '2'),
    ];
    const run = wholeRun(events, ['1', '2'], STEPS);

    expect(run.totalMs).toBe(50 * MIN);
    expect(
      run.steps
        .filter((one) => one.ms > 0)
        .map((one) => [one.label, one.percent])
    ).toEqual([
      ['Build', 60],
      ['Test', 40],
    ]);
  });

  it('leaves out tickets this pod never took', () => {
    const events = [
      ...step('build', 0, 10, 1, '1'),
      ...step('build', 0, 30, 1, '9'),
    ];

    expect(wholeRun(events, ['1'], STEPS).totalMs).toBe(10 * MIN);
  });
});

describe("the default ship's own parts", () => {
  // The test step, then Ship: `lambda ship` runs the codebase's tests (a
  // `test` stage) and commits, inside its ship.start … ship.end.
  const withDefaultShip = (shipEnded: boolean): TimelineEvent[] => [
    ...step('pick-up', 0, 1),
    ...step('test', 1, 6),
    ...step('ship', 10, shipEnded ? 20 : null),
    event('ship.start', 11, { attempt: 1 }),
    event('stage.start', 11, { name: 'test', attempt: 1 }),
    event('stage.end', 15, { name: 'test', attempt: 1 }),
    event('stage.start', 15, { name: 'commit', attempt: 1 }),
    event('stage.end', 16, { name: 'commit', attempt: 1 }),
    ...(shipEnded
      ? [event('ship.end', 17, { attempt: 1, result: 'pass' })]
      : []),
  ];

  it("count toward Ship, not the Test step's time or attempts", () => {
    const timeline = ticketTimeline(
      withDefaultShip(true),
      '3',
      STEPS,
      30 * MIN
    );
    const test = timeline.steps.find((one) => one.id === 'test');

    expect(test).toMatchObject({ label: 'Test', ms: 5 * MIN, attempt: 1 });
    expect(timeline.shipStages).toEqual(['Test 4m', 'Commit 1m']);
  });

  it("don't make Test look active while Ship is running", () => {
    const timeline = ticketTimeline(
      withDefaultShip(false),
      '3',
      STEPS,
      15 * MIN
    );

    expect(timeline.steps.find((one) => one.id === 'test')?.status).toBe(
      'done'
    );
    expect(timeline.steps.find((one) => one.id === 'ship')?.status).toBe(
      'active'
    );
  });

  it('end at the next ship or pick-up when a ship run never reported its end', () => {
    // The ship run died before its ship.end; the ticket was taken again.
    const crashed: TimelineEvent[] = [
      ...step('pick-up', 0, 1),
      ...step('ship', 10, 12),
      event('ship.start', 11, { attempt: 1 }),
      event('stage.start', 11, { name: 'test', attempt: 1 }),
      ...step('pick-up', 40, 41, 2),
      ...step('test', 41, 47, 2),
    ];
    const timeline = ticketTimeline(crashed, '3', STEPS, 50 * MIN);

    expect(timeline.steps.find((one) => one.id === 'test')?.ms).toBe(6 * MIN);
    expect(
      wholeRun(crashed, ['3'], STEPS, 50 * MIN).steps.find(
        (one) => one.id === 'test'
      )?.ms
    ).toBe(6 * MIN);
  });

  it('end with the Ship step when a ship run never reported its end', () => {
    // The ship run died; the Ship step ended and the ticket went back to Test.
    const failed: TimelineEvent[] = [
      ...step('pick-up', 0, 1),
      ...step('ship', 10, 15),
      event('ship.start', 11, { attempt: 1 }),
      ...step('test', 12, 13, 1),
      ...step('test', 20, 25, 2),
    ];
    const timeline = ticketTimeline(failed, '3', STEPS, 30 * MIN);

    expect(timeline.steps.find((one) => one.id === 'test')).toMatchObject({
      ms: 5 * MIN,
      status: 'done',
    });
    expect(timeline.shipStages).toEqual(['Test 1m']);
  });

  it('end at the next ship.start when a ship run never reported its end', () => {
    const retried: TimelineEvent[] = [
      ...step('pick-up', 0, 1),
      ...step('ship', 10, null),
      event('ship.start', 11, { attempt: 1 }),
      ...step('test', 12, 13, 1),
      event('ship.start', 20, { attempt: 2 }),
      ...step('test', 21, 25, 2),
    ];
    const timeline = ticketTimeline(retried, '3', STEPS, 40 * MIN);

    expect(timeline.steps.find((one) => one.id === 'test')?.ms).toBe(0);
    expect(timeline.shipStages).toEqual(['Test 4m']);
  });

  it("aren't counted as Test in the whole run", () => {
    const run = wholeRun(withDefaultShip(true), ['3'], STEPS, 30 * MIN);

    expect(run.steps.find((one) => one.id === 'test')?.ms).toBe(5 * MIN);
  });
});

describe('a run of the ticket, not every event with its id', () => {
  const at = (minute: number) => new Date(minute * MIN).toISOString();
  // Run 1 stalled mid-Test (no stage.end) and went blocked at minute 10;
  // set back to Ready, run 2 took it at minute 100.
  const retaken: TimelineEvent[] = [
    ...step('pick-up', 0, 1),
    ...step('test', 5, null, 1),
    ...step('pick-up', 100, 100),
    ...step('test', 102, null, 1),
  ];
  const run1 = { id: '3', startedAt: at(0), blocked: { at: at(10) } };
  const run2 = { id: '3', startedAt: at(100) };

  it('starts a re-taken ticket’s attempts again, with only the new run’s time', () => {
    const test = ticketTimeline(retaken, '3', STEPS, 110 * MIN, {
      run: run2,
    }).steps.find((one) => one.id === 'test');

    expect(test).toMatchObject({ label: 'Test', attempt: 1, ms: 8 * MIN });
  });

  it('stops a blocked run’s open step at the moment it was blocked', () => {
    const test = ticketTimeline(retaken, '3', STEPS, 250 * MIN, {
      run: run1,
    }).steps.find((one) => one.id === 'test');

    expect(test?.ms).toBe(5 * MIN);
  });

  it('never shows a blocked run’s open step as active', () => {
    const blockedOnly = [...step('pick-up', 0, 1), ...step('test', 5, null, 1)];
    const test = ticketTimeline(blockedOnly, '3', STEPS, 250 * MIN, {
      run: run1,
    }).steps.find((one) => one.id === 'test');

    expect(test?.status).toBe('done');
  });

  it('ends a step that never reported its end when the next step started', () => {
    const skippedEnd = [
      ...step('pick-up', 0, 1),
      ...step('self-review', 5, null),
      ...step('test', 8, 12),
    ];
    const review = ticketTimeline(skippedEnd, '3', STEPS, 20 * MIN).steps.find(
      (one) => one.id === 'self-review'
    );

    expect(review).toMatchObject({ ms: 3 * MIN, status: 'done' });
  });

  it('leaves out another pod’s events for the same ticket', () => {
    const shared = [
      ...step('build', 0, 10),
      event('stage.start', 0, { name: 'build', pod: 'eagleton-build-z9' }),
      event('stage.end', 30, { name: 'build', pod: 'eagleton-build-z9' }),
    ];
    const scope = { pod: 'pawnee-build-a1b2' };

    expect(
      ticketTimeline(shared, '3', STEPS, 40 * MIN, scope).steps.find(
        (one) => one.id === 'build'
      )?.ms
    ).toBe(10 * MIN);
    expect(wholeRun(shared, ['3'], STEPS, 40 * MIN, scope).totalMs).toBe(
      10 * MIN
    );
  });

  it('counts each run once in the whole run, a blocked one up to its block', () => {
    const run = wholeRun(retaken, ['3'], STEPS, 110 * MIN, {
      runs: [run1, run2],
    });

    // Run 1: pick-up 1m + test 5m; run 2: pick-up 0m + test 8m.
    expect(run.steps.find((one) => one.id === 'test')?.ms).toBe(13 * MIN);
    expect(run.totalMs).toBe(14 * MIN);
  });
});

describe('shipped ticket durations across many tickets', () => {
  it('times each ticket on its own, interleaved and re-taken alike', () => {
    const DAY = 24 * 60;
    const events = [
      ...shippedTicket('1', 18),
      ...step('pick-up', 5, 6, 1, '2'),
      ...step('ship', 30, 33, 1, '2'),
      ...step('pick-up', 0, 1, 1, '4'),
      ...step('pick-up', DAY, DAY + 1, 1, '4'),
      ...step('ship', DAY + 10, DAY + 12, 1, '4'),
      ...step('pick-up', 40, 41, 1, '5'),
    ];

    expect(shippedTicketDurations(events)).toEqual([
      18 * MIN,
      28 * MIN,
      12 * MIN,
    ]);
  });
});

describe("the Workflow rail's Visual check", () => {
  const T = 'PAWNEE-5';

  /** Rounds 1 and 2 recorded: trail-closed still off, trail-open matching. */
  const recorded = () => {
    const { store, root, podId } = buildingPodStore();
    ['trail-closed', 'trail-open'].forEach((id) => {
      [
        path.join(root, '.lambda', 'pulled', T, `${id}.png`),
        path.join(root, 'shots', `${id}.png`),
      ].forEach((file) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writePng(file, 4, 4);
      });
    });
    const picture = (
      id: string,
      issues: { severity: 'medium'; where: string; what: string }[]
    ) => ({
      scenarioId: id,
      situation: `Trail map — ${id}`,
      expected: `.lambda/pulled/${T}/${id}.png`,
      actual: `shots/${id}.png`,
      issues,
    });
    [1, 2].forEach((round) =>
      copyRoundToPod({
        store,
        podId,
        projectRoot: root,
        ticketId: T,
        record: {
          round,
          at: '2026-10-23T10:00:00.000Z',
          pictures: [
            picture('trail-closed', [
              {
                severity: 'medium',
                where: 'Legend',
                what: 'below the map, should be beside it',
              },
            ]),
            picture('trail-open', []),
          ],
          decision: { stop: false, reason: null },
        },
      })
    );

    return { store, podId };
  };

  it('copies each recorded round into the pod, its manifest listing both pictures', () => {
    const { store, podId } = recorded();
    const manifest: unknown = JSON.parse(
      fs.readFileSync(
        store.file(podId, 'visual', T, '1', 'manifest.json'),
        'utf8'
      )
    );

    expect(manifest).toEqual([
      expect.objectContaining({
        scenarioId: 'trail-closed',
        expected: 'expected-trail-closed.png',
        actual: 'actual-trail-closed.png',
      }),
      expect.objectContaining({ scenarioId: 'trail-open', issues: [] }),
    ]);
    expect(
      fs.existsSync(
        store.file(podId, 'visual', T, '1', 'actual-trail-open.png')
      )
    ).toBe(true);
  });

  it('shows "Visual check · round 2", one pair per picture per round, ✗ on the one with an issue', () => {
    const { store, podId } = recorded();
    const rail = visualRail(readVisualRounds(store, podId), {
      id: T,
      startedAt: '2026-10-23T09:00:00.000Z',
    });

    expect(rail.label).toBe('Visual check · round 2');

    const html = renderToStaticMarkup(
      createElement(VisualPairs, {
        podId,
        ticketId: T,
        rounds: rail.rounds.slice(-1),
        onPair: () => undefined,
      })
    );

    expect(html.match(/class="build-pair[ "]/g)).toHaveLength(2);
    expect(html.match(/build-pair--missed/g)).toHaveLength(1);
    expect(html.match(/✗/g)).toHaveLength(1);
    expect(html).toContain(
      `/api/pod/${podId}/visual/${T}/2/expected-trail-closed.png`
    );
  });

  it('leaves out an earlier run’s rounds', () => {
    const { store, podId } = recorded();

    expect(
      visualRail(readVisualRounds(store, podId), {
        id: T,
        startedAt: '2999-01-01T00:00:00.000Z',
      })
    ).toEqual({ label: null, rounds: [] });
  });

  it('clears the last loop’s rounds when a new loop records its round 1', () => {
    const { store, podId } = recorded();
    const [first] = readVisualRounds(store, podId)[T] ?? [];

    if (first === undefined) {
      throw new Error('round 1 was not copied');
    }

    copyRoundToPod({
      store,
      podId,
      projectRoot: path.dirname(path.dirname(store.root)),
      ticketId: T,
      record: {
        round: 1,
        at: '2026-10-23T12:00:00.000Z',
        pictures: [],
        decision: { stop: true, reason: 'only-low' },
      },
    });

    expect(
      readVisualRounds(store, podId)[T]?.map(({ round }) => round)
    ).toEqual([1]);
  });
});
