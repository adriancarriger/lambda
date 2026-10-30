import type { TicketPage, TimelineEvent } from '../shared/building';
import { shippingGroups } from '../shared/shippingGroups';
import { ticketJourney } from '../shared/ticketJourney';

/**
 * A ticket page's journey: planned → built Nm → checked → shipping together
 * → shipped. A ticket that shipped together with others keeps that step
 * once its group has shipped.
 */

const MINUTE = 60_000;
const T0 = Date.parse('2026-10-23T10:00:00.000Z');

const stage = (
  type: string,
  minute: number,
  name = 'build'
): TimelineEvent => ({
  type,
  name,
  ticket: '3',
  attempt: 1,
  pod: 'build-a1b2',
  result: null,
  at: T0 + minute * MINUTE,
});

const page = (status: 'building' | 'done'): TicketPage => ({
  projectId: 'pawnee',
  ticket: {
    id: '3',
    title: 'Trail closures',
    status,
    parent: null,
    labels: [],
    url: null,
    projectId: 'pawnee',
    source: 'markdown',
    description: "Hikers can't see which trails are closed.",
  },
  summary: { state: 'none' },
  plannedIn: null,
  verdict: 'COMPLETE',
  events: [stage('stage.start', 1), stage('stage.end', 13)],
});

const add = { type: 'group.add', groupId: 'g1', ticket: '3', at: T0 };

describe("a ticket's journey", () => {
  it('shows shipping together while its group is open', () => {
    expect(ticketJourney(page('building'), shippingGroups([add]))).toEqual([
      'planned',
      'built 12m',
      'checked',
      'shipping together',
    ]);
  });

  it('keeps shipping together once the group has shipped', () => {
    const shipped = shippingGroups([
      add,
      { type: 'group.shipped', groupId: 'g1', at: T0 + 30 * MINUTE },
    ]);

    expect(ticketJourney(page('done'), shipped)).toEqual([
      'planned',
      'built 12m',
      'checked',
      'shipping together',
      'shipped',
    ]);
  });

  it("isn't built while its build is still running", () => {
    const building = { ...page('building'), events: [stage('stage.start', 1)] };

    expect(ticketJourney(building, shippingGroups([]))).toEqual([
      'planned',
      'checked',
    ]);
  });

  it('is built once a later step started, though its build never reported its end', () => {
    const movedOn = {
      ...page('building'),
      events: [
        stage('stage.start', 1),
        stage('stage.start', 13, 'self-review'),
      ],
    };

    expect(ticketJourney(movedOn, shippingGroups([]))).toEqual([
      'planned',
      'built 12m',
      'checked',
    ]);
  });

  it('has no shipping together for a ticket that shipped alone', () => {
    expect(ticketJourney(page('done'), shippingGroups([]))).toEqual([
      'planned',
      'built 12m',
      'checked',
      'shipped',
    ]);
  });
});
