import * as http from 'http';

import {
  type Bind,
  LISTEN_RETRY_MS,
  bind,
  notHereYet,
  portInUse,
  startListeners,
} from '../listen';

const handle: http.RequestListener = (_request, response) => {
  response.end('ok');
};
const upgrade = () => undefined;

const freePort = async (): Promise<number> => {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));

  return typeof address === 'object' && address !== null ? address.port : 0;
};

const failure = (code: string): Error =>
  Object.assign(new Error(code), { code });

/** The real bind on 127.0.0.1; for any other address, what `outcomes` says, in turn. */
const scripted = (
  outcomes: ('ok' | 'EADDRNOTAVAIL' | 'EADDRINUSE' | 'EACCES')[]
) => {
  const tried: { tries: string[] } = { tries: [] };
  const fake: Bind = async (server, port, address) => {
    if (address === '127.0.0.1') {
      return bind(server, port, address);
    }

    const outcome = outcomes[tried.tries.length] ?? 'ok';
    tried.tries = [...tried.tries, outcome];

    if (outcome !== 'ok') {
      throw failure(outcome);
    }
  };

  return {
    fake,
    get tries() {
      return tried.tries;
    },
  };
};

const settle = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

describe('the mothership’s listeners', () => {
  it('listens on 127.0.0.1 only, with no mothership.listen', async () => {
    const port = await freePort();
    const listeners = await startListeners({
      handle,
      upgrade,
      port,
      log: jest.fn(),
      onFatal: jest.fn(),
    });

    expect(listeners.addresses()).toEqual([`127.0.0.1:${port}`]);
    await listeners.close();
  });

  it('adds mothership.listen and keeps 127.0.0.1', async () => {
    const port = await freePort();
    const { fake } = scripted(['ok']);
    const listeners = await startListeners({
      handle,
      upgrade,
      port,
      listen: '100.64.0.2',
      log: jest.fn(),
      onFatal: jest.fn(),
      bind: fake,
    });
    await settle();

    expect(listeners.addresses()).toEqual([
      `127.0.0.1:${port}`,
      `100.64.0.2:${port}`,
    ]);
    await listeners.close();
  });

  it('retries an address that isn’t here yet every 5 s, with 127.0.0.1 up meanwhile', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const port = await freePort();
    const script = scripted(['EADDRNOTAVAIL', 'ok']);
    const { fake } = script;
    const log = jest.fn();
    const onFatal = jest.fn();
    const listeners = await startListeners({
      handle,
      upgrade,
      port,
      listen: '100.64.0.2',
      log,
      onFatal,
      bind: fake,
    });
    await settle();

    expect(listeners.addresses()).toEqual([`127.0.0.1:${port}`]);
    expect(log).toHaveBeenCalledWith(notHereYet('100.64.0.2', port));
    expect(notHereYet('100.64.0.2', port)).toBe(
      `Can't listen on 100.64.0.2:${port}: that address isn't on this computer yet. Trying again in 5 seconds.`
    );

    jest.advanceTimersByTime(LISTEN_RETRY_MS);
    await settle();

    expect(script.tries).toEqual(['EADDRNOTAVAIL', 'ok']);
    expect(listeners.addresses()).toEqual([
      `127.0.0.1:${port}`,
      `100.64.0.2:${port}`,
    ]);
    expect(onFatal).not.toHaveBeenCalled();
    jest.useRealTimers();
    await listeners.close();
  });

  it('gives up when the listen address’s port is in use', async () => {
    const port = await freePort();
    const { fake } = scripted(['EADDRINUSE']);
    const onFatal = jest.fn();
    const listeners = await startListeners({
      handle,
      upgrade,
      port,
      listen: '100.64.0.2',
      log: jest.fn(),
      onFatal,
      bind: fake,
    });
    await settle();

    expect(onFatal).toHaveBeenCalledWith(portInUse('100.64.0.2', port));
    expect(portInUse('100.64.0.2', port)).toBe(
      `Can't listen on 100.64.0.2:${port}: the port is in use. Set mothership.port in ~/.lambda/config.json.`
    );
    await listeners.close();
  });

  it('fails when 127.0.0.1’s port is already held', async () => {
    const port = await freePort();
    const holder = http.createServer();
    await new Promise<void>((resolve) =>
      holder.listen(port, '127.0.0.1', resolve)
    );

    await expect(
      startListeners({
        handle,
        upgrade,
        port,
        log: jest.fn(),
        onFatal: jest.fn(),
      })
    ).rejects.toThrow(portInUse('127.0.0.1', port));

    await new Promise<void>((resolve) => holder.close(() => resolve()));
  });

  it('gives up on any other bind failure, naming it, instead of retrying', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const port = await freePort();
    const script = scripted(['EACCES', 'ok']);
    const log = jest.fn();
    const onFatal = jest.fn();
    const listeners = await startListeners({
      handle,
      upgrade,
      port,
      listen: '100.64.0.2',
      log,
      onFatal,
      bind: script.fake,
    });
    await settle();
    jest.advanceTimersByTime(LISTEN_RETRY_MS);
    await settle();

    expect(onFatal).toHaveBeenCalledWith(
      `Can't listen on 100.64.0.2:${port}: EACCES.`
    );
    expect(log).not.toHaveBeenCalledWith(notHereYet('100.64.0.2', port));
    expect(script.tries).toEqual(['EACCES']);
    jest.useRealTimers();
    await listeners.close();
  });
});
