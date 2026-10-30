import { required } from '../../__tests__/required';
import { addWaitingPod, claimWaitingPods, storeSnapshots } from '../pods';
import { createRelay } from '../relay';
import {
  type FakeRunner,
  type Harness,
  connectRunner,
  eventually,
  holdProject,
  podSnapshot,
  startHarness,
} from './harness';

const FOLDER = '/home/leslie/pawnee-parks';

describe('relaying to a runner', () => {
  const fixture: { harness?: Harness; runner?: FakeRunner; cookie?: string } =
    {};
  const harness = (): Harness => required(fixture.harness, 'harness');
  const runner = (): FakeRunner => required(fixture.runner, 'runner');
  const cookie = (): string => required(fixture.cookie, 'cookie');

  beforeEach(async () => {
    fixture.harness = await startHarness({ timeoutMs: 100 });
    fixture.runner = await connectRunner(harness(), {
      name: "Leslie's Mac mini",
    });
    await runner().next('owner');
    holdProject(harness(), runner().runnerId, { folder: FOLDER });
    storeSnapshots(
      harness().db,
      runner().runnerId,
      FOLDER,
      [podSnapshot('dog-park')],
      [],
      harness().clock.now
    );
    fixture.cookie = harness().signIn();
  });

  afterEach(async () => {
    await runner().close();
    await harness().close();
  });

  it('refuses an offline runner’s pod at once (409), and nothing reaches it later', async () => {
    const { runnerId } = runner();
    await runner().close();
    await eventually(() => !harness().mothership.relay.isConnected(runnerId));

    const action = await harness().request('POST', '/api/nudge', {
      cookie: cookie(),
      body: JSON.stringify({ podId: 'dog-park' }),
    });
    const term = await harness().request(
      'GET',
      '/api/term?podId=dog-park&window=dev',
      { cookie: cookie() }
    );
    const keys = await harness().request('POST', '/api/term/keys', {
      cookie: cookie(),
      body: JSON.stringify({ podId: 'dog-park', window: 'dev', hex: ['6c'] }),
    });

    [action, term, keys].forEach((response) => {
      expect(response.status).toBe(409);
      expect(response.json().error).toBe("Leslie's Mac mini is offline.");
    });

    fixture.runner = await connectRunner(harness(), {
      runnerId,
      privateKey: runner().privateKey,
    });
    await runner().next('owner');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(runner().received.map((message) => message.type)).toEqual([
      'challenge',
      'owner',
    ]);
  });

  it('answers 504 when a connected runner never answers', async () => {
    const response = await harness().request('POST', '/api/nudge', {
      cookie: cookie(),
      body: JSON.stringify({ podId: 'dog-park' }),
    });

    expect(response.status).toBe(504);
    expect(response.json().error).toBe(
      "Leslie's Mac mini didn't answer. Try again."
    );
  });

  it('logs a result that comes after its request timed out as late, not as an unknown type', async () => {
    const response = await harness().request('POST', '/api/nudge', {
      cookie: cookie(),
      body: JSON.stringify({ podId: 'dog-park' }),
    });
    expect(response.status).toBe(504);
    const sent = required(
      runner().received.find((message) => message.type === 'pod-action')?.id,
      'request id'
    );

    runner().send({ type: 'result', id: sent, ok: true, result: 'nudged' });

    await eventually(() =>
      harness().logs.some((line) =>
        line.includes(`late result for ${sent} from Leslie's Mac mini`)
      )
    );
    expect(
      harness().logs.filter((line) => line.includes('unknown type'))
    ).toEqual([]);
  });

  it('forgets a computer’s pods when it leaves, and puts back what it had claimed', async () => {
    const sweetums = holdProject(harness(), runner().runnerId, {
      name: 'Sweetums recipe app',
      folder: '/home/leslie/sweetums',
      current: false,
    });
    const waitingId = addWaitingPod(
      harness().db,
      sweetums,
      { text: 'Nougat tracker', freeform: false, single: false },
      harness().clock.now
    );
    claimWaitingPods(
      harness().db,
      runner().runnerId,
      [waitingId],
      harness().clock.now
    );

    runner().send({ type: 'leave', id: 'bye' });
    await runner().next('result');

    expect(
      harness().db.prepare('SELECT id, runner_id FROM pods ORDER BY id').all()
    ).toEqual([{ id: waitingId, runner_id: null }]);
    const state = await harness().request('GET', '/api/state', {
      cookie: cookie(),
    });
    expect(state.json<{ pods: unknown[] }>().pods).toEqual([]);
  });

  it('passes a failed action on as today’s 400', async () => {
    runner().on('pod-action', () => {
      throw new Error('no such pod');
    });

    const response = await harness().request('POST', '/api/nudge', {
      cookie: cookie(),
      body: JSON.stringify({ podId: 'dog-park' }),
    });

    expect(response.status).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: 'no such pod' });
  });

  it('sends each app action to the pod’s runner as a pod action', async () => {
    runner().on('pod-action', (message) => `ran ${String(message.action)}`);

    const response = await harness().request('POST', '/api/rename', {
      cookie: cookie(),
      body: JSON.stringify({ podId: 'dog-park', title: 'Dog park map' }),
    });
    const sent = runner().received.find(
      (message) => message.type === 'pod-action'
    );

    expect(response.json()).toEqual({ ok: true, result: 'ran rename' });
    expect(sent).toMatchObject({
      action: 'rename',
      podId: 'dog-park',
      folder: FOLDER,
      body: { podId: 'dog-park', title: 'Dog park map' },
    });
  });
});

