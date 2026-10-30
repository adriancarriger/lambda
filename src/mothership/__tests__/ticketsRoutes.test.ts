import { required } from '../../__tests__/required';
import * as buildTimeline from '../../app/shared/buildTimeline';
import type { TicketListItem } from '../../app/shared/building';
import { storeEvent } from '../../events/store';
import type { Message } from '../../protocol';
import {
  BUILD_TIMEOUT_MS,
  RESUME_ALL_TIMEOUT_MS,
  STOP_TIMEOUT_MS,
  TALK_TIMEOUT_MS,
} from '../../runner/budgets';
import { openTicketSource } from '../../tickets/context';
import { storeSnapshots } from '../pods';
import {
  BUILDING_START_TIMEOUT_MS,
  TICKETS_LIST_TIMEOUT_MS,
  TICKET_TALK_TIMEOUT_MS,
} from '../ticketRoutes';
import {
  type FakeRunner,
  type Harness,
  connectRunner,
  holdProject,
  podSnapshot,
  startHarness,
} from './harness';

// Wrapped, so a call from the mothership would be counted: it must be none.
jest.mock('../../tickets/context', () => {
  const actual: typeof import('../../tickets/context') = jest.requireActual(
    '../../tickets/context'
  );

  return { ...actual, openTicketSource: jest.fn(actual.openTicketSource) };
});

/**
 * The Tickets screen and building pods. The mothership never reads a ticket
 * source: lists, full tickets and summaries come from the runner holding the
 * project, so tracker keys never leave it.
 */

const PARKS = '/home/leslie/pawnee-parks';
const BAKERY = '/home/leslie/bakery';

const ticket = (
  id: string,
  title: string,
  projectId: string
): TicketListItem => ({
  id,
  title,
  status: 'ready',
  parent: null,
  labels: [],
  url: null,
  projectId,
  source: 'markdown',
});

/** Event-loop turns (setImmediate is left real under fake timers). */
const turns = async (count: number): Promise<void> => {
  if (count > 0) {
    await new Promise((resolve) => setImmediate(resolve));
    await turns(count - 1);
  }
};

/** Real I/O under fake timers: a bounded number of turns, then a failure. */
const turnsUntil = async (check: () => boolean, left = 5000): Promise<void> => {
  if (check()) {
    return;
  }

  if (left === 0) {
    throw new Error('Timed out waiting for a condition.');
  }

  await turns(1);
  await turnsUntil(check, left - 1);
};

