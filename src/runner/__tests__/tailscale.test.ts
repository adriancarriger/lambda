import * as fs from 'fs';
import * as path from 'path';

import { required } from '../../__tests__/required';
import {
  loadMachineConfig,
  writeMachineConfig,
} from '../../config/machineConfig';
import {
  type Harness,
  startHarness,
  tempHome,
} from '../../mothership/__tests__/harness';
import {
  type Bind,
  LISTEN_RETRY_MS,
  type Listeners,
  notOnThisComputer,
  portInUse,
  startListeners,
} from '../../mothership/listen';
import {
  INSTALL_TAILSCALE,
  SIGN_IN_TO_TAILSCALE,
  type TailscaleCheck,
  type TailscaleUp,
  checkTailscale,
  joinServer,
  listenFields,
  readTailscaleStatus,
  saveListenFields,
  stepOneText,
} from '../tailscale';

/** Leslie's MacBook, running the mothership, signed in to her tailnet. */
const status = (
  overrides: {
    BackendState?: string;
    TailscaleIPs?: string[];
    MagicDNSEnabled?: boolean;
  } = {}
): string =>
  JSON.stringify({
    BackendState: overrides.BackendState ?? 'Running',
    Self: {
      HostName: 'leslies-macbook',
      DNSName: 'leslies-macbook.tail1234.ts.net.',
      TailscaleIPs: overrides.TailscaleIPs ?? [
        '100.64.12.34',
        'fd7a:115c:a1e0::1',
      ],
    },
    CurrentTailnet: {
      Name: 'leslie@pawnee.gov',
      MagicDNSEnabled: overrides.MagicDNSEnabled ?? true,
    },
  });

const up = (magicDns = true): TailscaleUp => {
  const check = readTailscaleStatus(status({ MagicDNSEnabled: magicDns }));

  if (check.state !== 'up') {
    throw new Error(`Expected Tailscale up, got ${check.state}.`);
  }

  return check;
};

