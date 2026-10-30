import { caughtUpLine, launchItems } from '../shared/caughtUp';
import {
  canPause,
  computerRows,
  computersCounts,
} from '../shared/computersFooter';
import type { Lambda } from '../shared/lambdas';
import type { LambdaInfo, PodSummary } from '../shared/types';

/** Caught up, and the computers line: however many computers there are. */

const NOW = Date.parse('2026-10-26T12:00:00.000Z');

const buildingPod = (
  id: string,
  status: 'active' | 'paused',
  building: PodSummary['building']
): PodSummary => ({
  pod: {
    id,
    slug: id,
    title: id,
    createdAt: '2026-10-20T10:00:00.000Z',
    status,
    phase: 1,
    completedCheckpoints: [],
    worktreePath: `/tmp/${id}`,
    ownsWorktree: false,
    managerCwd: `/tmp/${id}`,
    devCwd: `/tmp/${id}`,
    agentCommand: 'claude',
    sessions: { manager: 'm', dev: 'd' },
    kind: 'building',
  },
  running: true,
  status: 'working',
  needsYou: 0,
  liveForks: [],
  chatHold: false,
  building,
});

const info: LambdaInfo = {
  owner: { name: 'Leslie Knope', initials: 'LK' },
  projects: [],
  lastProjectId: null,
  podProjects: {},
  podComputers: {
    'build-leslie': "Leslie's Mac",
    'build-ron': "Ron's iMac",
    'build-tom': "Tom's laptop",
  },
  waiting: [],
  computers: [
    { name: "Leslie's Mac", connected: true, lastSeenAt: NOW, projectIds: [] },
    { name: "Ron's iMac", connected: true, lastSeenAt: NOW, projectIds: [] },
    {
      name: "Tom's laptop",
      connected: false,
      lastSeenAt: NOW - 2 * 60 * 60_000,
      projectIds: [],
    },
    { name: "April's Mac", connected: true, lastSeenAt: NOW, projectIds: [] },
  ],
};

const pods: PodSummary[] = [
  buildingPod('build-leslie', 'active', {
    state: 'testing',
    current: { id: 'PAWNEE-3', title: 'Bench list', step: 'test', attempt: 1 },
    position: null,
    idleReason: null,
    runs: [
      {
        id: 'PAWNEE-3',
        title: 'Bench list',
        step: 'test',
        startedAt: '2026-10-26T11:48:00.000Z',
        shippedAt: null,
        blocked: null,
      },
    ],
    upNext: [],
  }),
  buildingPod('build-ron', 'paused', {
    state: 'paused',
    current: null,
    position: null,
    idleReason: null,
    runs: [],
    upNext: [
      { id: 'PAWNEE-8', title: 'Gazebo paint' },
      { id: 'PAWNEE-9', title: 'Lot 48 signage' },
    ],
  }),
  buildingPod('build-tom', 'active', {
    state: 'building',
    current: null,
    position: null,
    idleReason: null,
    runs: [],
    upNext: [],
  }),
];

const lambda = (extra: Partial<Lambda>): Lambda => ({
  key: 'ticket:parks/PAWNEE-9',
  title: 'Lot 48 signage',
  projectId: 'parks',
  planningPodId: null,
  ticketId: 'PAWNEE-9',
  tickets: [],
  phase: 'queued',
  needsYou: [],
  working: false,
  shippedAt: null,
  paused: false,
  ...extra,
});

describe('the computers line', () => {
  it('says each computer in a few words, a paused one with work waiting needing attention', () => {
    const rows = computerRows(info, pods, NOW);

    expect(rows.map((row) => [row.name, row.state, row.detail])).toEqual([
      ["Leslie's Mac", 'testing', 'Bench list · test · 12m'],
      ["Ron's iMac", 'paused', 'paused · 2 tickets waiting'],
      ["Tom's laptop", 'offline', 'offline 2h'],
      ["April's Mac", 'idle', 'not building'],
    ]);
    expect(rows.filter((row) => row.attention).map((row) => row.name)).toEqual([
      "Ron's iMac",
      "Tom's laptop",
    ]);
    expect(computersCounts(rows)).toEqual([
      { label: '1 building', tone: 'plain' },
      { label: '1 idle', tone: 'plain' },
      { label: '1 paused', tone: 'paused' },
      { label: '1 offline', tone: 'offline' },
    ]);
  });

  it('offers Pause on a computer whose building pod runs, not one paused, offline or without one', () => {
    const rows = computerRows(info, pods, NOW);

    expect(rows.map((row) => [row.name, canPause(row)])).toEqual([
      ["Leslie's Mac", true],
      ["Ron's iMac", false],
      ["Tom's laptop", false],
      ["April's Mac", false],
    ]);
  });
});

describe('all caught up', () => {
  it('says where things stand, leaving out the zeros', () => {
    expect(
      caughtUpLine([
        lambda({ phase: 'planning' }),
        lambda({ phase: 'building' }),
        lambda({ phase: 'qa' }),
        lambda({ phase: 'queued' }),
      ])
    ).toBe('1 planning · 2 building · 1 queued');
    expect(caughtUpLine([])).toBe('Nothing is in flight.');
  });

  it('offers only what they could do: plan, resume a paused computer, reassign an offline one', () => {
    const unplanned = lambda({});
    const strandedOnTom = lambda({
      key: 'ticket:parks/PAWNEE-10',
      planningPodId: 'plan-x',
      tickets: [
        {
          id: 'PAWNEE-10',
          title: 'Ticket',
          where: {
            kind: 'queued',
            place: 1,
            computer: "Tom's laptop",
            podId: 'build-tom',
            ahead: [],
          },
        },
      ],
    });

    expect(
      launchItems([unplanned, strandedOnTom], info, pods, NOW).map(
        (item) => item.kind
      )
    ).toEqual(['new', 'unplanned', 'paused', 'offline']);
    expect(launchItems([], info, pods, NOW)).toEqual([
      { kind: 'new' },
      {
        kind: 'paused',
        computer: "Ron's iMac",
        podId: 'build-ron',
        waiting: 2,
      },
    ]);
  });
});
