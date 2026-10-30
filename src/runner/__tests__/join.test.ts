import * as fs from 'fs';
import * as path from 'path';
import { WebSocket } from 'ws';

import { required } from '../../__tests__/required';
import { runCli } from '../../__tests__/runCli';
import {
  type JoinDeps,
  NOT_JOINED,
  joinedLines,
  runJoin,
  runLeave,
  sendAsRunner,
  statusLines,
} from '../../commands/join';
import {
  loadMachineConfig,
  writeMachineConfig,
} from '../../config/machineConfig';
import {
  type Harness,
  connectRunner,
  eventually,
  startHarness,
  tempHome,
} from '../../mothership/__tests__/harness';
import {
  JOIN_CODE_REFUSED,
  createCode,
  redeemCode,
} from '../../mothership/pairing';
import {
  addRunner,
  getRunner,
  listRunners,
  projectByName,
  removeRunner,
} from '../../mothership/registry';
import { MOTHERSHIP_TYPES, RUNNER_TYPES } from '../../protocol';
import { createBackoff, reconnectDelay } from '../backoff';
import { createRunnerClient } from '../client';
import { generateRunnerKeys } from '../keys';
import {
  writeRunnerInfo,
  writeRunnerState,
  writeRunnerStatus,
} from '../localFiles';
import { createOutbox } from '../outbox';
import type { ServiceControl } from '../service';

const fakeService = (): ServiceControl & {
  installs: string[][];
  removed: number;
} => {
  const state: { installs: string[][]; removed: number; installed: boolean } = {
    installs: [],
    removed: 0,
    installed: false,
  };

  return {
    file: '/tmp/dev.lambda.runner.plist',
    get installs() {
      return state.installs;
    },
    get removed() {
      return state.removed;
    },
    installed: () => state.installed,
    install: (command) => {
      state.installs = [...state.installs, command];
      state.installed = true;
    },
    remove: () => {
      state.removed += 1;
      state.installed = false;
    },
    start: () => undefined,
    stop: () => undefined,
  };
};

