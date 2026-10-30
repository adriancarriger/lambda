import { formatMinutes, stepDisplayName } from '../shared/buildTimeline';
import type { TicketListItem } from '../shared/building';
import { sidebarBuildingLine } from '../shared/building';
import {
  type BoardOptions,
  PICKABLE_STATUSES,
  STATUSES,
  boardGroups,
  computerChoices,
  matchesChips,
  realChanges,
  ticketActivity,
  visibleRows,
} from '../shared/ticketBoard';

/** The Tickets screen's list as Linear lays it out, and a ticket's Activity. */

const ticket = (
  id: string,
  extra: Partial<TicketListItem> = {}
): TicketListItem => ({
  id,
  title: `Ticket ${id}`,
  status: 'ready',
  parent: null,
  labels: [],
  url: null,
  projectId: 'parks',
  source: 'markdown',
  ...extra,
});

const options = (extra: Partial<BoardOptions> = {}): BoardOptions => ({
  groupBy: 'status',
  chips: [],
  search: '',
  shippingTogether: new Set(),
  projectName: (projectId) =>
    ({ parks: 'Pawnee site', bakery: 'Bakery' }[projectId] ?? projectId),
  ...extra,
});

const TICKETS = [
  ticket('PAWNEE-10', { title: 'Parks site launch', status: 'planning' }),
  ticket('PAWNEE-2', {
    parent: 'PAWNEE-10',
    status: 'building',
    priority: 'high',
    assignee: "Leslie's MacBook Pro",
  }),
  ticket('PAWNEE-5', { parent: 'PAWNEE-10', status: 'planning' }),
  ticket('PAWNEE-1', { parent: 'PAWNEE-10', status: 'done' }),
  ticket('PAWNEE-3', {
    priority: 'urgent',
    assignee: "Ann's Mac mini",
    labels: ['site'],
  }),
  ticket('PAWNEE-7', { labels: ['bug'] }),
  ticket('PAWNEE-9', { status: 'canceled' }),
];

describe('the status table', () => {
  it('names every status once, and lets a person pick only what the build never sets', () => {
    expect(STATUSES.done.name).toBe('Shipped');
    expect(PICKABLE_STATUSES).toEqual([
      'inbox',
      'planning',
      'ready',
      'blocked',
      'canceled',
    ]);
  });
});

describe('the list', () => {
  it('lists an epic’s tickets under it in the same group, with its progress', () => {
    const planning = boardGroups(TICKETS, options()).find(
      (group) => group.status === 'planning'
    );

    expect(
      planning?.rows.map((row) => [row.item.id, row.depth, row.progress])
    ).toEqual([
      ['PAWNEE-10', 0, { done: 1, total: 3 }],
      ['PAWNEE-5', 1, null],
    ]);
  });

  it('ands filters on different fields and ors chips on one field', () => {
    const ids = (chips: BoardOptions['chips']) =>
      TICKETS.filter((item) => matchesChips(item, chips, '')).map(
        (item) => item.id
      );

    expect(
      ids([
        { field: 'priority', value: 'urgent' },
        { field: 'priority', value: 'high' },
      ])
    ).toEqual(['PAWNEE-2', 'PAWNEE-3']);
    expect(
      ids([
        { field: 'priority', value: 'urgent' },
        { field: 'label', value: 'bug' },
      ])
    ).toEqual([]);
    expect(ids([{ field: 'assignee', value: '' }])).toEqual([
      'PAWNEE-10',
      'PAWNEE-5',
      'PAWNEE-1',
      'PAWNEE-7',
    ]);
  });

  it('groups by computer, Unassigned last', () => {
    expect(
      boardGroups(TICKETS, options({ groupBy: 'assignee' })).map((group) => [
        group.label,
        group.rows.length,
      ])
    ).toEqual([
      ["Ann's Mac mini", 1],
      ["Leslie's MacBook Pro", 1],
      ['Unassigned', 4],
    ]);
  });

  it('groups by epic, the epic itself in its own group, No epic last', () => {
    expect(
      boardGroups(TICKETS, options({ groupBy: 'epic' })).map((group) => [
        group.label,
        group.rows.map((row) => row.item.id),
      ])
    ).toEqual([
      ['Parks site launch', ['PAWNEE-10', 'PAWNEE-2', 'PAWNEE-5', 'PAWNEE-1']],
      ['No epic', ['PAWNEE-3', 'PAWNEE-7']],
    ]);
  });

  it('leaves a folded group’s rows out of j and k', () => {
    const groups = boardGroups(TICKETS, options());

    expect(
      visibleRows(groups, new Set(['Ready', 'Planning'])).map(
        (row) => row.item.id
      )
    ).toEqual(['PAWNEE-2', 'PAWNEE-1']);
  });
});

