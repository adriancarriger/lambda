import * as fs from 'fs';
import * as path from 'path';

import { tempHome } from '../../mothership/__tests__/harness';
import { type Db, openDb } from '../../mothership/db';
import { toTimelineEvent } from '../../mothership/ticketRoutes';
import { flagUnfinishedStages, listEvents, storeEvent } from '../store';

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse('2026-10-21T12:00:00.000Z');

describe('the events store', () => {
  const fixture: { dir?: string; db?: Db } = {};
  const db = (): Db => {
    if (fixture.db === undefined) {
      throw new Error('No db.');
    }

    return fixture.db;
  };

  beforeEach(() => {
    fixture.dir = tempHome();
    fixture.db = openDb(path.join(fixture.dir, 'mothership.db'));
    db()
      .prepare(
        "INSERT INTO projects (id, name, last_used_at) VALUES ('p1', 'Pawnee Parks site', 0)"
      )
      .run();
  });

  afterEach(() => {
    db().close();
    fs.rmSync(fixture.dir ?? '', { recursive: true, force: true });
  });

  it("keeps a bad line's text as its note", () => {
    storeEvent(db(), {
      id: 'b',
      projectId: 'p1',
      event: {
        type: 'invalid',
        raw: 'not json',
        warning: "A line in events.jsonl that isn't an event.",
        at: '2026-10-21T12:00:00Z',
      },
      receivedAt: START,
    });

    expect(listEvents(db(), 'p1')).toEqual([
      expect.objectContaining({
        type: 'invalid',
        note: 'not json',
        warning: "A line in events.jsonl that isn't an event.",
      }),
    ]);
  });

  it('narrows a read to a ticket, a type prefix or a list of types', () => {
    const at = new Date(START).toISOString();
    [
      { type: 'metric', name: 'tokens', value: 12 },
      { type: 'group.add', groupId: 'g1', ticket: '3' },
      { type: 'stage.start', name: 'build', ticket: '3' },
      { type: 'stage.start', name: 'build', ticket: '4' },
      // `_` is a LIKE wildcard: a prefix must match it literally.
      { type: 'groupXadd', ticket: '3' },
    ].forEach((event, index) =>
      storeEvent(db(), {
        id: `n${index}`,
        projectId: 'p1',
        event: { ...event, at },
        receivedAt: START,
      })
    );
    const ids = (events: { id: string }[]) => events.map(({ id }) => id);

    expect(ids(listEvents(db(), 'p1', { ticket: '3' }))).toEqual([
      'n1',
      'n2',
      'n4',
    ]);
    expect(ids(listEvents(db(), 'p1', { typePrefix: 'group.' }))).toEqual([
      'n1',
    ]);
    expect(ids(listEvents(db(), 'p1', { typePrefix: 'group_' }))).toEqual([]);
    expect(
      ids(listEvents(db(), 'p1', { types: ['stage.start'], ticket: '4' }))
    ).toEqual(['n3']);
    expect(ids(listEvents(db(), 'p1', { types: [] }))).toEqual([]);
    expect(ids(listEvents(db(), 'p1'))).toHaveLength(5);
  });

  it('reads only what is recent: events since a time, groups not long shipped', () => {
    const day = 24 * 60 * 60_000;
    [
      { type: 'ship.end', ticket: '1', at: START - 100 * day },
      { type: 'ship.end', ticket: '2', at: START },
      { type: 'group.add', groupId: 'old', ticket: '1', at: START - 100 * day },
      { type: 'group.shipped', groupId: 'old', at: START - 95 * day },
      {
        type: 'group.add',
        groupId: 'open',
        ticket: '3',
        at: START - 100 * day,
      },
    ].forEach(({ at, ...event }, index) =>
      storeEvent(db(), {
        id: `r${index}`,
        projectId: 'p1',
        event: { ...event, at: new Date(at).toISOString() },
        receivedAt: START,
      })
    );
    const ids = (events: { id: string }[]) => events.map(({ id }) => id);

    expect(
      ids(listEvents(db(), 'p1', { types: ['ship.end'], since: START - day }))
    ).toEqual(['r1']);
    expect(
      ids(
        listEvents(db(), 'p1', {
          typePrefix: 'group.',
          groupsShippedSince: START - 90 * day,
        })
      )
    ).toEqual(['r4']);
  });

  it('keeps open groups when an old group.shipped has no group id', () => {
    const day = 24 * 60 * 60_000;
    [
      { type: 'group.shipped', at: START - 95 * day },
      { type: 'group.add', groupId: 'open', ticket: '3', at: START - day },
    ].forEach(({ at, ...event }, index) =>
      storeEvent(db(), {
        id: `n${index}`,
        projectId: 'p1',
        event: { ...event, at: new Date(at).toISOString() },
        receivedAt: START,
      })
    );

    expect(
      listEvents(db(), 'p1', {
        types: ['group.add'],
        groupsShippedSince: START - 90 * day,
      }).map(({ id }) => id)
    ).toEqual(['n1']);
  });

  it('reads a type prefix through the events_type index', () => {
    const prepare = db().prepare.bind(db());
    const reads: { sql: string; params: unknown[] }[] = [];
    const spy = jest.spyOn(db(), 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql);
      const all = statement.all.bind(statement);
      statement.all = (...params: unknown[]) => {
        reads.splice(reads.length, 0, { sql, params });

        return all(...params);
      };

      return statement;
    });
    listEvents(db(), 'p1', { typePrefix: 'group.' });
    spy.mockRestore();

    expect(
      reads.flatMap(({ sql, params }) =>
        prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...params)
          .map((row) => row.detail)
      )
    ).toContainEqual(
      expect.stringContaining(
        'USING INDEX events_type (project_id=? AND type>? AND type<?)'
      )
    );
  });

  it('reads only stage rows when looking for unfinished stages', () => {
    const at = new Date(START).toISOString();
    storeEvent(db(), {
      id: 's1',
      projectId: 'p1',
      event: { type: 'stage.start', name: 'security-review', at },
      receivedAt: START,
    });
    storeEvent(db(), {
      id: 'm1',
      projectId: 'p1',
      event: { type: 'metric', name: 'bundle', value: 412, at },
      receivedAt: START,
    });
    const prepare = jest.spyOn(db(), 'prepare');

    expect(flagUnfinishedStages(db(), START + 2 * DAY)).toBe(1);

    const selects = prepare.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => /^\s*SELECT/i.test(sql));
    expect(selects).toHaveLength(1);
    expect(selects[0]).toMatch(/type IN \('stage\.start', 'stage\.end'\)/);
  });

  it('looks for unfinished stages through an index, not a scan of every event', () => {
    const prepare = db().prepare.bind(db());
    const spy = jest.spyOn(db(), 'prepare');
    flagUnfinishedStages(db(), START + 2 * DAY);
    const selects = spy.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => /^\s*SELECT/i.test(sql));
    spy.mockRestore();

    const plan = selects.flatMap((sql) =>
      prepare<[number], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
        .all(START)
        .map((row) => row.detail)
    );
    expect(plan).toContainEqual(
      expect.stringContaining('USING INDEX events_type_at')
    );
    expect(plan).not.toContainEqual(expect.stringMatching(/^SCAN events\b/));
  });

  it('pairs only the last 30 days of stages, not every stage ever stored', () => {
    const start = (id: string, at: number) =>
      storeEvent(db(), {
        id,
        projectId: 'p1',
        event: {
          type: 'stage.start',
          name: 'security-review',
          at: new Date(at).toISOString(),
        },
        receivedAt: at,
      });
    const now = START + 90 * DAY;
    start('ancient', START);
    start('recent', now - 2 * DAY);

    expect(flagUnfinishedStages(db(), now)).toBe(1);
    expect(
      listEvents(db(), 'p1')
        .filter((event) => event.type === 'stage.unfinished')
        .map((event) => event.id)
    ).toEqual(['stage.unfinished:recent']);
  });

  it('keeps one id in two generations apart, and ignores a resend of either', () => {
    const at = new Date(START).toISOString();
    const store = (generation: number, name: string) =>
      storeEvent(db(), {
        id: 'rnr_3f9a:d9bc1c2275e8:0',
        generation,
        projectId: 'p1',
        event: { type: 'metric', name, value: 1, at },
        receivedAt: START,
      });

    expect(store(0, 'before')).toBe('stored');
    expect(store(1, 'after')).toBe('stored');
    expect(store(1, 'after')).toBe('duplicate');
    expect(store(0, 'before')).toBe('duplicate');
    expect(
      listEvents(db(), 'p1').map(({ id, generation, name }) => [
        id,
        generation,
        name,
      ])
    ).toEqual([
      ['rnr_3f9a:d9bc1c2275e8:0', 0, 'before'],
      ['rnr_3f9a:d9bc1c2275e8:0', 1, 'after'],
    ]);
  });

  it("flags an unfinished stage in each generation, the marker in the start's", () => {
    const at = new Date(START).toISOString();
    [0, 1].forEach((generation) =>
      storeEvent(db(), {
        id: 'rnr_3f9a:d9bc1c2275e8:0',
        generation,
        projectId: 'p1',
        event: { type: 'stage.start', name: 'security-review', at },
        receivedAt: START,
      })
    );

    expect(flagUnfinishedStages(db(), START + 2 * DAY)).toBe(2);
    expect(flagUnfinishedStages(db(), START + 3 * DAY)).toBe(0);
  });

  it("keeps a skipped stage's skipped and reason through the store to the timeline", () => {
    const at = new Date(START).toISOString();
    [
      {
        type: 'stage.end',
        name: 'visual-check',
        ticket: '5',
        skipped: true,
        reason: 'no design',
      },
      { type: 'stage.end', name: 'build', ticket: '5' },
    ].forEach((event, index) =>
      storeEvent(db(), {
        id: `s${index}`,
        projectId: 'p1',
        event: { ...event, at },
        receivedAt: START,
      })
    );

    const [skipped, ran] = listEvents(db(), 'p1').map(toTimelineEvent);

    expect(skipped).toMatchObject({
      name: 'visual-check',
      skipped: true,
      skipReason: 'no design',
    });
    expect(ran).toMatchObject({ name: 'build' });
    expect(ran).not.toHaveProperty('skipped');
    expect(ran).not.toHaveProperty('skipReason');
  });

  it("keeps a group event's group, reason and held, with no warning", () => {
    const at = new Date(START).toISOString();
    storeEvent(db(), {
      id: 'g1',
      projectId: 'p1',
      event: { type: 'group.add', groupId: 'g1', ticket: '3', at },
      receivedAt: START,
    });
    storeEvent(db(), {
      id: 'g2',
      projectId: 'p1',
      event: {
        type: 'group.reason',
        groupId: 'g1',
        reason: 'Ships when the epic completes, 1 left',
        at,
      },
      receivedAt: START,
    });
    storeEvent(db(), {
      id: 'g3',
      projectId: 'p1',
      event: { type: 'group.hold', groupId: 'g1', held: true, at },
      receivedAt: START,
    });

    expect(
      listEvents(db(), 'p1').map(
        ({ type, groupId, ticket, reason, held, warning }) => ({
          type,
          groupId,
          ticket,
          reason,
          held,
          warning,
        })
      )
    ).toEqual([
      {
        type: 'group.add',
        groupId: 'g1',
        ticket: '3',
        reason: null,
        held: null,
        warning: null,
      },
      {
        type: 'group.reason',
        groupId: 'g1',
        ticket: null,
        reason: 'Ships when the epic completes, 1 left',
        held: null,
        warning: null,
      },
      {
        type: 'group.hold',
        groupId: 'g1',
        ticket: null,
        reason: null,
        held: true,
        warning: null,
      },
    ]);
  });

  it('warns about a group event with no group, instead of dropping it unseen', () => {
    storeEvent(db(), {
      id: 'g1',
      projectId: 'p1',
      event: {
        type: 'group.hold',
        held: true,
        at: new Date(START).toISOString(),
      },
      receivedAt: START,
    });

    expect(listEvents(db(), 'p1').map(({ warning }) => warning)).toEqual([
      'group.hold has no groupId, so no group can show it.',
    ]);
  });
});
