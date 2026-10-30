import type { Pod, Question } from '../../pod-store';
import type { RunView } from '../shared/building';
import {
  askRouteOf,
  lambdaOfTicket,
  lambdasOf,
  sidebarSections,
} from '../shared/lambdas';
import type { AppState, InboxEntry, PodSummary } from '../shared/types';

/** One Lambda across its whole life: planning, its tickets, their builds. */

const NOW = Date.parse('2026-10-26T12:00:00.000Z');

const pod = (id: string, extra: Partial<Pod> = {}): Pod => ({
  id,
  slug: id,
  title: id,
  createdAt: '2026-10-20T10:00:00.000Z',
  status: 'active',
  phase: 1,
  completedCheckpoints: [],
  worktreePath: `/tmp/${id}`,
  ownsWorktree: false,
  managerCwd: `/tmp/${id}`,
  devCwd: `/tmp/${id}`,
  agentCommand: 'claude',
  sessions: { manager: 'm', dev: 'd' },
  ...extra,
});

const summary = (
  podValue: Pod,
  extra: Partial<PodSummary> = {}
): PodSummary => ({
  pod: podValue,
  running: true,
  status: 'working',
  needsYou: 0,
  liveForks: [],
  chatHold: false,
  ...extra,
});

const run = (id: string, extra: Partial<RunView> = {}): RunView => ({
  id,
  title: `Ticket ${id}`,
  step: 'build',
  startedAt: '2026-10-26T11:00:00.000Z',
  shippedAt: null,
  blocked: null,
  ...extra,
});

const building = (
  id: string,
  runs: RunView[],
  upNext: Array<{ id: string; title: string }>
): PodSummary =>
  summary(pod(id, { kind: 'building' }), {
    building: {
      state: 'building',
      current: runs.some(
        (one) => one.shippedAt === null && one.blocked === null
      )
        ? { id: 'x', title: 'x', step: 'build', attempt: 1 }
        : null,
      position: null,
      idleReason: null,
      runs,
      upNext,
    },
  });

const checkpoint = (ids: string[]): Question => ({
  id: 'q3',
  podId: 'plan-parks',
  kind: 'checkpoint',
  phase: 3,
  status: 'answered',
  blocksCheckpoint: true,
  dependsOn: [],
  createdAt: '2026-10-21T10:00:00.000Z',
  options: [],
  checkpoint: {
    cp: 3,
    decisionIds: [],
    planTickets: ids.map((id) => ({
      id,
      title: `Ticket ${id}`,
      name: `Plain ${id}`,
    })),
  },
});

const entry = (key: string, extra: Partial<InboxEntry> = {}): InboxEntry => ({
  podId: 'build-leslie',
  kind: 'reply',
  key,
  ...extra,
});

const state = (extra: Partial<AppState> = {}): AppState => ({
  pods: [
    summary(
      pod('plan-parks', {
        status: 'done',
        epicId: 'PAWNEE-2',
        title: 'Parks site launch',
      })
    ),
    summary(pod('plan-dog'), { devBusy: true }),
    summary(pod('plan-chat', { status: 'done', title: 'A chat' })),
    building(
      'build-leslie',
      [
        run('PAWNEE-1', { shippedAt: '2026-10-26T10:00:00.000Z' }),
        run('PAWNEE-2a', { step: 'test' }),
      ],
      [
        { id: 'PAWNEE-2b', title: 'Ticket PAWNEE-2b' },
        { id: 'PAWNEE-4', title: 'Contact page' },
      ]
    ),
  ],
  inbox: [],
  questions: { 'plan-parks': [checkpoint(['PAWNEE-2a', 'PAWNEE-2b'])] },
  priority: ['plan-dog', 'plan-parks'],
  lambda: {
    owner: { name: 'Leslie Knope', initials: 'LK' },
    projects: [],
    lastProjectId: null,
    podProjects: { 'plan-parks': 'parks', 'build-leslie': 'parks' },
    podComputers: { 'build-leslie': "Leslie's MacBook Pro" },
    waiting: [],
  },
  ...extra,
});