describe('the Tickets screen routes', () => {
  const fixture: {
    harness?: Harness;
    laptop?: FakeRunner;
    mini?: FakeRunner;
    parks?: string;
    bakery?: string;
    cookie?: string;
  } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');
  const laptop = (): FakeRunner => required(fixture.laptop, 'laptop');
  const mini = (): FakeRunner => required(fixture.mini, 'mini');
  const parks = (): string => required(fixture.parks, 'parks');
  const bakery = (): string => required(fixture.bakery, 'bakery');
  const asked: { messages: Message[] } = { messages: [] };

  const answer = (runner: FakeRunner, projectFolder: string) => {
    const note = (message: Message) => {
      asked.messages = [...asked.messages, message];
    };
    runner.on('tickets-list', (message) => {
      note(message);

      return {
        tickets:
          projectFolder === PARKS
            ? [ticket('3', 'Trail markers', String(message.projectId))]
            : [ticket('9', 'Cupcake menu', String(message.projectId))],
      };
    });
    runner.on('ticket-get', (message) => {
      note(message);

      return {
        projectId: String(message.projectId),
        ticket: {
          ...ticket(String(message.ticketId), 'Trail markers', parks()),
          description: 'Each park page shows trail markers.',
        },
        summary: { state: 'writing' },
        plannedIn: null,
        verdict: null,
      };
    });
    runner.on('ticket-talk', (message) => {
      note(message);

      return { podId: 'build-1', target: 'product-manager' };
    });
    runner.on('building-start', (message) => {
      note(message);

      return 'build-1';
    });
    runner.on('ticket-update', (message) => {
      note(message);

      return {
        ...ticket(String(message.ticketId), 'Trail markers', parks()),
        priority: 'high',
      };
    });
    runner.on('ticket-create', (message) => {
      note(message);

      return ticket('4', 'Harvest festival', String(message.projectId));
    });
    runner.on('ticket-move', (message) => {
      note(message);

      return null;
    });
    runner.on('pod-action', (message) => {
      note(message);

      return {
        pod: { id: message.podId },
        windows: ['dev'],
        // The pod has taken ticket 3 only.
        building: {
          runs: [
            {
              id: '3',
              title: 'Trail markers',
              step: 'test',
              attempt: 2,
              startedAt: '2026-10-21T11:00:00.000Z',
            },
          ],
          upNext: [{ id: '4', title: 'Lot 48 photos' }],
        },
      };
    });
  };

  beforeEach(async () => {
    asked.messages = [];
    jest.mocked(openTicketSource).mockClear();
    fixture.harness = await startHarness();
    fixture.laptop = await connectRunner(harness(), {
      name: "Leslie's MacBook",
    });
    fixture.mini = await connectRunner(harness(), {
      name: "Leslie's Mac mini",
    });
    await laptop().next('owner');
    await mini().next('owner');
    fixture.parks = holdProject(harness(), laptop().runnerId, {
      name: 'Pawnee Parks app',
      folder: PARKS,
    });
    fixture.bakery = holdProject(harness(), mini().runnerId, {
      name: 'Bakery site',
      folder: BAKERY,
    });
    storeSnapshots(
      harness().db,
      laptop().runnerId,
      PARKS,
      [podSnapshot('build-1')],
      [],
      harness().clock.now
    );
    answer(laptop(), PARKS);
    answer(mini(), BAKERY);
    fixture.cookie = harness().signIn();
  });

  afterEach(async () => {
    await laptop().close();
    await mini().close();
    await harness().close();
  });

  const get = (urlPath: string) =>
    harness().request('GET', urlPath, {
      cookie: required(fixture.cookie, 'cookie'),
    });

  const post = (urlPath: string, body: unknown) =>
    harness().request('POST', urlPath, {
      cookie: required(fixture.cookie, 'cookie'),
      body: JSON.stringify(body),
    });

  it("asks each project's own runner for its tickets, reading no source itself", async () => {
    const response = await get('/api/tickets');
    const body = response.json<{
      projects: { projectId: string; tickets?: TicketListItem[] }[];
    }>();

    expect(response.status).toBe(200);
    expect(
      body.projects.map(({ projectId, tickets }) => [
        projectId,
        (tickets ?? []).map(({ title }) => title),
      ])
    ).toEqual(
      expect.arrayContaining([
        [parks(), ['Trail markers']],
        [bakery(), ['Cupcake menu']],
      ])
    );
    expect(
      asked.messages
        .filter((message) => message.type === 'tickets-list')
        .map((message) => [message.folder, message.projectId])
        .sort()
    ).toEqual(
      [
        [PARKS, parks()],
        [BAKERY, bakery()],
      ].sort()
    );
    expect(openTicketSource).not.toHaveBeenCalled();
  });

  it("says a project's computer is offline, with none of its tickets", async () => {
    await mini().close();
    const body = (await get('/api/tickets')).json<{
      projects: {
        projectId: string;
        tickets?: TicketListItem[];
        offline?: string;
      }[];
    }>();
    const entry = body.projects.find(
      (project) => project.projectId === bakery()
    );

    expect(entry).toEqual({
      projectId: bakery(),
      name: 'Bakery site',
      offline: "Leslie's Mac mini is offline.",
    });
  });

  it("says a computer's answer it can't read, rather than listing no tickets", async () => {
    mini().on('tickets-list', () => ({ error: 'Unknown request' }));
    const body = (await get('/api/tickets')).json<{
      projects: {
        projectId: string;
        tickets?: TicketListItem[];
        offline?: string;
      }[];
    }>();

    // Only an HttpError's words are for the app: the mothership's own
    // failure is a plain line there, and kept in the log.
    expect(
      body.projects.find((project) => project.projectId === bakery())
    ).toEqual({
      projectId: bakery(),
      name: 'Bakery site',
      offline: "Couldn't read this codebase's tickets.",
    });
    expect(harness().logs).toEqual([
      expect.stringContaining(
        'Unexpected answer from the computer to tickets-list.'
      ),
    ]);
  });

  it("passes on the words of a computer's refusal to list its tickets", async () => {
    mini().on('tickets-list', () => {
      throw new Error('The Bakery site tracker refused the key.');
    });
    const body = (await get('/api/tickets')).json<{
      projects: { projectId: string; offline?: string }[];
    }>();

    expect(
      body.projects.find((project) => project.projectId === bakery())
    ).toEqual({
      projectId: bakery(),
      name: 'Bakery site',
      offline: 'The Bakery site tracker refused the key.',
    });
  });

  it("lists the other projects when one computer doesn't answer in time", async () => {
    mini().on('tickets-list', () => new Promise(() => undefined));
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });

    try {
      const pending = get('/api/tickets');
      await mini().next('tickets-list');
      await laptop().next('tickets-list');
      // A socket keeps its order: once the mothership has answered a later
      // message from the laptop, it has its tickets-list answer too.
      await turns(1);
      laptop().send({ type: 'ticket-claims', folder: PARKS, id: 'sync' });
      await turnsUntil(() =>
        laptop().received.some(
          (message) => message.type === 'result' && message.id === 'sync'
        )
      );
      jest.advanceTimersByTime(TICKETS_LIST_TIMEOUT_MS);
      const body = (await pending).json<{
        projects: {
          projectId: string;
          tickets?: TicketListItem[];
          offline?: string;
        }[];
      }>();

      expect(TICKETS_LIST_TIMEOUT_MS).toBe(15_000);
      expect(
        body.projects.map(({ projectId, tickets, offline }) => [
          projectId,
          (tickets ?? []).map(({ title }) => title),
          offline,
        ])
      ).toEqual(
        expect.arrayContaining([
          [parks(), ['Trail markers'], undefined],
          [bakery(), [], "Leslie's Mac mini didn't answer. Try again."],
        ])
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('leaves out a group shipped more than 90 days ago', async () => {
    const longAgo = new Date(
      harness().clock.now - 100 * 24 * 60 * 60_000
    ).toISOString();
    [
      { type: 'group.add', groupId: 'g0', ticket: '1', at: longAgo },
      { type: 'group.shipped', groupId: 'g0', at: longAgo },
    ].forEach((event, index) =>
      storeEvent(harness().db, {
        id: `old${index}`,
        projectId: parks(),
        event,
        receivedAt: harness().clock.now,
      })
    );

    const body = (await get('/api/tickets')).json<{
      groupEvents: { groupId: string }[];
    }>();

    expect(body.groupEvents).toEqual([]);
  });

  it('lists the computers and the shipping-together events', async () => {
    storeEvent(harness().db, {
      id: 'g1',
      projectId: parks(),
      event: {
        type: 'group.add',
        groupId: 'g1',
        ticket: '3',
        at: '2026-10-21T12:00:00.000Z',
      },
      receivedAt: harness().clock.now,
    });
    storeEvent(harness().db, {
      id: 's1',
      projectId: parks(),
      event: {
        type: 'stage.start',
        name: 'build',
        at: '2026-10-21T12:00:00.000Z',
      },
      receivedAt: harness().clock.now,
    });
    const body = (await get('/api/tickets')).json<{
      groupEvents: { type: string; groupId: string; projectId: string }[];
      holdings: { computer: string; projectId: string; connected: boolean }[];
    }>();

    expect(body.groupEvents).toEqual([
      expect.objectContaining({
        type: 'group.add',
        groupId: 'g1',
        ticket: '3',
        projectId: parks(),
      }),
    ]);
    expect(
      body.holdings
        .map(({ computer, projectId, connected }) => [
          computer,
          projectId,
          connected,
        ])
        .sort()
    ).toEqual(
      [
        ["Leslie's MacBook", parks(), true],
        ["Leslie's Mac mini", bakery(), true],
      ].sort()
    );
  });

  it("forwards a ticket page to the codebase's runner and adds its events", async () => {
    storeEvent(harness().db, {
      id: 'b1',
      projectId: parks(),
      event: {
        type: 'stage.start',
        name: 'build',
        ticket: '3',
        at: '2026-10-21T12:00:00.000Z',
      },
      receivedAt: harness().clock.now,
    });
    storeEvent(harness().db, {
      id: 'b2',
      projectId: parks(),
      event: {
        type: 'stage.start',
        name: 'build',
        ticket: '4',
        at: '2026-10-21T12:00:00.000Z',
      },
      receivedAt: harness().clock.now,
    });
    const response = await get(`/api/tickets/${parks()}/3`);
    const page = response.json<{
      summary: { state: string };
      events: { ticket: string; name: string }[];
    }>();

    expect(response.status).toBe(200);
    expect(page.summary).toEqual({ state: 'writing' });
    expect(page.events.map(({ ticket: id, name }) => [id, name])).toEqual([
      ['3', 'build'],
    ]);
    expect(
      asked.messages.find((message) => message.type === 'ticket-get')
    ).toEqual(
      expect.objectContaining({
        folder: PARKS,
        projectId: parks(),
        ticketId: '3',
        opened: false,
      })
    );
    expect(openTicketSource).not.toHaveBeenCalled();
  });

  it('tells the runner when the page was just opened, so only then a failed summary is tried again', async () => {
    await get(`/api/tickets/${parks()}/3?opened=1`);

    expect(
      asked.messages.filter((message) => message.type === 'ticket-get').at(-1)
    ).toEqual(expect.objectContaining({ ticketId: '3', opened: true }));
  });

  it('answers a ticket page with the offline message when its computer is', async () => {
    await laptop().close();
    const response = await get(`/api/tickets/${parks()}/3`);

    expect(response.status).toBe(409);
    expect(response.json().error).toBe("Leslie's MacBook is offline.");
  });

  it('sends "Talk about this ticket" to the runner holding the project', async () => {
    const response = await post('/api/tickets/talk', {
      projectId: parks(),
      ticketId: '3',
      text: 'why did the test fail?',
    });

    expect(response.json()).toEqual({
      ok: true,
      result: { podId: 'build-1', target: 'product-manager' },
    });
    expect(
      asked.messages.find((message) => message.type === 'ticket-talk')
    ).toEqual(
      expect.objectContaining({
        folder: PARKS,
        ticketId: '3',
        text: 'why did the test fail?',
      })
    );
  });

  it('sends a change to the runner and records it in the ticket’s Activity', async () => {
    const response = await post('/api/tickets/update', {
      projectId: parks(),
      ticketId: '3',
      changes: { priority: 'high', assignee: "Ann's Mac mini" },
    });

    expect(
      response.json<{ result: { priority: string } }>().result.priority
    ).toBe('high');
    expect(
      asked.messages.find((message) => message.type === 'ticket-update')
    ).toEqual(
      expect.objectContaining({
        folder: PARKS,
        ticketId: '3',
        changes: { priority: 'high', assignee: "Ann's Mac mini" },
      })
    );

    const page = (await get(`/api/tickets/${parks()}/3`)).json<{
      events: Array<{ type: string; name: string; note: string }>;
    }>();
    expect(
      page.events
        .filter((event) => event.type === 'ticket.edit')
        .map(({ name, note }) => [name, note])
    ).toEqual([
      ['priority', 'high'],
      ['assignee', "Ann's Mac mini"],
    ]);
  });

  it('records one description edit per sitting, however often it saves', async () => {
    const save = (description: string) =>
      post('/api/tickets/update', {
        projectId: parks(),
        ticketId: '3',
        changes: { description },
      });
    await save('Pickup');
    await save('Trail markers');
    await save('Trail markers for every park.');

    const page = (await get(`/api/tickets/${parks()}/3`)).json<{
      events: Array<{ type: string; name: string }>;
    }>();

    expect(
      page.events.filter(
        (event) => event.type === 'ticket.edit' && event.name === 'description'
      )
    ).toHaveLength(1);
    expect(
      asked.messages.filter((message) => message.type === 'ticket-update')
    ).toHaveLength(3);
  });

  it('refuses a change it does not know, sending nothing', async () => {
    const response = await post('/api/tickets/update', {
      projectId: parks(),
      ticketId: '3',
      changes: { priority: 'whenever', owner: 'Ron' },
    });

    expect(response.status).toBe(400);
    expect(
      asked.messages.some((message) => message.type === 'ticket-update')
    ).toBe(false);
  });

  it('creates a ticket and moves one, through the runner', async () => {
    const made = await post('/api/tickets/new', {
      projectId: parks(),
      ticket: { title: 'Harvest festival', priority: 'urgent' },
    });
    const moved = await post('/api/tickets/move', {
      projectId: parks(),
      ticketId: '3',
      after: null,
    });

    expect(made.json<{ result: { id: string } }>().result.id).toBe('4');
    expect(moved.status).toBe(200);
    expect(
      asked.messages
        .filter((message) => message.type.startsWith('ticket-'))
        .map((message) => message.type)
    ).toEqual(['ticket-create', 'ticket-move']);
    expect(
      (
        await post('/api/tickets/new', {
          projectId: parks(),
          ticket: { title: ' ' },
        })
      ).status
    ).toBe(400);
  });

  it('waits for Start building as long as the runner may take', () => {
    expect(BUILDING_START_TIMEOUT_MS).toBeGreaterThan(
      STOP_TIMEOUT_MS + RESUME_ALL_TIMEOUT_MS + BUILD_TIMEOUT_MS
    );
  });

  it('waits for "Talk about this ticket" past the relay default', async () => {
    const slow = await startHarness({ timeoutMs: 50 });
    const runner = await connectRunner(slow, { name: "Leslie's MacBook" });
    await runner.next('owner');
    const projectId = holdProject(slow, runner.runnerId, { folder: PARKS });
    runner.on('ticket-talk', async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));

      return { podId: 'build-1', target: 'product-manager' };
    });

    const response = await slow.request('POST', '/api/tickets/talk', {
      cookie: slow.signIn(),
      body: JSON.stringify({ projectId, ticketId: '3', text: 'why?' }),
    });
    await runner.close();
    await slow.close();

    expect(response.status).toBe(200);
    expect(TICKET_TALK_TIMEOUT_MS).toBeGreaterThan(TALK_TIMEOUT_MS);
  });

  describe('with the project on two computers', () => {
    const MINI_PARKS = '/home/leslie/code/pawnee-parks';

    /** The mini also holds Parks, not as its current project. */
    const holdParksOnMini = (): void => {
      holdProject(harness(), mini().runnerId, {
        name: 'Pawnee Parks app',
        folder: MINI_PARKS,
        current: false,
      });
    };

    const storeOnMini = (snapshot: ReturnType<typeof podSnapshot>): void =>
      storeSnapshots(
        harness().db,
        mini().runnerId,
        MINI_PARKS,
        [snapshot],
        [],
        harness().clock.now
      );

    /** The folder each of the two messages went to. */
    const talkAndGet = async (): Promise<unknown[]> => {
      await post('/api/tickets/talk', {
        projectId: parks(),
        ticketId: '3',
        text: 'why did the test fail?',
      });
      await get(`/api/tickets/${parks()}/3`);

      return ['ticket-talk', 'ticket-get'].map(
        (type) =>
          asked.messages.find((message) => message.type === type)?.folder
      );
    };

    it("sends a ticket's talk and page to the computer running the codebase's building pod", async () => {
      holdParksOnMini();
      const building = podSnapshot('build-2');
      building.summary.pod.kind = 'building';
      storeOnMini(building);

      expect(await talkAndGet()).toEqual([MINI_PARKS, MINI_PARKS]);
    });

    it('sends them to the computer whose planning pod is planning the ticket', async () => {
      holdParksOnMini();
      const planning = podSnapshot('plan-2');
      planning.summary.pod.tickets = ['3'];
      storeOnMini(planning);

      expect(await talkAndGet()).toEqual([MINI_PARKS, MINI_PARKS]);
    });

    it('falls back to the preferred computer with no pod for the ticket', async () => {
      holdParksOnMini();
      // A planning pod planning another ticket, and an ended building pod.
      const planning = podSnapshot('plan-2');
      planning.summary.pod.tickets = ['4'];
      storeOnMini(planning);
      const ended = podSnapshot('build-2');
      ended.summary.pod.kind = 'building';
      ended.summary.pod.status = 'done';
      storeOnMini(ended);

      expect(await talkAndGet()).toEqual([PARKS, PARKS]);
    });
  });

  it('starts building on the computer and project asked for', async () => {
    const response = await post('/api/building/start', {
      projectId: parks(),
      runnerId: laptop().runnerId,
    });

    expect(response.json()).toEqual({
      ok: true,
      result: { podId: 'build-1' },
    });
    expect(
      asked.messages.find((message) => message.type === 'building-start')
    ).toEqual(expect.objectContaining({ folder: PARKS, projectId: parks() }));
  });

  it('starts the building pod it keeps on a computer paused, but one asked for active', async () => {
    await post('/api/building/start', {
      projectId: parks(),
      runnerId: laptop().runnerId,
    });
    await harness().mothership.tick();
    await turnsUntil(
      () =>
        asked.messages.filter((message) => message.type === 'building-start')
          .length > 1
    );

    const [asked1, ...kept] = asked.messages
      .filter((message) => message.type === 'building-start')
      .map((message) => message.paused ?? false);

    expect(asked1).toBe(false);
    expect(kept).not.toHaveLength(0);
    expect(kept.every((paused) => paused === true)).toBe(true);
  });

  it('answers 404 for a pod that is not a building pod', async () => {
    laptop().on('pod-action', (message) => ({
      pod: { id: message.podId },
      windows: ['dev'],
    }));
    const response = await get('/api/building/build-1');

    expect(response.status).toBe(404);
    expect(response.json().error).toBe('Not a building pod.');
  });

  it("refuses to start building on a computer that doesn't hold the project", async () => {
    const response = await post('/api/building/start', {
      projectId: parks(),
      runnerId: mini().runnerId,
    });

    expect(response.status).toBe(409);
    expect(
      asked.messages.some((message) => message.type === 'building-start')
    ).toBe(false);
  });

  it("reads a building pod's page from its runner and adds the codebase's events", async () => {
    storeEvent(harness().db, {
      id: 'e1',
      projectId: parks(),
      event: {
        type: 'stage.end',
        name: 'test',
        ticket: '3',
        attempt: 2,
        pod: 'build-1',
        at: '2026-10-21T12:00:00.000Z',
      },
      receivedAt: harness().clock.now,
    });
    const response = await get('/api/building/build-1');
    const detail = response.json<{
      windows: string[];
      events: {
        type: string;
        name: string;
        ticket: string;
        attempt: number;
        pod: string;
        at: number;
      }[];
    }>();

    expect(response.status).toBe(200);
    expect(detail.windows).toEqual(['dev']);
    expect(detail.events).toEqual([
      {
        type: 'stage.end',
        name: 'test',
        ticket: '3',
        attempt: 2,
        pod: 'build-1',
        result: null,
        at: Date.parse('2026-10-21T12:00:00.000Z'),
      },
    ]);
    expect(
      asked.messages.find((message) => message.type === 'pod-action')
    ).toEqual(expect.objectContaining({ action: 'building-detail' }));
  });

  it("sends a building pod only the events its timeline reads, never the codebase's metrics", async () => {
    const at = '2026-10-21T12:00:00.000Z';
    [
      { type: 'metric', name: 'tokens', value: 12 },
      { type: 'group.add', groupId: 'g1', ticket: '3' },
      { type: 'stage.start', name: 'build', ticket: '3' },
      { type: 'attempt.start', ticket: '3', attempt: 2 },
      { type: 'ship.end', ticket: '3', result: 'pass' as const },
    ].forEach((event, index) =>
      storeEvent(harness().db, {
        id: `mixed${index}`,
        projectId: parks(),
        event: { ...event, at },
        receivedAt: harness().clock.now,
      })
    );
    const detail = (await get('/api/building/build-1')).json<{
      events: { type: string }[];
    }>();

    expect(detail.events.map(({ type }) => type).sort()).toEqual([
      'attempt.start',
      'ship.end',
      'stage.start',
    ]);
  });

  it("sends a building pod only its own tickets' events, with Typical ticket worked out from every shipped one", async () => {
    const minute = (n: number) =>
      new Date(Date.UTC(2026, 9, 21, 12, n)).toISOString();
    [
      // Ticket 3, this pod's: still going.
      { type: 'stage.start', name: 'pick-up', ticket: '3', at: minute(0) },
      // Tickets 7 and 9, another pod's: shipped in 18m and 24m.
      { type: 'stage.start', name: 'pick-up', ticket: '7', at: minute(0) },
      { type: 'stage.start', name: 'ship', ticket: '7', at: minute(10) },
      { type: 'stage.end', name: 'ship', ticket: '7', at: minute(18) },
      { type: 'stage.start', name: 'pick-up', ticket: '9', at: minute(0) },
      { type: 'stage.start', name: 'ship', ticket: '9', at: minute(20) },
      { type: 'stage.end', name: 'ship', ticket: '9', at: minute(24) },
    ].forEach((event, index) =>
      storeEvent(harness().db, {
        id: `scoped${index}`,
        projectId: parks(),
        event: { ...event, pod: event.ticket === '3' ? 'build-1' : 'build-2' },
        receivedAt: harness().clock.now,
      })
    );
    const detail = (await get('/api/building/build-1')).json<{
      events: { ticket: string }[];
      typicalMs: number | null;
    }>();

    expect(detail.events.map(({ ticket }) => ticket)).toEqual(['3']);
    expect(detail.typicalMs).toBe(21 * 60_000);
  });

  it('works Typical ticket out from every shipped ticket, however long ago', async () => {
    const longAgo = (n: number) =>
      new Date(
        harness().clock.now - 200 * 24 * 60 * 60_000 + n * 60_000
      ).toISOString();
    [
      { name: 'pick-up', ticket: '7', type: 'stage.start', at: longAgo(0) },
      { name: 'ship', ticket: '7', type: 'stage.start', at: longAgo(10) },
      { name: 'ship', ticket: '7', type: 'stage.end', at: longAgo(18) },
      { name: 'pick-up', ticket: '9', type: 'stage.start', at: longAgo(0) },
      { name: 'ship', ticket: '9', type: 'stage.start', at: longAgo(20) },
      { name: 'ship', ticket: '9', type: 'stage.end', at: longAgo(24) },
    ].forEach((event, index) =>
      storeEvent(harness().db, {
        id: `old${index}`,
        projectId: parks(),
        event: { ...event, pod: 'build-2' },
        receivedAt: harness().clock.now,
      })
    );
    const detail = (await get('/api/building/build-1')).json<{
      typicalMs: number | null;
    }>();

    expect(detail.typicalMs).toBe(21 * 60_000);
  });

  it('works Typical ticket out again only when another ticket ships', async () => {
    const minute = (n: number) =>
      new Date(Date.UTC(2026, 9, 21, 12, n)).toISOString();
    const ship = (ticket: string, from: number, to: number) =>
      [
        { type: 'stage.start', name: 'pick-up', ticket, at: minute(from) },
        { type: 'stage.start', name: 'ship', ticket, at: minute(to - 2) },
        { type: 'stage.end', name: 'ship', ticket, at: minute(to) },
      ].forEach((event, index) =>
        storeEvent(harness().db, {
          id: `typical${ticket}-${index}`,
          projectId: parks(),
          event: { ...event, pod: 'build-2' },
          receivedAt: harness().clock.now,
        })
      );
    const typical = async () =>
      (await get('/api/building/build-1')).json<{ typicalMs: number | null }>()
        .typicalMs;
    ship('7', 0, 18);
    ship('9', 0, 24);
    const worked = jest.spyOn(buildTimeline, 'shippedTicketDurations');

    expect(await typical()).toBe(21 * 60_000);
    expect(await typical()).toBe(21 * 60_000);
    expect(worked).toHaveBeenCalledTimes(1);

    ship('11', 0, 30);

    expect(await typical()).toBe(24 * 60_000);
    expect(worked).toHaveBeenCalledTimes(2);
    worked.mockRestore();
  });

  it('sends Pause, Resume and the Product manager chat as pod actions', async () => {
    await post('/api/pause', { podId: 'build-1' });
    await post('/api/resume', { podId: 'build-1' });
    await post('/api/pm-chat', {
      podId: 'build-1',
      text: 'skip the next ticket',
    });

    expect(
      asked.messages
        .filter((message) => message.type === 'pod-action')
        .map((message) => message.action)
    ).toEqual(['pause', 'resume', 'pm-chat']);
  });

  it('names the computer each pod runs on in /api/state', async () => {
    const state = (await get('/api/state')).json<{
      lambda: { podComputers: Record<string, string> };
    }>();

    expect(state.lambda.podComputers).toEqual({
      'build-1': "Leslie's MacBook",
    });
  });

  it('puts every new route in the table the sign-in test walks, each 401 without a session', async () => {
    const samples = harness().mothership.routes.map(
      (route) => `${route.method} ${route.sample}`
    );
    const added = [
      'GET /api/building/p1',
      'POST /api/building/start',
      'POST /api/pause',
      'POST /api/resume',
      'POST /api/pm-chat',
      'GET /api/tickets',
      'GET /api/tickets/prj_1/3',
      'POST /api/tickets/talk',
      'GET /api/pod-file/p1/screenshots/3/1/a.png',
    ];

    expect(samples).toEqual(expect.arrayContaining(added));

    const statuses = await Promise.all(
      added.map(async (entry) => {
        const [method = '', urlPath = ''] = entry.split(' ');

        return (await harness().request(method, urlPath)).status;
      })
    );

    expect(statuses).toEqual(added.map(() => 401));
  });
});