describe('reading tailscale status --json', () => {
  it('says ✓ this Mac when it is up, Sign in when logged out or unreadable', () => {
    expect(stepOneText(up())).toBe('✓ this Mac');
    expect(
      stepOneText(readTailscaleStatus(status({ BackendState: 'NeedsLogin' })))
    ).toBe(SIGN_IN_TO_TAILSCALE);
    expect(stepOneText(readTailscaleStatus('Tailscale is stopped.'))).toBe(
      SIGN_IN_TO_TAILSCALE
    );
    expect(stepOneText({ state: 'missing' })).toBe(INSTALL_TAILSCALE);
    expect([INSTALL_TAILSCALE, SIGN_IN_TO_TAILSCALE]).toEqual([
      'Install Tailscale',
      'Sign in to Tailscale',
    ]);
  });

  it('uses the MagicDNS name, without its dot, only when MagicDNS is on', () => {
    expect(up()).toEqual({
      state: 'up',
      address: '100.64.12.34',
      name: 'leslies-macbook.tail1234.ts.net',
      label: 'leslies-macbook',
    });
    expect(joinServer(up(), 4580)).toBe(
      'http://leslies-macbook.tail1234.ts.net:4580'
    );
    expect(joinServer(up(false), 4580)).toBe('http://100.64.12.34:4580');
  });

  it('takes the first tailnet IPv4, never an IPv6 or an address outside 100.64.0.0/10', () => {
    const check = readTailscaleStatus(
      status({
        TailscaleIPs: [
          'fd7a:115c:a1e0::1',
          '0.0.0.0',
          '192.168.1.20',
          '100.128.0.1',
          '100.64.12.34',
          '100.64.0.9',
        ],
      })
    );

    expect(check).toMatchObject({ state: 'up', address: '100.64.12.34' });
    expect(
      readTailscaleStatus(status({ TailscaleIPs: ['fd7a:115c:a1e0::1'] }))
    ).toEqual({ state: 'signed-out' });
    expect(readTailscaleStatus(status({ TailscaleIPs: ['0.0.0.0'] }))).toEqual({
      state: 'signed-out',
    });
  });

  it('writes the IPv4 to mothership.listen, and the name to mothership.host only with MagicDNS', () => {
    const home = tempHome();
    const env = { LAMBDA_HOME: home };
    writeMachineConfig(
      {
        owner: { name: 'Leslie Knope', email: 'leslie@pawnee.gov' },
        mothership: { port: 4580 },
      },
      env
    );

    expect(listenFields(up(false))).toEqual({ listen: '100.64.12.34' });
    saveListenFields(listenFields(up(false)), env);
    expect(loadMachineConfig(env)?.mothership).toEqual({
      port: 4580,
      listen: '100.64.12.34',
    });

    saveListenFields(listenFields(up()), env);
    expect(loadMachineConfig(env)).toEqual({
      owner: { name: 'Leslie Knope', email: 'leslie@pawnee.gov' },
      mothership: {
        port: 4580,
        listen: '100.64.12.34',
        host: 'leslies-macbook.tail1234.ts.net',
      },
    });
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('finding the tailscale CLI', () => {
  const fixture: { dir?: string } = {};
  const dir = (): string => required(fixture.dir, 'dir');

  beforeEach(() => {
    fixture.dir = tempHome();
    fs.mkdirSync(path.join(dir(), 'bin'));
  });

  afterEach(() => fs.rmSync(dir(), { recursive: true, force: true }));

  /** A fake CLI: prints `output` for `status --json`, exits `code`. */
  const fakeCli = (file: string, output: string, code = 0): string => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `#!/bin/sh\n[ "$1 $2" = "status --json" ] || exit 9\ncat <<'EOF'\n${output}\nEOF\nexit ${code}\n`,
      { mode: 0o755 }
    );

    return file;
  };

  it('runs the app bundle’s binary when there is no tailscale on PATH', async () => {
    const appCli = fakeCli(
      path.join(dir(), 'Tailscale.app/Contents/MacOS/Tailscale'),
      status()
    );

    const check = await checkTailscale({
      env: { PATH: path.join(dir(), 'bin') },
      appCli,
    });

    expect(stepOneText(check)).toBe('✓ this Mac');
  });

  it('prefers tailscale on PATH', async () => {
    fakeCli(
      path.join(dir(), 'bin', 'tailscale'),
      status({ BackendState: 'Stopped' })
    );
    const appCli = fakeCli(path.join(dir(), 'Tailscale'), status());

    const check = await checkTailscale({
      env: { PATH: path.join(dir(), 'bin') },
      appCli,
    });

    expect(check).toEqual({ state: 'signed-out' });
  });

  it('says Install Tailscale with neither', async () => {
    const check = await checkTailscale({
      env: { PATH: path.join(dir(), 'bin') },
      appCli: path.join(dir(), 'nowhere', 'Tailscale'),
    });

    expect(stepOneText(check)).toBe(INSTALL_TAILSCALE);
  });

  it('says Sign in to Tailscale on a non-zero exit, even with an up status', async () => {
    fakeCli(path.join(dir(), 'bin', 'tailscale'), status(), 1);

    const check = await checkTailscale({
      env: { PATH: path.join(dir(), 'bin') },
      appCli: path.join(dir(), 'nowhere', 'Tailscale'),
    });

    expect(stepOneText(check)).toBe(SIGN_IN_TO_TAILSCALE);
  });
});

const failure = (code: string): Error =>
  Object.assign(new Error(code), { code });

/**
 * 127.0.0.1 is the harness's own server, so it is never bound again here;
 * the Tailscale address answers what `outcomes` says, in turn.
 */
const scripted = (outcomes: ('ok' | 'EADDRNOTAVAIL' | 'EADDRINUSE')[]) => {
  const tried: { tries: string[] } = { tries: [] };
  const fake: Bind = async (_server, _port, address) => {
    if (address === '127.0.0.1') {
      return;
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

describe('listening on one more address, now', () => {
  it('refuses rather than retries, and keeps 127.0.0.1', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const script = scripted(['EADDRNOTAVAIL', 'EADDRINUSE']);
    const listeners = await startListeners({
      handle: (_request, response) => response.end('ok'),
      upgrade: () => undefined,
      port: 4580,
      log: jest.fn(),
      onFatal: jest.fn(),
      bind: script.fake,
    });

    await expect(listeners.listenOn('100.64.12.34')).rejects.toThrow(
      notOnThisComputer('100.64.12.34', 4580)
    );
    expect(notOnThisComputer('100.64.12.34', 4580)).toBe(
      "Can't listen on 100.64.12.34:4580: that address isn't on this computer."
    );
    jest.advanceTimersByTime(LISTEN_RETRY_MS * 2);
    await settle();
    expect(script.tries).toEqual(['EADDRNOTAVAIL']);

    await expect(listeners.listenOn('100.64.12.34')).rejects.toThrow(
      portInUse('100.64.12.34', 4580)
    );
    expect(listeners.addresses()).toEqual(['127.0.0.1:4580']);
    jest.useRealTimers();
    await listeners.close();
  });

  /**
   * Every extra bind waits until the test settles it, so the login-time
   * retry and listenOn can be made to race on the same address.
   */
  const held = () => {
    const state: {
      pending: { resolve: () => void; reject: (error: Error) => void }[];
    } = { pending: [] };
    const fake: Bind = (_server, _port, address) =>
      address === '127.0.0.1'
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            state.pending = [...state.pending, { resolve, reject }];
          });
    const bindNumber = (index: number) =>
      required(state.pending[index], `extra bind #${index + 1}`);

    return { fake, bindNumber };
  };

  /** Saved address, not up at login: the first extra bind is EADDRNOTAVAIL. */
  const retrying = async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const binds = held();
    const onFatal = jest.fn();
    const listeners = await startListeners({
      handle: (_request, response) => response.end('ok'),
      upgrade: () => undefined,
      port: 4580,
      listen: '100.64.12.34',
      log: jest.fn(),
      onFatal,
      bind: binds.fake,
    });
    binds.bindNumber(0).reject(failure('EADDRNOTAVAIL'));
    await settle();
    // The retry fires: its bind is now in flight.
    jest.advanceTimersByTime(LISTEN_RETRY_MS);
    await settle();

    return { binds, onFatal, listeners };
  };

  it('stays up when listenOn wins the race against the login-time retry', async () => {
    const { binds, onFatal, listeners } = await retrying();

    const listening = listeners.listenOn('100.64.12.34');
    binds.bindNumber(2).resolve();
    await listening;
    binds.bindNumber(1).reject(failure('EADDRINUSE'));
    await settle();

    expect(onFatal).not.toHaveBeenCalled();
    expect(listeners.addresses()).toEqual([
      '127.0.0.1:4580',
      '100.64.12.34:4580',
    ]);
    jest.useRealTimers();
    await listeners.close();
  });

  it('answers listenOn as listening when the login-time retry wins the race', async () => {
    const { binds, onFatal, listeners } = await retrying();

    const listening = listeners.listenOn('100.64.12.34');
    binds.bindNumber(1).resolve();
    await settle();
    binds.bindNumber(2).reject(failure('EADDRINUSE'));

    await expect(listening).resolves.toBeUndefined();
    expect(onFatal).not.toHaveBeenCalled();
    expect(listeners.addresses()).toEqual([
      '127.0.0.1:4580',
      '100.64.12.34:4580',
    ]);
    jest.useRealTimers();
    await listeners.close();
  });

  it('replaces an old extra address with the new one', async () => {
    const script = scripted(['ok', 'ok']);
    const listeners = await startListeners({
      handle: (_request, response) => response.end('ok'),
      upgrade: () => undefined,
      port: 4580,
      listen: '100.64.0.2',
      log: jest.fn(),
      onFatal: jest.fn(),
      bind: script.fake,
    });
    await settle();

    await listeners.listenOn('100.64.12.34');

    expect(listeners.addresses()).toEqual([
      '127.0.0.1:4580',
      '100.64.12.34:4580',
    ]);
    await listeners.close();
  });
});

describe('the Add a computer routes', () => {
  const fixture: {
    harness?: Harness;
    listeners?: Listeners;
    env?: Record<string, string>;
    tailscale?: TailscaleCheck;
    script?: ReturnType<typeof scripted>;
  } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');
  const listeners = (): Listeners => required(fixture.listeners, 'listeners');
  const env = (): Record<string, string> => required(fixture.env, 'env');
  const script = (): ReturnType<typeof scripted> =>
    required(fixture.script, 'script');

  const start = async (
    outcomes: ('ok' | 'EADDRNOTAVAIL' | 'EADDRINUSE')[]
  ): Promise<void> => {
    fixture.env = { LAMBDA_HOME: tempHome() };
    writeMachineConfig(
      { owner: { name: 'Leslie Knope', email: 'leslie@pawnee.gov' } },
      env()
    );
    fixture.tailscale = up();
    fixture.script = scripted(outcomes);
    fixture.harness = await startHarness({
      config: () => loadMachineConfig(env()),
      network: {
        tailscale: async () => required(fixture.tailscale, 'tailscale'),
        listenOn: (address) => listeners().listenOn(address),
        save: (fields) => saveListenFields(fields, env()),
      },
    });
    fixture.listeners = await startListeners({
      handle: harness().mothership.handle,
      upgrade: harness().mothership.upgrade,
      port: harness().port,
      log: jest.fn(),
      onFatal: jest.fn(),
      bind: script().fake,
    });
  };

  afterEach(async () => {
    await listeners().close();
    await harness().close();
    fs.rmSync(env().LAMBDA_HOME, { recursive: true, force: true });
  });

  it('refuses both routes without a session', async () => {
    await start(['ok']);

    const check = await harness().request('GET', '/api/computers/tailscale');
    const listen = await harness().request(
      'POST',
      '/api/computers/tailscale/listen'
    );

    expect([check.status, listen.status]).toEqual([401, 401]);
    expect(script().tries).toEqual([]);
  });

  it('checks Tailscale on the mothership and shows its address', async () => {
    await start(['ok']);
    const cookie = harness().signIn();

    const check = await harness().request('GET', '/api/computers/tailscale', {
      cookie,
    });

    expect(check.json()).toEqual({
      step: '✓ this Mac',
      state: 'up',
      address: '100.64.12.34',
      label: 'leslies-macbook',
    });
  });

  it('listens on the Tailscale address, saves it, and then answers requests addressed by the MagicDNS name', async () => {
    await start(['ok']);
    const cookie = harness().signIn();
    const { port } = harness();
    const host = `leslies-macbook.tail1234.ts.net:${port}`;

    // Addressed by the name before the write: not this mothership.
    expect(
      (await harness().request('GET', '/api/computers', { cookie, host }))
        .status
    ).toBe(403);

    const listen = await harness().request(
      'POST',
      '/api/computers/tailscale/listen',
      { cookie, body: JSON.stringify({ address: '0.0.0.0' }) }
    );

    expect(listen.json()).toEqual({
      ok: true,
      result: { server: `http://${host}` },
    });
    expect(script().tries).toEqual(['ok']);
    expect(loadMachineConfig(env())?.mothership).toEqual({
      listen: '100.64.12.34',
      host: 'leslies-macbook.tail1234.ts.net',
    });
    expect(listeners().addresses()).toEqual([
      `127.0.0.1:${port}`,
      `100.64.12.34:${port}`,
    ]);

    const read = await harness().request('GET', '/api/computers', {
      cookie,
      host,
    });
    const code = await harness().request('POST', '/api/computers/code', {
      cookie,
      host,
    });

    expect([read.status, code.status]).toEqual([200, 200]);
  });

  it('refuses to listen until Tailscale is up, writing nothing', async () => {
    await start(['ok']);
    fixture.tailscale = { state: 'signed-out' };

    const listen = await harness().request(
      'POST',
      '/api/computers/tailscale/listen',
      { cookie: harness().signIn() }
    );

    expect(listen.status).toBe(409);
    expect(listen.json().error).toBe(SIGN_IN_TO_TAILSCALE);
    expect(script().tries).toEqual([]);
    expect(loadMachineConfig(env())?.mothership).toBeUndefined();
  });

  it.each([
    ['EADDRINUSE' as const, portInUse],
    ['EADDRNOTAVAIL' as const, notOnThisComputer],
  ])(
    'answers a %s with its own line, keeps mothership.listen, and 127.0.0.1 still answers',
    async (outcome, line) => {
      await start([outcome]);
      const cookie = harness().signIn();

      const listen = await harness().request(
        'POST',
        '/api/computers/tailscale/listen',
        { cookie }
      );

      expect(listen.status).toBe(409);
      expect(listen.json().error).toBe(line('100.64.12.34', harness().port));
      expect(loadMachineConfig(env())?.mothership).toBeUndefined();
      expect(listeners().addresses()).toEqual([`127.0.0.1:${harness().port}`]);
      expect(
        (await harness().request('GET', '/api/computers', { cookie })).status
      ).toBe(200);
    }
  );
});