describe('lambda join', () => {
  const fixture: {
    harness?: Harness;
    home?: string;
    env?: Record<string, string>;
  } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');
  const home = (): string => required(fixture.home, 'home');
  const env = (): Record<string, string> => required(fixture.env, 'env');

  beforeEach(async () => {
    fixture.harness = await startHarness();
    fixture.home = tempHome();
    fixture.env = { LAMBDA_HOME: home() };
  });

  afterEach(async () => {
    await harness().close();
    fs.rmSync(home(), { recursive: true, force: true });
  });

  const deps = (overrides: Partial<JoinDeps> = {}): JoinDeps => ({
    env: env(),
    fetch,
    service: fakeService(),
    computerName: () => "Leslie's Mac mini",
    runnerCommand: ['node', 'runner.js'],
    send: sendAsRunner,
    ...overrides,
  });

  it('registers the key and name, saves runner.id and mothership.url, installs the service', async () => {
    const { code } = createCode(harness().db, 'runner', harness().clock.now);
    const service = fakeService();
    const url = `http://127.0.0.1:${harness().port}`;

    const joined = await runJoin(code, { server: url }, deps({ service }));
    const config = loadMachineConfig(env());
    const runner = getRunner(harness().db, joined.runnerId);

    expect(joined).toMatchObject({
      owner: 'Leslie Knope',
      name: "Leslie's Mac mini",
    });
    expect(config?.runner?.id).toBe(joined.runnerId);
    expect(config?.mothership?.url).toBe(url);
    expect(fs.statSync(String(config?.runner?.keyPath)).mode & 0o777).toBe(
      0o600
    );
    expect(runner?.name).toBe("Leslie's Mac mini");
    expect(runner?.publicKey).toContain('BEGIN PUBLIC KEY');
    expect(service.installs).toEqual([['node', 'runner.js']]);
  });

  /** Leslie's project, its tickets in Linear. */
  const linearProject = (): string => {
    const folder = tempHome();
    fs.writeFileSync(
      path.join(folder, 'lambda.json'),
      JSON.stringify({
        tickets: {
          source: 'linear',
          team: 'PAWNEE',
          statuses: {
            planning: 'Planning',
            ready: 'Todo',
            building: 'In Progress',
            blocked: 'Blocked',
            done: 'Done',
            canceled: 'Canceled',
          },
        },
      })
    );

    return folder;
  };

  it('names the lambda connect commands a new computer still needs', async () => {
    const { code } = createCode(harness().db, 'runner', harness().clock.now);
    const folder = linearProject();

    const joined = await runJoin(
      code,
      { server: `http://127.0.0.1:${harness().port}` },
      deps()
    );

    expect(joinedLines(joined, { env: env(), cwd: folder })).toEqual([
      `✓ Joined Leslie Knope's Lambda as "Leslie's Mac mini"`,
      '✓ Runs in the background at login',
      'Next, connect this computer: lambda connect claude',
      '                             lambda connect linear',
    ]);
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it('prints neither line when this computer already has its keys', async () => {
    const { code } = createCode(harness().db, 'runner', harness().clock.now);
    const folder = linearProject();
    writeMachineConfig(
      {
        tokens: {
          claude: { value: 'claude-token-pawnee' },
          linear: 'lin_api_x',
        },
      },
      env()
    );

    const joined = await runJoin(
      code,
      { server: `http://127.0.0.1:${harness().port}` },
      deps()
    );

    expect(joinedLines(joined, { env: env(), cwd: folder })).toEqual([
      `✓ Joined Leslie Knope's Lambda as "Leslie's Mac mini"`,
      '✓ Runs in the background at login',
    ]);
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it('asks only for Claude outside a project, and names Jira’s site', () => {
    const folder = tempHome();
    const joined = { owner: 'Leslie Knope', name: "Leslie's Mac mini" };

    expect(joinedLines(joined, { env: env(), cwd: folder }).slice(2)).toEqual([
      'Next, connect this computer: lambda connect claude',
    ]);

    fs.writeFileSync(
      path.join(folder, 'lambda.json'),
      JSON.stringify({
        tickets: {
          source: 'jira',
          site: 'https://pawnee.atlassian.net',
          project: 'PARKS',
          statuses: {
            planning: 'Planning',
            ready: 'To Do',
            building: 'In Progress',
            blocked: 'Blocked',
            done: 'Done',
            canceled: 'Canceled',
          },
        },
      })
    );
    writeMachineConfig(
      { tokens: { claude: { value: 'claude-token-pawnee' } } },
      env()
    );

    expect(joinedLines(joined, { env: env(), cwd: folder }).slice(2)).toEqual([
      'Next, connect this computer: lambda connect jira --site https://pawnee.atlassian.net --email <your Jira email>',
    ]);
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it('says why it can’t name the tracker when lambda.json can’t be read', () => {
    const folder = tempHome();
    const joined = { owner: 'Leslie Knope', name: "Leslie's Mac mini" };
    fs.writeFileSync(path.join(folder, 'lambda.json'), '{ "tickets": ');

    const lines = joinedLines(joined, { env: env(), cwd: folder });

    expect(lines.slice(0, 3)).toEqual([
      `✓ Joined Leslie Knope's Lambda as "Leslie's Mac mini"`,
      '✓ Runs in the background at login',
      'Next, connect this computer: lambda connect claude',
    ]);
    expect(lines).toHaveLength(4);
    expect(lines[3]).toMatch(/^Can't tell which tracker to connect: /);
    expect(lines[3]).toContain(path.join(folder, 'lambda.json'));
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it('refuses a used join code, writing nothing', async () => {
    const { code } = createCode(harness().db, 'runner', harness().clock.now);
    const url = `http://127.0.0.1:${harness().port}`;
    await runJoin(code, { server: url }, deps());
    const configBefore = fs.readFileSync(
      path.join(home(), 'config.json'),
      'utf8'
    );
    const second = tempHome();

    await expect(
      runJoin(code, { server: url }, deps({ env: { LAMBDA_HOME: second } }))
    ).rejects.toThrow(JOIN_CODE_REFUSED);
    expect(JOIN_CODE_REFUSED).toBe(
      "That join code didn't work. Make a new one with Add a computer."
    );
    expect(fs.readdirSync(second)).toEqual([]);
    expect(fs.readFileSync(path.join(home(), 'config.json'), 'utf8')).toBe(
      configBefore
    );
    fs.rmSync(second, { recursive: true, force: true });
  });

  it('refuses to join again on a computer that already joined, writing nothing', async () => {
    const { code } = createCode(harness().db, 'runner', harness().clock.now);
    const url = `http://127.0.0.1:${harness().port}`;
    await runJoin(code, { server: url }, deps());
    const configBefore = fs.readFileSync(
      path.join(home(), 'config.json'),
      'utf8'
    );
    const second = createCode(harness().db, 'runner', harness().clock.now);

    await expect(runJoin(second.code, { server: url }, deps())).rejects.toThrow(
      'This computer is already part of a Lambda. Run lambda leave first.'
    );
    expect(fs.readFileSync(path.join(home(), 'config.json'), 'utf8')).toBe(
      configBefore
    );
    expect(listRunners(harness().db)).toHaveLength(1);
  });

  it("takes it all back when the login service can't be installed, so a retry can join", async () => {
    const { code } = createCode(harness().db, 'runner', harness().clock.now);
    writeMachineConfig({ mothership: { port: 4999 } }, env());
    const configBefore = fs.readFileSync(
      path.join(home(), 'config.json'),
      'utf8'
    );
    const service: ServiceControl = {
      ...fakeService(),
      install: () => {
        throw new Error('launchctl: Pawnee Parks and Rec is closed today');
      },
    };

    await expect(
      runJoin(
        code,
        { server: `http://127.0.0.1:${harness().port}` },
        deps({ service })
      )
    ).rejects.toThrow(
      "Couldn't set this computer to run Lambda at login: launchctl: Pawnee Parks and Rec is closed today. Nothing was kept; make a new join code with Add a computer and run lambda join again."
    );
    expect(fs.readdirSync(home())).toEqual(['config.json']);
    expect(fs.readFileSync(path.join(home(), 'config.json'), 'utf8')).toBe(
      configBefore
    );
    expect(listRunners(harness().db)).toEqual([]);
  });

  it('refuses a device code as a join code', async () => {
    const { code } = createCode(harness().db, 'device', harness().clock.now);

    await expect(
      runJoin(code, { server: `http://127.0.0.1:${harness().port}` }, deps())
    ).rejects.toThrow(JOIN_CODE_REFUSED);
  });

  it("says it couldn't reach a server that isn't there, and writes nothing", async () => {
    const service = fakeService();
    const closed = harness().port;
    await harness().close();
    fixture.harness = await startHarness();

    await expect(
      runJoin(
        'AAAA-AAAA',
        { server: `http://127.0.0.1:${closed}` },
        deps({ service })
      )
    ).rejects.toThrow(`Couldn't reach http://127.0.0.1:${closed}.`);
    expect(fs.readdirSync(home())).toEqual([]);

    // No --server and no mothership.url: 127.0.0.1 on the configured port
    // (a closed one — never a real mothership on this computer's 4580).
    writeMachineConfig({ mothership: { port: closed } }, env());
    const configBefore = fs.readFileSync(
      path.join(home(), 'config.json'),
      'utf8'
    );

    await expect(runJoin('AAAA-AAAA', {}, deps({ service }))).rejects.toThrow(
      `Couldn't reach http://127.0.0.1:${closed}.`
    );
    expect(fs.readdirSync(home())).toEqual(['config.json']);
    expect(fs.readFileSync(path.join(home(), 'config.json'), 'utf8')).toBe(
      configBefore
    );
    expect(service.installs).toEqual([]);
  });

  it('posts to --server, else mothership.url, else 127.0.0.1 on the port', async () => {
    const asked: { urls: string[] } = { urls: [] };
    const recording: typeof fetch = async (input) => {
      asked.urls = [...asked.urls, String(input)];

      return new Response(
        JSON.stringify({ ok: false, error: JOIN_CODE_REFUSED }),
        {
          status: 400,
        }
      );
    };

    await runJoin(
      'A',
      { server: 'http://100.64.0.2:4580' },
      deps({ fetch: recording })
    ).catch(() => undefined);
    writeMachineConfig(
      { mothership: { url: 'http://100.64.0.3:4580' } },
      env()
    );
    await runJoin('A', {}, deps({ fetch: recording })).catch(() => undefined);
    writeMachineConfig({ mothership: { port: 4999 } }, env());
    await runJoin('A', {}, deps({ fetch: recording })).catch(() => undefined);

    expect(asked.urls).toEqual([
      'http://100.64.0.2:4580/api/runners/join',
      'http://100.64.0.3:4580/api/runners/join',
      'http://127.0.0.1:4999/api/runners/join',
    ]);
  });
});

describe('the runner socket', () => {
  const fixture: { harness?: Harness } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');

  beforeEach(async () => {
    fixture.harness = await startHarness();
  });

  afterEach(() => harness().close());

  const closedBeforeAnything = async (runnerId: string, privateKey: string) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${harness().port}/api/runner/socket`
    );
    const seen: { types: string[] } = { types: [] };
    const { signChallenge } = await import('../keys');

    return new Promise<{ code: number; types: string[] }>((resolve) => {
      socket.on('message', (data) => {
        const message: {
          type: string;
          challenge?: string;
        } = JSON.parse(data.toString());
        seen.types = [...seen.types, message.type];

        if (message.type === 'challenge') {
          socket.send(
            JSON.stringify({
              type: 'auth',
              runnerId,
              signature: signChallenge(
                privateKey,
                Buffer.from(String(message.challenge), 'base64')
              ),
            })
          );
          // Sent at once after: must never be handled.
          socket.send(JSON.stringify({ type: 'leave', id: 'x' }));
        }
      });
      socket.on('close', (code) => resolve({ code, types: seen.types }));
    });
  };

  it('closes a socket signed with the wrong key before handling anything', async () => {
    const runner = await connectRunner(harness());
    await runner.next('owner');
    await runner.close();
    const wrong = generateRunnerKeys().privateKey;

    const result = await closedBeforeAnything(runner.runnerId, wrong);

    expect(result.code).toBe(4401);
    expect(result.types).toEqual(['challenge']);
    expect(getRunner(harness().db, runner.runnerId)).not.toBeNull();
  });

  it('closes a socket with an unknown runner id', async () => {
    const result = await closedBeforeAnything(
      'rnr_nobody',
      generateRunnerKeys().privateKey
    );

    expect(result).toEqual({ code: 4401, types: ['challenge'] });
  });

  it('logs and ignores a message of an unknown type, staying open', async () => {
    const runner = await connectRunner(harness());
    await runner.next('owner');

    runner.send({ type: 'telepathy' });
    await eventually(() =>
      harness().logs.some((line) => line.includes('"telepathy"'))
    );

    expect(runner.socket.readyState).toBe(WebSocket.OPEN);
    await runner.close();
  });

  it('pins the message types each side sends', () => {
    expect([...MOTHERSHIP_TYPES]).toEqual([
      'pod-new',
      'pod-action',
      'term-read',
      'term-keys',
      'process-read',
      'process-switch',
      'design-system-read',
      'design-system-make',
      'project-add',
      'project-new',
      'owner',
      'pod-file',
      'tickets-list',
      'tracker-projects',
      'tracker-views',
      'ticket-get',
      'ticket-talk',
      'building-start',
      'ticket-update',
      'ticket-create',
      'ticket-move',
      'plan-more',
      'diagnose',
    ]);
    expect([...RUNNER_TYPES]).toEqual([
      'result',
      'pod-state',
      'event',
      'runner-state',
      'project-link',
      'leave',
      'ticket-claim',
      'ticket-claims',
      'ticket-release',
      'ticket-shipped',
      'tracker-identity',
    ]);
  });

  it('sends the owner after the handshake, and again when an alias changes', async () => {
    const runner = await connectRunner(harness());
    const first = await runner.next('owner');

    expect(first).toMatchObject({
      name: 'Leslie Knope',
      email: 'leslie@pawnee.gov',
      aliases: [],
    });

    // `lambda account alias add`, run on the host: it writes the database
    // file; the mothership's tick notices and pushes the owner again.
    writeMachineConfig(
      { owner: { name: 'Leslie Knope', email: 'leslie@pawnee.gov' } },
      { LAMBDA_HOME: harness().home }
    );
    const added = await runCli(
      ['account', 'alias', 'add', 'lknope@pawnee.gov'],
      { LAMBDA_HOME: harness().home }
    );

    expect(added).toMatchObject({
      code: 0,
      out: '✓ lknope@pawnee.gov now counts as Leslie Knope',
    });
    await harness().mothership.tick();
    await eventually(
      () =>
        runner.received.filter((message) => message.type === 'owner').length ===
        2
    );

    expect(
      runner.received.filter((message) => message.type === 'owner')[1]
    ).toMatchObject({
      aliases: [{ kind: 'email', value: 'lknope@pawnee.gov' }],
    });
    await runner.close();
  });

  it('keeps who a computer is in its tracker, and hands every computer the map', async () => {
    const runner = await connectRunner(harness());
    const first = await runner.next('owner');
    const { name } = harness()
      .db.prepare<[string], { name: string }>(
        'SELECT name FROM runners WHERE id = ?'
      )
      .get(runner.runnerId) ?? { name: '' };

    // Only the owner, by the email they signed in with, before any report.
    expect(first).toMatchObject({
      assignees: {
        linear: { 'Leslie Knope': 'leslie@pawnee.gov' },
        computers: { [runner.runnerId]: name },
      },
    });

    runner.send({
      type: 'tracker-identity',
      id: 'who1',
      identities: [
        { tracker: 'linear', who: 'leslie-mac@pawnee.gov', name: 'Leslie Mac' },
      ],
    });
    await eventually(() =>
      runner.received.some(
        (message) => message.type === 'result' && message.id === 'who1'
      )
    );
    await harness().mothership.tick();
    await eventually(
      () =>
        runner.received.filter((message) => message.type === 'owner').length ===
        2
    );

    expect(
      runner.received.filter((message) => message.type === 'owner')[1]
    ).toMatchObject({
      assignees: {
        linear: {
          [name]: 'leslie-mac@pawnee.gov',
          'Leslie Knope': 'leslie@pawnee.gov',
        },
      },
    });

    // Renamed: the next tick hands out the map under its new name.
    harness()
      .db.prepare('UPDATE runners SET name = ? WHERE id = ?')
      .run('Leslie\u2019s office Mac', runner.runnerId);
    await harness().mothership.tick();
    await eventually(
      () =>
        runner.received.filter((message) => message.type === 'owner').length ===
        3
    );

    expect(
      runner.received.filter((message) => message.type === 'owner')[2]
    ).toMatchObject({
      assignees: {
        linear: { 'Leslie\u2019s office Mac': 'leslie-mac@pawnee.gov' },
      },
    });
    await runner.close();
  });

  it('links a joined runner’s folder (project-link) and unregisters it (leave)', async () => {
    const runner = await connectRunner(harness());
    await runner.next('owner');

    runner.send({
      type: 'project-link',
      id: 'ln1',
      name: 'Pawnee Parks site',
      folder: '/home/leslie/pawnee-parks',
    });
    await eventually(() =>
      runner.received.some(
        (message) => message.type === 'result' && message.id === 'ln1'
      )
    );

    expect(projectByName(harness().db, 'Pawnee Parks site')).not.toBeNull();
    expect(
      harness()
        .db.prepare('SELECT folder FROM runner_projects WHERE runner_id = ?')
        .all(runner.runnerId)
    ).toEqual([{ folder: '/home/leslie/pawnee-parks' }]);

    runner.send({ type: 'leave', id: 'bye' });
    await eventually(() => getRunner(harness().db, runner.runnerId) === null);
    await runner.close();
  });
});

describe('reconnecting', () => {
  it('waits 1, 2, 4, 8, 16, 30, 30 seconds after 7 drops in a row, and 1 after a connect', () => {
    const backoff = createBackoff();
    const delays = [1, 2, 3, 4, 5, 6, 7].map(() => backoff.next() / 1000);

    expect(delays).toEqual([1, 2, 4, 8, 16, 30, 30]);
    backoff.reset();
    expect(backoff.next()).toBe(1000);
    expect(reconnectDelay(0)).toBe(1000);
  });
});

describe('lambda leave and lambda status', () => {
  /** Never the real `lambda-system` window: that is this computer's runner. */
  const stopRunner = () => undefined;
  const fixture: {
    harness?: Harness;
    home?: string;
    env?: Record<string, string>;
  } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');
  const home = (): string => required(fixture.home, 'home');
  const env = (): Record<string, string> => required(fixture.env, 'env');

  beforeEach(async () => {
    fixture.harness = await startHarness();
    fixture.home = tempHome();
    fixture.env = { LAMBDA_HOME: home() };
  });

  afterEach(async () => {
    await harness().close();
    fs.rmSync(home(), { recursive: true, force: true });
  });

  it('removes the service and the key, and the runner row goes', async () => {
    const { code } = createCode(harness().db, 'runner', harness().clock.now);
    const service = fakeService();
    const joined = await runJoin(
      code,
      { server: `http://127.0.0.1:${harness().port}` },
      {
        env: env(),
        fetch,
        service,
        computerName: () => "Leslie's Mac mini",
        runnerCommand: ['node', 'runner.js'],
        send: sendAsRunner,
      }
    );
    const keyPath = String(loadMachineConfig(env())?.runner?.keyPath);

    const owner = await runLeave({
      env: env(),
      service,
      send: sendAsRunner,
      stopRunner,
    });

    expect(owner).toBe('Leslie Knope');
    expect(service.removed).toBe(1);
    expect(fs.existsSync(keyPath)).toBe(false);
    expect(getRunner(harness().db, joined.runnerId)).toBeNull();
    expect(listRunners(harness().db)).toEqual([]);
    expect(loadMachineConfig(env())?.runner).toBeUndefined();
  });

  const joinHere = async (): Promise<{ runnerId: string; keyPath: string }> => {
    const { code } = createCode(harness().db, 'runner', harness().clock.now);
    const joined = await runJoin(
      code,
      { server: `http://127.0.0.1:${harness().port}` },
      {
        env: env(),
        fetch,
        service: fakeService(),
        computerName: () => "Leslie's Mac mini",
        runnerCommand: ['node', 'runner.js'],
        send: sendAsRunner,
      }
    );

    return {
      runnerId: joined.runnerId,
      keyPath: String(loadMachineConfig(env())?.runner?.keyPath),
    };
  };
  const runnerFiles = ['outbox.jsonl', 'events-cursor.json', 'runner.pid'];

  it('stops the runner running in lambda-system before deleting its key', async () => {
    const { keyPath } = await joinHere();
    const seen: { keyThere: boolean[] } = { keyThere: [] };
    const recordKey = () => {
      seen.keyThere = [...seen.keyThere, fs.existsSync(keyPath)];
    };

    await runLeave({
      env: env(),
      service: fakeService(),
      send: sendAsRunner,
      stopRunner: recordKey,
    });

    expect(seen.keyThere).toEqual([true]);
    expect(fs.existsSync(keyPath)).toBe(false);
  });

  it('leaves a Lambda that no longer knows this computer, instead of dead-ending', async () => {
    const { runnerId, keyPath } = await joinHere();
    // The mothership's database was reset: this runner is gone there.
    removeRunner(harness().db, runnerId);
    const service = fakeService();

    await expect(
      runLeave({ env: env(), service, send: sendAsRunner, stopRunner })
    ).resolves.toBe('your Lambda');
    expect(service.removed).toBe(1);
    expect(fs.existsSync(keyPath)).toBe(false);
    expect(loadMachineConfig(env())?.runner).toBeUndefined();
  });

  it('names the way out when Lambda can’t be reached, and changes nothing', async () => {
    const { keyPath } = await joinHere();
    const config = loadMachineConfig(env());
    writeMachineConfig(
      { ...config, mothership: { url: 'http://127.0.0.1:1' } },
      env()
    );

    await expect(
      runLeave({
        env: env(),
        service: fakeService(),
        send: sendAsRunner,
        stopRunner,
      })
    ).rejects.toThrow(
      "Couldn't reach http://127.0.0.1:1. To take this computer out anyway, run lambda leave --local."
    );
    expect(fs.existsSync(keyPath)).toBe(true);
    expect(loadMachineConfig(env())?.runner).toBeDefined();
  });

  it('with --local, leaves on this computer without asking Lambda', async () => {
    const { keyPath } = await joinHere();
    const service = fakeService();
    const send = jest.fn(sendAsRunner);

    await expect(
      runLeave({ env: env(), service, send, stopRunner }, { local: true })
    ).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(service.removed).toBe(1);
    expect(fs.existsSync(keyPath)).toBe(false);
    expect(loadMachineConfig(env())?.runner).toBeUndefined();
  });

  it('takes the old Lambda’s outbox and cursor with it, so none reaches the next one', async () => {
    await joinHere();
    runnerFiles.forEach((name) =>
      fs.writeFileSync(path.join(home(), name), 'old')
    );

    await runLeave({
      env: env(),
      service: fakeService(),
      send: sendAsRunner,
      stopRunner,
    });

    expect(
      runnerFiles.filter((name) => fs.existsSync(path.join(home(), name)))
    ).toEqual([]);
  });

  it('prints the four lines of status', () => {
    writeMachineConfig({ runner: { id: 'rnr_3f9a', keyPath: '/k' } }, env());
    writeRunnerInfo({ name: "Leslie's Mac mini" }, env());
    writeRunnerStatus({ connected: true, at: 'now', pid: 1 }, env());

    // pid 1 stands in for the live runner.
    expect(
      statusLines(
        env(),
        () => '',
        (pid) => pid === 1
      )
    ).toEqual([
      "Computer    Leslie's Mac mini (rnr_3f9a)",
      'Connected   yes',
      'Codebase    none',
      'Services    none',
    ]);
  });

  it('names the project in status as the Computers screen does', () => {
    const folder = tempHome();
    fs.writeFileSync(path.join(folder, 'lambda.json'), '{}');
    fs.writeFileSync(
      path.join(folder, 'package.json'),
      '{"name":"sweetums-recipe-app"}'
    );
    writeMachineConfig({ runner: { id: 'rnr_3f9a', keyPath: '/k' } }, env());
    writeRunnerState({ current: folder }, env());

    expect(statusLines(env(), () => '')[2]).toBe(
      'Codebase    sweetums-recipe-app'
    );
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it('refuses status and leave on a computer that never joined', async () => {
    expect(() => statusLines(env(), () => '')).toThrow(NOT_JOINED);
    await expect(
      runLeave({
        env: env(),
        service: fakeService(),
        send: sendAsRunner,
        stopRunner,
      })
    ).rejects.toThrow(NOT_JOINED);
    expect(NOT_JOINED).toBe(
      "This computer isn't part of a Lambda. Run lambda join <code> first."
    );
  });
});

describe('the commands print their refusal and exit 1', () => {
  const fixture: { harness?: Harness; home?: string } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');
  const home = (): string => required(fixture.home, 'home');

  beforeEach(async () => {
    fixture.harness = await startHarness();
    fixture.home = tempHome();
  });

  afterEach(async () => {
    await harness().close();
    fs.rmSync(home(), { recursive: true, force: true });
  });

  it('lambda join with a used code', async () => {
    const { code } = createCode(harness().db, 'runner', harness().clock.now);
    redeemCode(harness().db, 'runner', code, harness().clock.now);

    const result = await runCli(
      ['join', code, '--server', `http://127.0.0.1:${harness().port}`],
      { LAMBDA_HOME: home() }
    );

    expect(result).toMatchObject({ code: 1, err: JOIN_CODE_REFUSED, out: '' });
    expect(fs.readdirSync(home())).toEqual([]);
  });

  it("lambda join with a server that isn't there", async () => {
    const closed = harness().port;
    await harness().close();
    fixture.harness = await startHarness();

    const result = await runCli(
      ['join', 'AAAA-AAAA', '--server', `http://127.0.0.1:${closed}`],
      { LAMBDA_HOME: home() }
    );

    expect(result).toMatchObject({
      code: 1,
      err: `Couldn't reach http://127.0.0.1:${closed}.`,
    });
    expect(fs.readdirSync(home())).toEqual([]);
  });

  it('lambda status and lambda leave on a computer that never joined', async () => {
    const status = await runCli(['status'], { LAMBDA_HOME: home() });
    const leave = await runCli(['leave'], { LAMBDA_HOME: home() });

    expect(status).toMatchObject({ code: 1, err: NOT_JOINED });
    expect(leave).toMatchObject({ code: 1, err: NOT_JOINED });
  });
});

describe('reconnecting, against a real mothership', () => {
  it('backs off 1 s then 2 s while it’s away, and starts again at 1 s after a connect', async () => {
    // A free port with nothing on it yet.
    const probe = await startHarness();
    const { port } = probe;
    await probe.close();
    const keys = generateRunnerKeys();
    const runnerId = 'rnr_reconnect';
    const scheduled: { delays: number[]; next: (() => void)[] } = {
      delays: [],
      next: [],
    };
    const outboxHome = tempHome();
    const client = createRunnerClient({
      url: `http://127.0.0.1:${port}`,
      runnerId,
      privateKey: keys.privateKey,
      outbox: createOutbox(path.join(outboxHome, 'outbox.jsonl')),
      handle: async () => null,
      log: () => undefined,
      schedule: (fn, ms) => {
        scheduled.delays = [...scheduled.delays, ms];
        scheduled.next = [...scheduled.next, fn];
      },
    });
    const reconnect = (index: number) =>
      required(scheduled.next[index], 'retry')();

    client.start();
    await eventually(() => scheduled.delays.length === 1);
    reconnect(0);
    await eventually(() => scheduled.delays.length === 2);

    const harness = await startHarness({ port });
    addRunner(
      harness.db,
      { id: runnerId, name: "Leslie's Mac mini", publicKey: keys.publicKey },
      1
    );
    reconnect(1);
    await eventually(() => client.isConnected());

    // The mothership goes away: the next wait starts over at 1 s.
    harness.mothership.close();
    await eventually(() => scheduled.delays.length === 3);

    expect(scheduled.delays).toEqual([1000, 2000, 1000]);
    client.stop();
    await harness.close();
    fs.rmSync(outboxHome, { recursive: true, force: true });
  });
});
