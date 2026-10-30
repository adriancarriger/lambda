import * as path from 'path';

import { required } from '../../__tests__/required';
import {
  type Harness,
  connectRunner,
  eventually,
  holdProject,
  startHarness,
} from '../../mothership/__tests__/harness';
import { UNFINISHED_TYPE, computeAnalytics, overdueStages } from '../analytics';
import type { StoredEvent } from '../schema';

const T0 = Date.UTC(2026, 9, 14, 12);
const MINUTE = 60_000;

const counter = { seq: 0 };
const event = (overrides: Partial<StoredEvent>): StoredEvent => {
  counter.seq += 1;

  return {
    id: `e${counter.seq}`,
    generation: 0,
    projectId: 'prj_pawnee',
    pod: 'dog-park',
    ticket: 'Dog park map',
    attempt: null,
    groupId: null,
    reason: null,
    held: null,
    skipped: null,
    type: 'metric',
    name: null,
    result: null,
    note: null,
    value: null,
    unit: null,
    source: null,
    at: T0,
    receivedAt: T0,
    warning: null,
    ...overrides,
  };
};

/** Attempt 1 fails at security-review; attempt 2 passes. */
const fixtureRun = (): StoredEvent[] => [
  event({ type: 'ship.start', at: T0 }),
  event({ type: 'attempt.start', attempt: 1, at: T0 }),
  event({ type: 'stage.start', name: 'unit tests', attempt: 1, at: T0 }),
  event({
    type: 'stage.end',
    name: 'unit tests',
    attempt: 1,
    at: T0 + 6 * MINUTE,
  }),
  event({
    type: 'stage.start',
    name: 'security-review',
    attempt: 1,
    at: T0 + 6 * MINUTE,
  }),
  event({
    type: 'stage.end',
    name: 'security-review',
    attempt: 1,
    result: 'fail',
    at: T0 + 16 * MINUTE,
  }),
  event({
    type: 'attempt.end',
    attempt: 1,
    result: 'fail',
    at: T0 + 16 * MINUTE,
  }),
  event({ type: 'attempt.start', attempt: 2, at: T0 + 28 * MINUTE }),
  event({
    type: 'stage.start',
    name: 'unit tests',
    attempt: 2,
    at: T0 + 28 * MINUTE,
  }),
  event({
    type: 'stage.end',
    name: 'unit tests',
    attempt: 2,
    at: T0 + 34 * MINUTE,
  }),
  event({
    type: 'stage.start',
    name: 'security-review',
    attempt: 2,
    at: T0 + 34 * MINUTE,
  }),
  event({
    type: 'stage.end',
    name: 'security-review',
    attempt: 2,
    result: 'pass',
    at: T0 + 46 * MINUTE,
  }),
  event({
    type: 'attempt.end',
    attempt: 2,
    result: 'pass',
    at: T0 + 46 * MINUTE,
  }),
  event({ type: 'ship.end', result: 'pass', at: T0 + 48 * MINUTE }),
  event({
    type: 'stage.start',
    name: 'proposal',
    source: 'lambda',
    ticket: null,
    at: T0,
  }),
  event({
    type: 'stage.end',
    name: 'proposal',
    source: 'lambda',
    ticket: null,
    at: T0 + 14 * MINUTE,
  }),
];

describe('Analytics', () => {
  it('totals a ship: runs until green, Fixing, stage and step averages', () => {
    const analytics = computeAnalytics(fixtureRun());

    expect(analytics.ships).toEqual([
      {
        name: 'Dog park map',
        totalMs: 48 * MINUTE,
        runsUntilGreen: 2,
        fixingMs: 12 * MINUTE,
      },
    ]);
    expect(analytics.stages).toEqual(
      expect.arrayContaining([
        { name: 'unit tests', averageMs: 6 * MINUTE, count: 2 },
        { name: 'security-review', averageMs: 11 * MINUTE, count: 2 },
      ])
    );
    expect(analytics.steps).toEqual([
      { name: 'proposal', averageMs: 14 * MINUTE, count: 1 },
    ]);
    expect(analytics.warnings).toEqual([]);
  });

  it('leaves Fixing empty when no retry followed the failed attempt', () => {
    const analytics = computeAnalytics([
      event({ type: 'ship.start', at: T0 }),
      event({ type: 'attempt.start', attempt: 1, at: T0 }),
      event({
        type: 'attempt.end',
        attempt: 1,
        result: 'fail',
        at: T0 + 20 * MINUTE,
      }),
    ]);

    expect(analytics.ships).toEqual([
      {
        name: 'Dog park map',
        totalMs: 20 * MINUTE,
        runsUntilGreen: 1,
        fixingMs: null,
      },
    ]);
  });

  it('shows a stored unfinished-stage row as the warning line', () => {
    const analytics = computeAnalytics([
      event({ type: 'stage.start', name: 'security-review', at: T0 }),
      event({
        type: UNFINISHED_TYPE,
        name: 'security-review',
        at: T0,
        warning: 'security-review (Wed, Oct 14) never finished.',
      }),
    ]);

    expect(analytics.warnings).toEqual([
      '1 stage never finished: security-review (Wed, Oct 14)',
    ]);
  });

  it('works out no warning on its own: a stage open for days is not one until stored', () => {
    expect(
      computeAnalytics([
        event({ type: 'stage.start', name: 'security-review', at: T0 }),
      ]).warnings
    ).toEqual([]);
  });

  it('says when nothing has been recorded', () => {
    const analytics = computeAnalytics([]);

    expect(analytics.empty).toBe(true);
    expect(analytics.notice).toBe(
      'Nothing recorded yet. Events from lambda event and .lambda/events.jsonl show up here.'
    );
    expect(computeAnalytics(fixtureRun()).notice).toBeNull();
  });
});