describe("a ticket's Activity", () => {
  const T = Date.parse('2026-10-26T10:00:00.000Z');
  const min = 60_000;

  it('reads edits in words, then the build: picked up, its steps, shipped', () => {
    const entries = ticketActivity(
      [
        {
          type: 'ticket.create',
          name: 'created',
          result: null,
          at: T,
          note: 'Park map',
          source: 'Leslie',
        },
        {
          type: 'ticket.edit',
          name: 'priority',
          result: null,
          at: T + min,
          note: 'high',
          source: 'Leslie',
        },
        {
          type: 'ticket.edit',
          name: 'assignee',
          result: null,
          at: T + 2 * min,
          note: "Leslie's MacBook Pro",
          source: 'Leslie',
        },
        { type: 'stage.start', name: 'pick-up', result: null, at: T + 3 * min },
        { type: 'stage.end', name: 'pick-up', result: 'pass', at: T + 3 * min },
        { type: 'stage.start', name: 'build', result: null, at: T + 4 * min },
        { type: 'stage.end', name: 'build', result: 'pass', at: T + 13 * min },
        {
          type: 'stage.end',
          name: 'visual-check',
          result: null,
          at: T + 13 * min,
          skipped: true,
        },
        { type: 'stage.start', name: 'test', result: null, at: T + 14 * min },
      ],
      stepDisplayName,
      formatMinutes
    );

    expect(entries.map((entry) => `${entry.who} ${entry.text}`)).toEqual([
      'Leslie created it',
      'Leslie set priority to High',
      "Leslie assigned it to Leslie's MacBook Pro",
      'Lambda picked it up',
      'Lambda Build ✓ 9m · Test now',
    ]);
  });

  it('says when it shipped, and reads an unassign and a move out of the epic', () => {
    const entries = ticketActivity(
      [
        {
          type: 'ticket.edit',
          name: 'assignee',
          result: null,
          at: T,
          note: '',
          source: 'Leslie',
        },
        {
          type: 'ticket.edit',
          name: 'parent',
          result: null,
          at: T + 1,
          note: '',
          source: 'Leslie',
        },
        { type: 'stage.end', name: 'ship', result: 'pass', at: T + 2 },
      ],
      stepDisplayName,
      formatMinutes
    );

    expect(entries.map((entry) => entry.text)).toEqual([
      'unassigned it',
      'took it out of its epic',
      'picked it up',
      'Ship ✓',
      'shipped it',
    ]);
  });
});

describe('the computers a ticket can go to', () => {
  it('lists those with the project first, each with what it is doing', () => {
    expect(
      computerChoices(
        [
          { name: "Tom's laptop", connected: false, projectIds: ['parks'] },
          { name: "Ann's Mac mini", connected: true, projectIds: ['parks'] },
          { name: 'Bakery iMac', connected: true, projectIds: ['bakery'] },
          {
            name: "Leslie's MacBook Pro",
            connected: true,
            projectIds: ['parks'],
          },
        ],
        [{ computer: "Leslie's MacBook Pro", state: 'testing' }],
        'parks'
      ).map((one) => [one.name, one.state, one.hasProject])
    ).toEqual([
      ["Ann's Mac mini", 'idle', true],
      ["Leslie's MacBook Pro", 'testing', true],
      ["Tom's laptop", 'offline', true],
      ['Bakery iMac', 'idle', false],
    ]);
  });
});

describe('the sidebar’s building line', () => {
  const now = Date.parse('2026-10-26T10:04:00.000Z');
  const base = {
    current: null,
    position: null,
    idleReason: 'Nothing ready to build',
    lastShipped: null,
  };

  it('names the ticket while on one, and the last ship while idle', () => {
    expect(
      sidebarBuildingLine(
        {
          ...base,
          state: 'testing',
          current: {
            id: 'PAWNEE-2',
            title: 'Park map',
            step: 'test',
            attempt: 1,
          },
        },
        now
      )
    ).toBe('testing · PAWNEE-2');
    expect(
      sidebarBuildingLine(
        {
          ...base,
          state: 'idle',
          lastShipped: { id: 'PAWNEE-1', at: '2026-10-26T10:00:00.000Z' },
        },
        now
      )
    ).toBe('idle · shipped PAWNEE-1 4m ago');
    expect(sidebarBuildingLine({ ...base, state: 'paused' }, now)).toBe(
      'paused'
    );
    expect(sidebarBuildingLine({ ...base, state: 'idle' }, now)).toBe(
      'idle · Nothing ready to build'
    );
  });
});

describe('what a change really changes', () => {
  it('sends only what differs, and nothing for a pick of the same value', () => {
    const item = ticket('PAWNEE-3', {
      priority: 'urgent',
      assignee: "Ann's Mac mini",
      labels: ['site'],
    });

    expect(
      realChanges(item, 'Old words.', {
        priority: 'urgent',
        assignee: "Ann's Mac mini",
        labels: ['site'],
        status: 'ready',
        description: 'Old words.',
      })
    ).toBeNull();
    expect(
      realChanges(item, 'Old words.', {
        priority: 'low',
        labels: ['site', 'bug'],
        removeLabels: ['nope'],
      })
    ).toEqual({ priority: 'low', labels: ['bug'] });
  });
});
