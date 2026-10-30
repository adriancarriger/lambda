import { required } from '../../__tests__/required';
import type { Message } from '../../protocol';
import { removeRunner } from '../registry';
import {
  type FakeRunner,
  type Harness,
  connectRunner,
  eventually,
  holdProject,
  startHarness,
} from './harness';

/**
 * Ticket claims: one atomic claim per (project, ticket) in the mothership's
 * SQLite, so two runners on a project never build the same ticket. The
 * runner is the one whose signature opened the socket, never a body field.
 */

const FOLDER = '/home/leslie/pawnee-parks';
const OTHER_FOLDER = '/home/leslie/code/pawnee-parks';
const LESLIE = { name: 'Leslie Knope', email: 'leslie@pawnee.gov' };

interface ClaimRow {
  ticket_id: string;
  runner_id: string;
  shipped_at: number | null;
}

describe('ticket claims', () => {
  const fixture: {
    harness?: Harness;
    a?: FakeRunner;
    b?: FakeRunner;
    projectId?: string;
  } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');
  const a = (): FakeRunner => required(fixture.a, 'runner A');
  const b = (): FakeRunner => required(fixture.b, 'runner B');
  const counter = { seq: 0 };

  beforeEach(async () => {
    fixture.harness = await startHarness();
    fixture.a = await connectRunner(harness(), { name: "Leslie's MacBook" });
    fixture.b = await connectRunner(harness(), { name: "Leslie's Mac mini" });
    await a().next('owner');
    await b().next('owner');
    fixture.projectId = holdProject(harness(), a().runnerId, {
      folder: FOLDER,
    });
    holdProject(harness(), b().runnerId, { folder: OTHER_FOLDER });
  });

  afterEach(async () => {
    await a().close();
    await b().close();
    await harness().close();
  });

  const rows = (): ClaimRow[] =>
    harness()
      .db.prepare<[], ClaimRow>(
        'SELECT ticket_id, runner_id, shipped_at FROM ticket_claims ORDER BY ticket_id'
      )
      .all();

  /** Send one runner write and wait for its result. */
  const ask = async (
    runner: FakeRunner,
    message: Record<string, unknown> & { type: string }
  ): Promise<Message> => {
    counter.seq += 1;
    const id = `c${counter.seq}`;
    runner.send({ ...message, id });
    await eventually(() =>
      runner.received.some(
        (received) => received.type === 'result' && received.id === id
      )
    );

    return required(
      runner.received.find(
        (received) => received.type === 'result' && received.id === id
      ),
      'result'
    );
  };

  const claim = (
    runner: FakeRunner,
    ticketId: string,
    extra: Record<string, unknown> = {}
  ) =>
    ask(runner, {
      type: 'ticket-claim',
      folder: runner === a() ? FOLDER : OTHER_FOLDER,
      ticketId,
      reporter: LESLIE,
      ...extra,
    });

  it('claims a ticket for the runner whose socket asked', async () => {
    const result = await claim(a(), '3');

    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ outcome: 'claimed' });
    expect(rows()).toEqual([
      { ticket_id: '3', runner_id: a().runnerId, shipped_at: null },
    ]);
  });

  it('gives a ticket to one runner only; the other is told it is taken', async () => {
    await claim(a(), '3');
    const second = await claim(b(), '3');

    expect(second.result).toEqual({ outcome: 'taken' });
    expect(rows()).toEqual([
      { ticket_id: '3', runner_id: a().runnerId, shipped_at: null },
    ]);
  });

  it('gives a runner its own unshipped claim back when it asks again', async () => {
    await claim(a(), '3');
    const again = await claim(a(), '3');

    expect(again.result).toEqual({ outcome: 'claimed' });
    expect(rows()).toEqual([
      { ticket_id: '3', runner_id: a().runnerId, shipped_at: null },
    ]);
  });

  it("refuses runner A's signature asking to claim as runner B, writing nothing", async () => {
    const result = await claim(a(), '3', { runnerId: b().runnerId });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('A computer can only claim tickets for itself.');
    expect(rows()).toEqual([]);
  });

  it('refuses a socket signed with another runner’s key', async () => {
    const impostor = await connectRunner(harness(), {
      runnerId: b().runnerId,
      privateKey: a().privateKey,
    });
    await eventually(
      () => impostor.socket.readyState === impostor.socket.CLOSED
    );

    expect(impostor.received.some((message) => message.type === 'owner')).toBe(
      false
    );
    expect(rows()).toEqual([]);
  });

  it("refuses a reporter that isn't the owner, writing nothing", async () => {
    const result = await claim(a(), '4', {
      reporter: { name: 'Ron Swanson', email: 'ron@pawnee.gov' },
    });

    expect(result.result).toEqual({ outcome: 'not-owner' });
    expect(rows()).toEqual([]);
  });

  it('takes an email alias, a name alias and no reporter as the owner’s', async () => {
    harness()
      .db.prepare(
        "INSERT INTO aliases (kind, value, created_at) VALUES ('email', 'lknope@pawnee.gov', 0), ('name', 'Knope', 0)"
      )
      .run();

    expect(
      (
        await claim(a(), '5', {
          reporter: { name: 'Pawnee build bot', email: 'LKnope@Pawnee.gov' },
        })
      ).result
    ).toEqual({ outcome: 'claimed' });
    expect(
      (await claim(a(), '6', { reporter: { name: 'knope' } })).result
    ).toEqual({ outcome: 'claimed' });
    expect((await claim(a(), '7', { reporter: null })).result).toEqual({
      outcome: 'claimed',
    });
  });

  it.each([
    ['an email with no name', { email: 'leslie@pawnee.gov' }],
    ['a bare string', 'Leslie Knope'],
  ])(
    'refuses a malformed reporter (%s) rather than taking it as none',
    async (_label, reporter) => {
      const result = await claim(a(), '8', { reporter });

      expect(result.ok).toBe(false);
      expect(result.error).toBe(
        "A claim's reporter must be {name, email?} or null."
      );
      expect(rows()).toEqual([]);
    }
  );

  it('releases and ships a queued claim by its project after the folder moved', async () => {
    await claim(a(), '3');
    await claim(a(), '4');
    harness()
      .db.prepare(
        'UPDATE runner_projects SET folder = ? WHERE runner_id = ? AND project_id = ?'
      )
      .run('/home/leslie/moved/pawnee-parks', a().runnerId, fixture.projectId);

    const released = await ask(a(), {
      type: 'ticket-release',
      folder: FOLDER,
      projectId: fixture.projectId,
      ticketId: '3',
    });
    const shipped = await ask(a(), {
      type: 'ticket-shipped',
      folder: FOLDER,
      projectId: fixture.projectId,
      ticketId: '4',
    });

    expect(released.ok).toBe(true);
    expect(shipped.ok).toBe(true);
    expect(rows()).toEqual([
      {
        ticket_id: '4',
        runner_id: a().runnerId,
        shipped_at: harness().clock.now,
      },
    ]);
  });

  it('applies a queued release and ship after the runner let the project go', async () => {
    await claim(a(), '3');
    await claim(a(), '4');
    harness()
      .db.prepare(
        'DELETE FROM runner_projects WHERE runner_id = ? AND project_id = ?'
      )
      .run(a().runnerId, fixture.projectId);

    const released = await ask(a(), {
      type: 'ticket-release',
      folder: FOLDER,
      projectId: fixture.projectId,
      ticketId: '3',
    });
    const shipped = await ask(a(), {
      type: 'ticket-shipped',
      folder: FOLDER,
      projectId: fixture.projectId,
      ticketId: '4',
    });

    expect([released.result, shipped.result]).toEqual(['stored', 'stored']);
    expect(rows()).toEqual([
      {
        ticket_id: '4',
        runner_id: a().runnerId,
        shipped_at: harness().clock.now,
      },
    ]);
  });

  it('acknowledges, changing nothing, a queued release of a claim the runner never held', async () => {
    await claim(a(), '3');

    const named = await ask(b(), {
      type: 'ticket-release',
      folder: OTHER_FOLDER,
      projectId: fixture.projectId,
      ticketId: '3',
    });
    const unknown = await ask(b(), {
      type: 'ticket-release',
      folder: OTHER_FOLDER,
      projectId: 'not-a-project',
      ticketId: '3',
    });
    // An item queued before `projectId` rode along, its folder since unlinked.
    const oldItem = await ask(b(), {
      type: 'ticket-shipped',
      folder: '/home/leslie/elsewhere',
      ticketId: '3',
    });

    expect(
      [named, unknown, oldItem].map(({ ok, result }) => [ok, result])
    ).toEqual([
      [true, 'unchanged'],
      [true, 'unchanged'],
      [true, 'unchanged'],
    ]);
    expect(rows()).toEqual([
      { ticket_id: '3', runner_id: a().runnerId, shipped_at: null },
    ]);
  });

  it("refuses a folder that isn't one of the runner's projects", async () => {
    const result = await ask(a(), {
      type: 'ticket-claim',
      folder: '/home/leslie/elsewhere',
      ticketId: '3',
      reporter: LESLIE,
    });

    expect(result.ok).toBe(false);
    expect(rows()).toEqual([]);
  });

  it('lists the project’s claims to either runner', async () => {
    await claim(a(), '3');
    const listed = await ask(b(), {
      type: 'ticket-claims',
      folder: OTHER_FOLDER,
    });

    expect(listed.result).toEqual({
      claims: [{ ticketId: '3', runnerId: a().runnerId, shippedAt: null }],
    });
  });

  it('releases a claim only for the runner holding it', async () => {
    await claim(a(), '3');
    await ask(b(), {
      type: 'ticket-release',
      folder: OTHER_FOLDER,
      ticketId: '3',
    });

    expect(rows()).toHaveLength(1);

    await ask(a(), { type: 'ticket-release', folder: FOLDER, ticketId: '3' });

    expect(rows()).toEqual([]);
    expect((await claim(b(), '3')).result).toEqual({ outcome: 'claimed' });
  });

  it('keeps a shipped claim: never released, never taken again', async () => {
    await claim(a(), '3');
    await ask(a(), { type: 'ticket-shipped', folder: FOLDER, ticketId: '3' });

    expect(rows()).toEqual([
      {
        ticket_id: '3',
        runner_id: a().runnerId,
        shipped_at: harness().clock.now,
      },
    ]);

    await ask(a(), { type: 'ticket-release', folder: FOLDER, ticketId: '3' });

    expect(rows()).toHaveLength(1);
    expect((await claim(b(), '3')).result).toEqual({ outcome: 'taken' });
  });

  it('keeps a removed runner’s shipped claims and frees its unshipped ones', async () => {
    await claim(a(), '3');
    await claim(a(), '4');
    await ask(a(), { type: 'ticket-shipped', folder: FOLDER, ticketId: '3' });

    expect(removeRunner(harness().db, a().runnerId)).toBe(true);
    expect(rows()).toEqual([
      {
        ticket_id: '3',
        runner_id: a().runnerId,
        shipped_at: harness().clock.now,
      },
    ]);
    expect((await claim(b(), '3')).result).toEqual({ outcome: 'taken' });
    expect((await claim(b(), '4')).result).toEqual({ outcome: 'claimed' });
  });

  it('records a ship with no claim row, so no other runner builds it again', async () => {
    // The claim was released (a stall), then the ticket shipped by hand.
    await claim(a(), '3');
    await ask(a(), { type: 'ticket-release', folder: FOLDER, ticketId: '3' });
    const shipped = await ask(a(), {
      type: 'ticket-shipped',
      folder: FOLDER,
      ticketId: '3',
    });

    expect(shipped.result).toBe('stored');
    expect(rows()).toEqual([
      {
        ticket_id: '3',
        runner_id: a().runnerId,
        shipped_at: harness().clock.now,
      },
    ]);
    expect((await claim(b(), '3')).result).toEqual({ outcome: 'taken' });
  });

  it('acknowledges, storing nothing, a queued ship for a project that is gone', async () => {
    const shipped = await ask(a(), {
      type: 'ticket-shipped',
      folder: FOLDER,
      projectId: 'not-a-project',
      ticketId: '3',
    });

    expect([shipped.ok, shipped.result]).toEqual([true, 'unchanged']);
    expect(rows()).toEqual([]);
  });

  it('acknowledges, storing nothing, a queued ship for a project the runner never held', async () => {
    const bakery = holdProject(harness(), a().runnerId, {
      name: 'Bakery site',
      folder: '/home/leslie/bakery',
    });
    const shipped = await ask(b(), {
      type: 'ticket-shipped',
      folder: OTHER_FOLDER,
      projectId: bakery,
      ticketId: '9',
    });

    expect([shipped.ok, shipped.result]).toEqual([true, 'unchanged']);
    expect(rows()).toEqual([]);
    expect(
      (await claim(a(), '9', { folder: '/home/leslie/bakery' })).result
    ).toEqual({
      outcome: 'claimed',
    });
  });

  it("never takes another runner's unshipped claim by shipping it", async () => {
    await claim(b(), '3');
    const shipped = await ask(a(), {
      type: 'ticket-shipped',
      folder: FOLDER,
      ticketId: '3',
    });

    // The claim stays B's, but the ship is recorded on it: dropping it would
    // leave B building a ticket that has already shipped.
    expect(shipped.result).toBe('stored');
    expect(rows()).toEqual([
      {
        ticket_id: '3',
        runner_id: b().runnerId,
        shipped_at: harness().clock.now,
      },
    ]);
  });

  it("shows another runner's claim as shipped once A ships the ticket", async () => {
    await claim(b(), '3');
    await ask(a(), { type: 'ticket-shipped', folder: FOLDER, ticketId: '3' });
    const listed = await ask(b(), {
      type: 'ticket-claims',
      folder: OTHER_FOLDER,
    });

    expect(listed.result).toEqual({
      claims: [
        {
          ticketId: '3',
          runnerId: b().runnerId,
          shippedAt: harness().clock.now,
        },
      ],
    });
  });

  it('acknowledges a resent release or ship once, storing nothing twice', async () => {
    const resend = async (message: Message & { id: string }) => {
      const { id } = message;
      a().send(message);
      a().send(message);
      await eventually(
        () =>
          a().received.filter(
            (received) => received.type === 'result' && received.id === id
          ).length === 2
      );

      return a()
        .received.filter(
          (received) => received.type === 'result' && received.id === id
        )
        .map(({ result }) => result);
    };

    await claim(a(), '3');
    const release: Message & { id: string } = {
      type: 'ticket-release',
      id: 'release-3',
      folder: FOLDER,
      ticketId: '3',
    };

    expect(await resend(release)).toEqual(['stored', 'duplicate']);

    // Claimed again: the release, resent late, must not free the new claim.
    await claim(a(), '3');
    a().send(release);
    await eventually(
      () =>
        a().received.filter(
          (received) =>
            received.type === 'result' && received.id === 'release-3'
        ).length === 3
    );

    expect(rows()).toEqual([
      { ticket_id: '3', runner_id: a().runnerId, shipped_at: null },
    ]);
    expect(
      await resend({
        type: 'ticket-shipped',
        id: 'ship-3',
        folder: FOLDER,
        ticketId: '3',
      })
    ).toEqual(['stored', 'duplicate']);
    expect(rows()).toHaveLength(1);
  });
});
