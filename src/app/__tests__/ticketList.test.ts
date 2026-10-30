import type { TicketListItem } from '../shared/building';
import { type GroupEvent } from '../shared/shippingGroups';
import {
  type BoardOptions,
  type FilterChip,
  boardGroups,
} from '../shared/ticketBoard';
import {
  linkOf,
  openGroupKeys,
  openGroupKeysByProject,
  sourceLabel,
  talkToSend,
} from '../shared/ticketList';

/** The board by status, as the Tickets screen opens. */
const listTickets = (
  items: TicketListItem[],
  shippingTogether: Set<string>,
  options: Partial<BoardOptions> = {}
) =>
  boardGroups(items, {
    groupBy: 'status',
    chips: [],
    search: '',
    shippingTogether,
    projectName: (projectId) => projectId,
    ...options,
  }).map((group) => ({
    name: group.label,
    tickets: group.rows.map((row) => row.item),
  }));

const chip = (field: FilterChip['field'], value: string): FilterChip => ({
  field,
  value,
});

const ticket = (
  id: string,
  title: string,
  status: TicketListItem['status'],
  extra: Partial<TicketListItem> = {}
): TicketListItem => ({
  id,
  title,
  status,
  parent: null,
  labels: [],
  url: null,
  projectId: 'pawnee',
  source: 'markdown',
  ...extra,
});

/** Eight tickets: one Linear, one Jira, the rest markdown. */
const EIGHT: TicketListItem[] = [
  ticket('3', 'Trail closures', 'building', { parent: 'E1' }),
  ticket('2', 'Ramsett Park map', 'ready', { parent: 'E1' }),
  ticket('5', 'Lot 48 photos', 'ready', {
    source: 'linear',
    url: 'https://linear.app/pawnee/issue/PAW-5',
  }),
  ticket('6', 'Harvest festival banner', 'ready', {
    source: 'jira',
    url: 'https://pawnee.atlassian.net/browse/PAW-6',
  }),
  ticket('7', 'Pit cleanup', 'planning'),
  ticket('8', 'Gazebo paint', 'blocked'),
  ticket('1', 'Park hours page', 'done', { projectId: 'bakery' }),
  ticket('9', 'Old mural', 'canceled'),
];

/** One pod-made entry with the same id as one of the eight. */
const POD_MADE = ticket('7', 'Pit cleanup', 'planning', {
  source: 'pod',
  podId: 'pit-a1b2',
});

const G1: GroupEvent[] = [
  { type: 'group.add', groupId: 'g1', ticket: '2', at: 1 },
];

const groupsOf = (chips: FilterChip[] = []) =>
  listTickets([...EIGHT, POD_MADE], openGroupKeys(G1, 'pawnee'), {
    chips,
  }).map((group) => [group.name, group.tickets.length]);

describe('All tickets', () => {
  it('groups by where each ticket is, as Linear orders them, Canceled hidden', () => {
    expect(groupsOf()).toEqual([
      ['Building', 1],
      ['Shipping together', 1],
      ['Ready', 2],
      ['Blocked', 1],
      ['Planning', 1],
      ['Shipped', 1],
    ]);
  });

  it('lists a pod-made ticket the source also has once', () => {
    const planning = listTickets(
      [...EIGHT, POD_MADE],
      openGroupKeys(G1, 'pawnee')
    ).find((group) => group.name === 'Planning');

    expect(planning?.tickets.map((one) => [one.id, one.source])).toEqual([
      ['7', 'markdown'],
    ]);
  });

  it('carries Linear and Jira tickets’ source addresses, and none for markdown', () => {
    const listed = listTickets(
      [...EIGHT, POD_MADE],
      openGroupKeys(G1, 'pawnee')
    ).flatMap((group) => group.tickets);
    const urlOf = (id: string) => listed.find((one) => one.id === id)?.url;

    expect(urlOf('5')).toBe('https://linear.app/pawnee/issue/PAW-5');
    expect(urlOf('6')).toBe('https://pawnee.atlassian.net/browse/PAW-6');
    expect(urlOf('3')).toBeNull();
  });

  it('names a link out by its own source, and no other', () => {
    expect(sourceLabel('linear')).toBe('Linear');
    expect(sourceLabel('jira')).toBe('Jira');
    expect(sourceLabel('markdown')).toBeNull();
    expect(sourceLabel('pod')).toBeNull();
  });

  it('links a ticket out only to an http or https address', () => {
    expect(linkOf('https://linear.app/pawnee/issue/PAWNEE-5')).toBe(
      'https://linear.app/pawnee/issue/PAWNEE-5'
    );
    expect(linkOf('javascript:alert(1)')).toBeNull();
    expect(linkOf('not a url')).toBeNull();
    expect(linkOf(null)).toBeNull();
  });

  it('shows Canceled tickets in their own group when the Status filter picks it', () => {
    expect(groupsOf([chip('status', 'canceled')])).toEqual([['Canceled', 1]]);
  });

  it('searches titles, ignoring case', () => {
    expect(
      listTickets(EIGHT, new Set(), { search: 'CLOSU' }).flatMap((group) =>
        group.tickets.map((one) => one.title)
      )
    ).toEqual(['Trail closures']);
  });

  it('filters by epic and by codebase', () => {
    const ids = (chips: FilterChip[]) =>
      listTickets(EIGHT, new Set(), { chips }).flatMap((group) =>
        group.tickets.map((one) => one.id)
      );

    expect(ids([chip('epic', 'E1')])).toEqual(['3', '2']);
    expect(ids([chip('codebase', 'bakery')])).toEqual(['1']);
  });

  it('keeps a ticket in a shipped group out of Shipping together', () => {
    const shipped: GroupEvent[] = [
      ...G1,
      { type: 'group.shipped', groupId: 'g1', at: 2 },
    ];

    expect(
      listTickets(EIGHT, openGroupKeys(shipped, 'pawnee')).find(
        (group) => group.name === 'Shipping together'
      )
    ).toBeUndefined();
  });
});

describe('Shipping together across projects', () => {
  // Two projects each have a ticket "3" and a group "g1".
  const events = [
    {
      type: 'group.add',
      groupId: 'g1',
      ticket: '3',
      at: 1,
      projectId: 'pawnee',
    },
    {
      type: 'group.add',
      groupId: 'g1',
      ticket: '4',
      at: 1,
      projectId: 'bakery',
    },
    { type: 'group.shipped', groupId: 'g1', at: 2, projectId: 'bakery' },
  ];
  const tickets = [
    ticket('3', 'Trail closures', 'building'),
    ticket('3', 'Croissant menu', 'building', { projectId: 'bakery' }),
  ];

  it("keeps one project's group to that project's tickets", () => {
    const groups = listTickets(tickets, openGroupKeysByProject(events));
    const titlesIn = (name: string) =>
      groups
        .find((group) => group.name === name)
        ?.tickets.map((one) => one.title) ?? [];

    // Bakery's g1 shipping doesn't close Pawnee's g1, and Pawnee's "3"
    // doesn't pull Bakery's "3" in with it.
    expect(titlesIn('Shipping together')).toEqual(['Trail closures']);
    expect(titlesIn('Building')).toEqual(['Croissant menu']);
  });
});

describe('Talk about this ticket', () => {
  it('sends the trimmed text once: nothing while a send is in flight', () => {
    expect(talkToSend('  move the pin  ', false)).toBe('move the pin');
    expect(talkToSend('move the pin', true)).toBeNull();
    expect(talkToSend('   ', false)).toBeNull();
  });
});