describe('a Lambda across its whole life', () => {
  it("follows a plan's tickets into the build: building while one is, with each ticket's place", () => {
    const parks = lambdasOf(state()).find(
      (one) => one.key === 'pod:plan-parks'
    );

    expect(parks?.phase).toBe('building');
    expect(
      parks?.tickets.map((ticket) => [
        ticket.id,
        ticket.title,
        ticket.where.kind,
      ])
    ).toEqual([
      ['PAWNEE-2a', 'Plain PAWNEE-2a', 'building'],
      ['PAWNEE-2b', 'Plain PAWNEE-2b', 'queued'],
    ]);
    expect(parks?.tickets[1]?.where).toMatchObject({
      kind: 'queued',
      place: 2,
      computer: "Leslie's MacBook Pro",
    });
  });

  it('drops a ticket an ended pod put back, but keeps what it shipped', () => {
    const ended = building(
      'build-ann',
      [
        run('PAWNEE-7', { shippedAt: '2026-10-26T09:00:00.000Z' }),
        run('PAWNEE-2a', {
          step: 'pick-up',
          startedAt: '2026-10-26T11:30:00.000Z',
        }),
      ],
      [{ id: 'PAWNEE-9', title: 'Lot 48 signage' }]
    );
    const base = state();
    const lambdas = lambdasOf({
      ...base,
      pods: [
        ...base.pods.filter((one) => one.pod.id !== 'build-leslie'),
        { ...ended, pod: { ...ended.pod, status: 'done' } },
      ],
    });

    expect(
      lambdas.find((one) => one.key === 'pod:plan-parks')?.tickets[0]?.where
        .kind
    ).not.toBe('building');
    expect(
      lambdas
        .filter((one) => one.planningPodId === null)
        .map((one) => [one.ticketId, one.phase])
    ).toEqual([['PAWNEE-7', 'shipped']]);
  });

  it('gives a ticket made directly a Lambda of its own', () => {
    const lambdas = lambdasOf(state());

    expect(
      lambdas
        .filter((one) => one.planningPodId === null)
        .map((one) => [one.ticketId, one.phase])
    ).toEqual([
      ['PAWNEE-1', 'shipped'],
      ['PAWNEE-4', 'queued'],
    ]);
  });

  it('puts what waits on the owner in Needs you only, a build blocker first', () => {
    const blocked = state({
      inbox: [
        entry('build-leslie/reply/m1', {
          ticketId: 'PAWNEE-2a',
          tag: 'blocked',
        }),
      ],
    });
    const sections = sidebarSections(lambdasOf(blocked), blocked.inbox, NOW);

    expect(sections.needsYou.map((one) => one.key)).toEqual(['pod:plan-parks']);
    expect(sections.building).toEqual([]);
  });

  it('sorts the rest by phase: planning, queued, shipped for a day, and done', () => {
    const sections = sidebarSections(lambdasOf(state()), [], NOW);

    expect(sections.planning.map((one) => one.key)).toEqual(['pod:plan-dog']);
    expect(sections.planning[0]?.working).toBe(true);
    expect(sections.building.map((one) => one.key)).toEqual(['pod:plan-parks']);
    expect(sections.queued.map((one) => one.ticketId)).toEqual(['PAWNEE-4']);
    expect(sections.shipped.map((one) => one.ticketId)).toEqual(['PAWNEE-1']);
    expect(sections.done.map((one) => one.key)).toEqual(['pod:plan-chat']);
    expect(
      sidebarSections(lambdasOf(state()), [], NOW + 25 * 60 * 60_000).shipped
    ).toEqual([]);
  });

  it('reads as QA while a ticket of it waits on the owner’s review', () => {
    const review = state({
      inbox: [
        entry('build-leslie/reply/m2', {
          ticketId: 'PAWNEE-2a',
          tag: 'review',
        }),
      ],
    });

    expect(
      lambdasOf(review).find((one) => one.key === 'pod:plan-parks')?.phase
    ).toBe('qa');
  });
});

describe("a ticket's Lambda", () => {
  it("finds a ticket's Lambda through its epic, and none for a ticket nobody has", () => {
    const lambdas = lambdasOf(state());

    expect(lambdaOfTicket(lambdas, 'parks', 'PAWNEE-2b')?.key).toBe(
      'pod:plan-parks'
    );
    expect(lambdaOfTicket(lambdas, 'parks', 'PAWNEE-2')?.key).toBe(
      'pod:plan-parks'
    );
    expect(lambdaOfTicket(lambdas, 'parks', 'PAWNEE-99')).toBeUndefined();
  });

  it('sends an ask to the block it waits on, the planning chat while planning, else Lambda', () => {
    const blocked = state({
      inbox: [
        entry('build-leslie/reply/m1', {
          ticketId: 'PAWNEE-2a',
          tag: 'blocked',
          messageId: 'm1',
        }),
      ],
    });
    const lambdas = lambdasOf(blocked);

    expect(
      askRouteOf(lambdaOfTicket(lambdas, 'parks', 'PAWNEE-2a'), 'PAWNEE-2a')
    ).toEqual({ to: 'block', podId: 'build-leslie', messageId: 'm1' });
    expect(
      askRouteOf(lambdaOfTicket(lambdas, 'parks', 'PAWNEE-2b'), 'PAWNEE-2b')
    ).toEqual({ to: 'lambda' });

    const planning = lambdasOf(state()).find(
      (one) => one.key === 'pod:plan-dog'
    );

    expect(askRouteOf(planning, 'PAWNEE-30')).toEqual({
      to: 'planning',
      podId: 'plan-dog',
    });
    expect(askRouteOf(undefined, 'PAWNEE-30')).toEqual({ to: 'lambda' });
  });

  it('gives an ask about a ticket no row of its own, until a reply waits on the owner', () => {
    const talk = summary(
      pod('talk-ab12', { kind: 'building', talk: { ticketId: 'PAWNEE-30' } })
    );
    const quiet = state({ pods: [...state().pods, talk] });

    expect(lambdasOf(quiet).some((one) => one.ticketId === 'PAWNEE-30')).toBe(
      false
    );

    const asked = {
      ...quiet,
      inbox: [entry('talk-ab12/reply/m9', { podId: 'talk-ab12' })],
    };
    const sections = sidebarSections(lambdasOf(asked), asked.inbox, NOW);

    expect(sections.needsYou.map((one) => one.ticketId)).toEqual(['PAWNEE-30']);
  });
});