describe('Analytics over HTTP', () => {
  const fixture: { harness?: Harness } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');

  beforeEach(async () => {
    fixture.harness = await startHarness();
  });

  afterEach(() => harness().close());

  it('keeps an unknown type and a bad line, both as warnings', async () => {
    const runner = await connectRunner(harness());
    await runner.next('owner');
    const folder = path.join('/Users', 'leslie', 'pawnee-parks');
    const projectId = holdProject(harness(), runner.runnerId, { folder });

    runner.send({
      type: 'event',
      id: 'a',
      folder,
      event: { type: 'deploy.start', at: '2026-10-21T12:00:00Z' },
    });
    runner.send({
      type: 'event',
      id: 'b',
      folder,
      event: {
        type: 'invalid',
        raw: 'not json',
        warning: "A line in events.jsonl that isn't an event.",
        at: '2026-10-21T12:00:00Z',
      },
    });
    await eventually(
      () =>
        runner.received.filter((message) => message.type === 'result')
          .length === 2
    );

    const response = await harness().request(
      'GET',
      `/api/analytics?projectId=${projectId}`,
      {
        cookie: harness().signIn(),
      }
    );
    const { analytics } = response.json<{
      analytics: { warnings: string[]; empty: boolean };
    }>();

    expect(analytics.warnings).toEqual([
      'Unknown event type "deploy.start".',
      "A line in events.jsonl that isn't an event.",
    ]);
    expect(analytics.empty).toBe(false);
    await runner.close();
  });

  const analyticsOf = async (projectId: string) =>
    (
      await harness().request('GET', `/api/analytics?projectId=${projectId}`, {
        cookie: harness().signIn(),
      })
    ).json<{
      analytics: { warnings: string[]; empty: boolean; notice: string | null };
    }>().analytics;

  const unfinishedRows = () =>
    harness()
      .db.prepare<[], { id: string; warning: string }>(
        "SELECT id, warning FROM events WHERE type = 'stage.unfinished'"
      )
      .all();

  it('stores a stage with no end after 24 hours as a warning row, once', async () => {
    const runner = await connectRunner(harness());
    await runner.next('owner');
    const folder = '/home/leslie/pawnee-parks';
    const projectId = holdProject(harness(), runner.runnerId, { folder });
    runner.send({
      type: 'event',
      id: 'start-1',
      folder,
      event: {
        type: 'stage.start',
        name: 'security-review',
        at: new Date(harness().clock.now).toISOString(),
      },
    });
    await eventually(() =>
      runner.received.some(
        (message) => message.type === 'result' && message.id === 'start-1'
      )
    );

    harness().clock.now += 23 * 60 * MINUTE;
    await harness().mothership.tick();

    expect(unfinishedRows()).toEqual([]);

    harness().clock.now += 2 * 60 * MINUTE;
    await harness().mothership.tick();
    await harness().mothership.tick();

    expect(unfinishedRows()).toEqual([
      {
        id: 'stage.unfinished:start-1',
        warning: 'security-review (Wed, Oct 21) never finished.',
      },
    ]);
    expect((await analyticsOf(projectId)).warnings).toEqual([
      '1 stage never finished: security-review (Wed, Oct 21)',
    ]);
    await runner.close();
  });

  it('says "Nothing recorded yet." with no events', async () => {
    const runner = await connectRunner(harness());
    await runner.next('owner');
    const projectId = holdProject(harness(), runner.runnerId);

    expect((await analyticsOf(projectId)).notice).toBe(
      'Nothing recorded yet. Events from lambda event and .lambda/events.jsonl show up here.'
    );
    await runner.close();
  });
});

describe('pairing a stage’s start with its end', () => {
  const DAY = 24 * 60 * MINUTE;

  it('pairs an end that names no ticket or attempt with its pod’s open stage', () => {
    const events = [
      event({
        type: 'stage.start',
        name: 'build',
        ticket: 'PAWNEE-12',
        attempt: 2,
        at: T0,
      }),
      event({
        type: 'stage.end',
        name: 'build',
        ticket: null,
        attempt: null,
        at: T0 + MINUTE,
      }),
    ];

    expect(overdueStages(events, T0 + 2 * DAY)).toEqual([]);
  });

  it('pairs an end with the newest start, so the abandoned one is the one flagged', () => {
    const abandoned = event({ type: 'stage.start', name: 'build', at: T0 });
    const retried = event({
      type: 'stage.start',
      name: 'build',
      at: T0 + 10 * MINUTE,
    });
    const events = [
      abandoned,
      retried,
      event({ type: 'stage.end', name: 'build', at: T0 + 12 * MINUTE }),
    ];

    expect(overdueStages(events, T0 + 2 * DAY)).toEqual([abandoned]);
  });

  it('still leaves another ticket’s open stage alone', () => {
    const other = event({
      type: 'stage.start',
      name: 'build',
      ticket: 'PAWNEE-12',
      at: T0,
    });
    const events = [
      other,
      event({
        type: 'stage.end',
        name: 'build',
        ticket: 'PAWNEE-13',
        at: T0 + MINUTE,
      }),
    ];

    expect(overdueStages(events, T0 + 2 * DAY)).toEqual([other]);
  });
});
