import type {
  BuildingState,
  Pod,
  Screenshot,
  ThreadMessage,
} from '../../pod-store';
import {
  buildingRefreshIn,
  buildingReplyItems,
  buildingScreenMode,
  pauseHeld,
  railPlaceholder,
  runShots,
} from '../shared/building';
import { buildingChat } from '../shared/conversation';
import { ticketsRefreshDue } from '../shared/ticketList';

/**
 * A building pod's page: which chat lines it shows, whether it is a full
 * building pod or a one-ticket talk, and how often it and the Tickets screen
 * ask again.
 */

const message = (
  id: string,
  from: ThreadMessage['from'],
  extra: Partial<ThreadMessage> = {}
): ThreadMessage => ({
  id,
  podId: 'build-a1b2',
  from,
  mode: 'note',
  text: `message ${id}`,
  createdAt: '2026-10-23T10:00:00.000Z',
  delivery: 'delivered',
  ...extra,
});

describe("a building pod's chat", () => {
  it("leaves out the Product manager's relay to the Engineering manager", () => {
    const thread = [
      message('m1', 'human', { target: 'product-manager' }),
      message('m2', 'product-manager', { target: 'engineering-manager' }),
      message('m3', 'engineering-manager'),
      message('m4', 'product-manager'),
    ];

    expect(buildingChat(thread).map((one) => one.id)).toEqual([
      'm1',
      'm3',
      'm4',
    ]);
  });

  it('leaves out system notes and empty lines', () => {
    const thread = [
      message('m1', 'system'),
      message('m2', 'engineering-manager', { text: '  ' }),
    ];

    expect(buildingChat(thread)).toEqual([]);
  });
});

describe("a building pod's page", () => {
  const pod = (extra: Partial<Pod>): Pick<Pod, 'kind' | 'talk'> => ({
    kind: 'building',
    ...extra,
  });

  it('is a full building pod, or a one-ticket talk with no building rails', () => {
    expect(buildingScreenMode(pod({}))).toBe('building');
    expect(buildingScreenMode(pod({ talk: { ticketId: '3' } }))).toBe('talk');
  });

  it("isn't a building page for a planning pod", () => {
    expect(buildingScreenMode(pod({ kind: 'planning' }))).toBeNull();
    expect(buildingScreenMode({})).toBeNull();
  });
});

describe('the Tickets screen asks the sources again', () => {
  const now = 1_000_000_000;

  it('on its first load', () => {
    expect(ticketsRefreshDue(null, now)).toBe(true);
  });

  it('not on every event tick', () => {
    expect(ticketsRefreshDue(now - 5_000, now)).toBe(false);
  });

  it('once a minute has passed', () => {
    expect(ticketsRefreshDue(now - 59_999, now)).toBe(false);
    expect(ticketsRefreshDue(now - 60_000, now)).toBe(true);
  });

  it('every 5 seconds while a summary is being written, not on every tick', () => {
    expect(ticketsRefreshDue(now - 1_000, now, true)).toBe(false);
    expect(ticketsRefreshDue(now - 5_000, now, true)).toBe(true);
  });
});

describe("a building pod's page asks its computer again", () => {
  const now = 1_000_000_000;

  it('at once on its first load', () => {
    expect(buildingRefreshIn(null, now)).toBe(0);
  });

  it('at once when the last read is 5 seconds old', () => {
    expect(buildingRefreshIn(now - 5_000, now)).toBe(0);
    expect(buildingRefreshIn(now - 60_000, now)).toBe(0);
  });

  it('not on every event tick, but once the 5 seconds are up', () => {
    expect(buildingRefreshIn(now - 1_000, now)).toBe(4_000);
    expect(buildingRefreshIn(now, now)).toBe(5_000);
  });
});

describe("a building pod's rails before its first answer", () => {
  it('say Loading… while it loads, and why when the load failed', () => {
    expect(railPlaceholder(null)).toBe('Loading…');
    expect(railPlaceholder("Leslie's Mac is offline.")).toBe(
      "Couldn't load this pod: Leslie's Mac is offline."
    );
  });
});

describe("a building pod's page shows the items waiting on the owner", () => {
  const blocked = (id: string, messageId: string) => ({
    id,
    title: `Ticket ${id}`,
    step: 'test',
    attempt: 1,
    startedAt: '2026-10-23T09:00:00.000Z',
    blocked: {
      at: '2026-10-23T10:00:00.000Z',
      what: 'w',
      problem: 'p',
      options: 'o',
      recommendation: 'r',
      messageId,
    },
  });
  const state = (extra: Partial<BuildingState> = {}): BuildingState => ({
    runs: [blocked('5', 'm1'), blocked('6', 'm2')],
    upNext: [],
    ...extra,
  });
  const thread = [
    message('m1', 'engineering-manager', { expectsReply: true }),
    message('m2', 'engineering-manager', { expectsReply: true }),
    message('m3', 'engineering-manager'),
  ];

  it('lists each Blocked item still waiting, oldest first', () => {
    expect(buildingReplyItems(thread, state()).map((one) => one.id)).toEqual([
      'm1',
      'm2',
    ]);
  });

  it('leaves out one whose ticket is back in the queue', () => {
    expect(
      buildingReplyItems(
        thread,
        state({ upNext: [{ id: '5', title: 'Ticket 5' }] })
      ).map((one) => one.id)
    ).toEqual(['m2']);
  });

  it('leaves out one answered on that item, but not one asked of the Product manager', () => {
    const answered = [
      ...thread,
      message('m4', 'human', { about: 'm1' }),
      message('m5', 'human', { target: 'product-manager' }),
    ];

    expect(buildingReplyItems(answered, state()).map((one) => one.id)).toEqual([
      'm2',
    ]);
  });
});

describe("a run's test screenshots", () => {
  const shot = (file: string, at: string): Screenshot => ({
    file,
    ticketId: '3',
    attempt: 1,
    url: 'http://localhost:3000/parks/ramsett',
    consoleErrors: [],
    conclusion: 'The trail markers show.',
    passed: true,
    at,
  });

  it("leaves out an earlier run's shots of the same ticket and attempt", () => {
    const screenshots = {
      '3/1': [
        shot('before.png', '2026-10-21T09:00:00.000Z'),
        shot('now.png', '2026-10-23T10:30:00.000Z'),
      ],
    };

    expect(
      runShots(
        screenshots,
        { id: '3', startedAt: '2026-10-23T10:00:00.000Z' },
        1
      ).map((one) => one.file)
    ).toEqual(['now.png']);
  });
});

describe("a building pod's Pause button", () => {
  it('stays held after its request settles, until the pod is paused', () => {
    // Clicked while active; the request has settled, no new state yet.
    expect(pauseHeld('active', 'active')).toBe(true);
    // The state push says paused: Resume can be clicked.
    expect(pauseHeld('active', 'paused')).toBe(false);
  });

  it('is free when nothing was clicked, or the click failed', () => {
    expect(pauseHeld(null, 'active')).toBe(false);
  });
});