describe('the relay’s 60-second wait', () => {
  it('answers 504 after 60 s with no result', async () => {
    jest.useFakeTimers();
    const relay = createRelay({
      runnerName: () => "Leslie's Mac mini",
      onMessage: jest.fn(),
    });
    relay.attach('rnr_1', { send: jest.fn(), close: jest.fn() });

    const waiting = relay.request('rnr_1', { type: 'pod-action' });
    jest.advanceTimersByTime(59_999);
    const early = await Promise.race([
      waiting.then(
        () => 'answered',
        () => 'failed'
      ),
      Promise.resolve('pending'),
    ]);
    jest.advanceTimersByTime(1);

    expect(early).toBe('pending');
    await expect(waiting).rejects.toMatchObject({
      status: 504,
      message: "Leslie's Mac mini didn't answer. Try again.",
    });
    jest.useRealTimers();
  });

  it('queues nothing for an offline runner', async () => {
    const relay = createRelay({
      runnerName: () => "Leslie's Mac mini",
      onMessage: jest.fn(),
    });

    await expect(
      relay.request('rnr_1', { type: 'pod-action' })
    ).rejects.toMatchObject({
      status: 409,
      message: "Leslie's Mac mini is offline.",
    });

    const send = jest.fn();
    relay.attach('rnr_1', { send, close: jest.fn() });

    expect(send).not.toHaveBeenCalled();
  });

  it('settles a request only with its own runner’s result', async () => {
    const sent: { messages: { id?: string }[] } = { messages: [] };
    const onMessage = jest.fn();
    const relay = createRelay({
      runnerName: () => "Leslie's Mac mini",
      onMessage,
    });
    relay.attach('rnr_1', {
      send: (message) => {
        sent.messages = [...sent.messages, message];
      },
      close: jest.fn(),
    });
    relay.attach('rnr_2', { send: jest.fn(), close: jest.fn() });

    const waiting = relay.request('rnr_1', { type: 'pod-action' });
    const id = required(sent.messages[0]?.id, 'request id');
    relay.receive('rnr_2', { type: 'result', id, ok: true, result: 'forged' });
    const early = await Promise.race([
      waiting.then(
        () => 'answered',
        () => 'failed'
      ),
      Promise.resolve('pending'),
    ]);

    expect(early).toBe('pending');

    relay.receive('rnr_1', { type: 'result', id, ok: true, result: 'real' });

    await expect(waiting).resolves.toBe('real');
  });
});
