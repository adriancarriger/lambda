import { required } from '../../__tests__/required';
import { type Holder, computerState, isMidTurn, placePod } from '../computers';
import {
  type FakeRunner,
  type Harness,
  connectRunner,
  eventually,
  holdProject,
  startHarness,
} from './harness';

const NOW = Date.UTC(2026, 9, 21, 12);
const HOUR = 60 * 60 * 1000;

const holder = (overrides: Partial<Holder>): Holder => ({
  runnerId: 'rnr_a',
  name: "Leslie's MacBook",
  connected: true,
  currentProjectId: null,
  lastSeenAt: NOW,
  switching: false,
  ...overrides,
});

describe('the Computers screen’s state', () => {
  it('says offline with when it was last seen, switching, running or idle', () => {
    const base = {
      connected: true,
      lastSeenAt: NOW,
      switchingTo: null,
      midTurn: false,
    };

    expect(
      computerState(
        { ...base, connected: false, lastSeenAt: NOW - 2 * HOUR },
        NOW
      )
    ).toBe('offline · last seen 2 h ago');
    expect(
      computerState({ ...base, switchingTo: 'Sweetums recipe app' }, NOW)
    ).toBe('switching to Sweetums recipe app…');
    expect(computerState({ ...base, midTurn: true }, NOW)).toBe('running');
    expect(computerState(base, NOW)).toBe('idle');
  });

  it('reads a turn as mid-way when it started after it last ended', () => {
    expect(
      isMidTurn({
        startedAt: '2026-10-21T12:01:00Z',
        endedAt: '2026-10-21T12:00:00Z',
      })
    ).toBe(true);
    expect(
      isMidTurn({
        startedAt: '2026-10-21T12:00:00Z',
        endedAt: '2026-10-21T12:01:00Z',
      })
    ).toBe(false);
    expect(isMidTurn({})).toBe(false);
  });
});

describe('where a new pod goes', () => {
  it('to a connected runner already on its project, first', () => {
    expect(
      placePod('prj_sweetums', [
        holder({ runnerId: 'rnr_idle', currentProjectId: 'prj_pawnee' }),
        holder({ runnerId: 'rnr_on', currentProjectId: 'prj_sweetums' }),
      ])
    ).toEqual({ kind: 'send', runnerId: 'rnr_on' });
  });

  it('waits while the runner on its project is mid-switch, not sent into the stop', () => {
    expect(
      placePod('prj_sweetums', [
        holder({ currentProjectId: 'prj_sweetums', switching: true }),
      ])
    ).toEqual({ kind: 'wait' });
  });

  it('waits for a connected holder that’s on another project', () => {
    expect(
      placePod('prj_sweetums', [holder({ currentProjectId: 'prj_pawnee' })])
    ).toEqual({
      kind: 'wait',
    });
  });

  it('is refused when every holder is offline, naming the most recently seen', () => {
    expect(
      placePod('prj_sweetums', [
        holder({
          name: "Leslie's PC",
          connected: false,
          lastSeenAt: NOW - 5 * HOUR,
        }),
        holder({
          name: "Leslie's Mac mini",
          connected: false,
          lastSeenAt: NOW - HOUR,
        }),
      ])
    ).toEqual({ kind: 'offline', name: "Leslie's Mac mini" });
  });
});

describe('new pods over HTTP', () => {
  const fixture: { harness?: Harness; runner?: FakeRunner; cookie?: string } =
    {};
  const harness = (): Harness => required(fixture.harness, 'harness');
  const runner = (): FakeRunner => required(fixture.runner, 'runner');
  const cookie = (): string => required(fixture.cookie, 'cookie');

  beforeEach(async () => {
    fixture.harness = await startHarness();
    fixture.runner = await connectRunner(harness(), {
      name: "Leslie's Mac mini",
    });
    await runner().next('owner');
    fixture.cookie = harness().signIn();
  });

  afterEach(async () => {
    await runner().close();
    await harness().close();
  });

  it('409s naming the offline computer', async () => {
    const projectId = holdProject(harness(), runner().runnerId);
    const { runnerId } = runner();
    await runner().close();
    await eventually(() => !harness().mothership.relay.isConnected(runnerId));

    const response = await harness().request('POST', '/api/pods/new', {
      cookie: cookie(),
      body: JSON.stringify({
        text: 'A map of every dog park in Pawnee',
        projectId,
      }),
    });

    expect(response.status).toBe(409);
    expect(response.json().error).toBe("Leslie's Mac mini is offline.");
  });

  it('sends it to the runner on the project, with its intake', async () => {
    const projectId = holdProject(harness(), runner().runnerId);
    runner().on('pod-new', () => 'dog-park');

    const response = await harness().request('POST', '/api/pods/new', {
      cookie: cookie(),
      body: JSON.stringify({
        text: 'A map of every dog park in Pawnee',
        freeform: true,
        projectId,
      }),
    });

    expect(response.json()).toEqual({ ok: true, result: 'dog-park' });
    expect(
      runner().received.find((message) => message.type === 'pod-new')
    ).toMatchObject({
      folder: '/home/leslie/pawnee-parks',
      projectId,
      intake: {
        text: 'A map of every dog park in Pawnee',
        freeform: true,
        single: false,
      },
    });
  });

  it('keeps it waiting, labelled, while the computer is busy on another project', async () => {
    holdProject(harness(), runner().runnerId, { name: 'Pawnee Parks site' });
    const sweetums = holdProject(harness(), runner().runnerId, {
      name: 'Sweetums recipe app',
      folder: '/home/leslie/sweetums',
      current: false,
    });

    const response = await harness().request('POST', '/api/pods/new', {
      cookie: cookie(),
      body: JSON.stringify({ text: 'Nougat tracker', projectId: sweetums }),
    });
    const state = await harness().request('GET', '/api/state', {
      cookie: cookie(),
    });

    expect(String(response.json().result)).toMatch(/^waiting:/);
    expect(
      state.json<{ lambda: { waiting: { title: string; label: string }[] } }>()
        .lambda.waiting
    ).toEqual([
      expect.objectContaining({
        title: 'Nougat tracker',
        label: "Waiting: Leslie's Mac mini is busy on Pawnee Parks site",
      }),
    ]);
  });
});
