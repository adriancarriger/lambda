import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type Harness, startHarness } from '../../mothership/__tests__/harness';
import { REFUSED } from '../../mothership/gate';
import { listAliases } from '../../mothership/owner';
import { createClaudeConnector } from '../connectClaude';
import type { SetupState } from '../routes';
import { FAKE_TOKEN, createFakeSpawn } from './fakePty';

const SETUP_ROUTES: [string, string][] = [
  ['GET', '/api/setup/state'],
  ['GET', '/api/setup/folders'],
  ['POST', '/api/setup/claude'],
  ['POST', '/api/setup/claude/code'],
  ['POST', '/api/setup/project'],
  ['POST', '/api/setup/tickets'],
  ['POST', '/api/setup/tickets/you'],
];

const POSTS = SETUP_ROUTES.filter(([method]) => method === 'POST');

describe('the setup routes', () => {
  const opened: Harness[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((harness) => harness.close()));
  });

  const start = async () => {
    const home = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-setup-'))
    );
    const env = { LAMBDA_HOME: path.join(home, '.lambda'), PATH: '' };
    const claude = path.join(home, '.local', 'bin', 'claude');
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.writeFileSync(claude, '#!/bin/sh\n');
    fs.chmodSync(claude, 0o755);
    const { spawn, spawned } = createFakeSpawn();
    const git = jest.fn(() => '');
    const init = jest.fn(() => ({ code: 0 }));
    const harness = await startHarness({
      setup: {
        home,
        env,
        connector: createClaudeConnector({ spawn, home, env }),
        project: { git, init },
      },
    });
    opened.splice(opened.length, 0, harness);

    return { harness, home, env, spawned, git, init };
  };

  it.each(SETUP_ROUTES)('%s %s needs a session', async (method, route) => {
    const { harness } = await start();

    expect((await harness.request(method, route)).status).toBe(401);
  });

  it.each(POSTS)(
    '%s %s refuses another origin, and a non-JSON body, running nothing',
    async (method, route) => {
      const { harness, spawned, git } = await start();
      const cookie = harness.signIn();

      const crossOrigin = await harness.request(method, route, {
        cookie,
        origin: 'https://evil.example',
      });
      const textPlain = await harness.request(method, route, {
        cookie,
        contentType: 'text/plain',
      });

      expect(crossOrigin.status).toBe(403);
      expect(crossOrigin.json().error).toBe(REFUSED);
      expect(textPlain.status).toBe(415);
      expect(spawned).toEqual([]);
      expect(git).not.toHaveBeenCalled();
    }
  );

  it("answers 400 with zod's message for a bad project body, running no git", async () => {
    const { harness, git } = await start();

    const response = await harness.request('POST', '/api/setup/project', {
      cookie: harness.signIn(),
      body: JSON.stringify({ name: 42 }),
    });

    expect(response.status).toBe(400);
    expect(response.json().error).toBe('Expected string, received number');
    expect(git).not.toHaveBeenCalled();
  });

  it('answers the state with exactly its three keys, and never the token', async () => {
    const { harness, spawned } = await start();
    const cookie = harness.signIn();

    const before = await harness.request('GET', '/api/setup/state', { cookie });
    expect(Object.keys(before.json<SetupState>()).sort()).toEqual([
      'claudeExpiresOn',
      'steps',
      'ticketSource',
    ]);
    expect(before.json<SetupState>().steps.claude.done).toBe(false);

    expect(
      (await harness.request('POST', '/api/setup/claude', { cookie })).status
    ).toBe(200);
    spawned[0]?.emit(`${FAKE_TOKEN}\r\n`);
    spawned[0]?.exit(0);

    const after = await harness.request('GET', '/api/setup/state', { cookie });

    expect(after.text).not.toContain(FAKE_TOKEN);
    expect(after.json<SetupState>().steps.claude.done).toBe(true);
    expect(after.json<SetupState>().claudeExpiresOn).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
  });

  it('runs one Connect Claude at a time: a second POST is 409', async () => {
    const { harness, spawned } = await start();
    const cookie = harness.signIn();

    expect(
      (await harness.request('POST', '/api/setup/claude', { cookie })).status
    ).toBe(200);
    expect(
      (await harness.request('POST', '/api/setup/claude', { cookie })).status
    ).toBe(409);
    expect(spawned).toHaveLength(1);
  });

  it('refuses a project outside home with 403', async () => {
    const { harness, git, init } = await start();

    const response = await harness.request('POST', '/api/setup/project', {
      cookie: harness.signIn(),
      body: JSON.stringify({ folder: '/etc' }),
    });

    expect(response.status).toBe(403);
    expect(git).not.toHaveBeenCalled();
    expect(init).not.toHaveBeenCalled();
  });

  it('still runs the Project step when the browser download failed', async () => {
    const home = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-setup-browser-'))
    );
    fs.mkdirSync(path.join(home, 'parks'));
    const failed = {
      start: () => undefined,
      retry: () => undefined,
      state: () => ({ phase: 'failed' as const, lines: ['Error: ECONNRESET'] }),
    };
    const harness = await startHarness({
      setup: {
        home,
        env: { LAMBDA_HOME: path.join(home, '.lambda'), PATH: '' },
        chromium: failed,
        project: { git: () => '', init: () => ({ code: 0 }) },
      },
    });
    opened.splice(opened.length, 0, harness);
    const cookie = harness.signIn();

    const state = await harness.request('GET', '/api/setup/state', { cookie });
    const project = await harness.request('POST', '/api/setup/project', {
      cookie,
      body: JSON.stringify({ folder: path.join(home, 'parks') }),
    });

    expect(state.json<SetupState>().steps.browser).toEqual({
      phase: 'failed',
      lines: ['Error: ECONNRESET'],
    });
    expect(project.status).toBe(200);
  });

  it('lists folders under home', async () => {
    const { harness, home } = await start();
    fs.mkdirSync(path.join(home, 'code'));

    const response = await harness.request('GET', '/api/setup/folders?path=', {
      cookie: harness.signIn(),
    });

    expect(response.status).toBe(200);
    expect(
      response.json<{ result: { folders: string[] } }>().result.folders
    ).toEqual(['code']);
  });

  describe('who you are, asked when a tracker connects', () => {
    /** A codebase picked in setup, and Linear answering as `viewer`. */
    const connected = async (viewer: { name: string; email: string }) => {
      const home = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-setup-you-'))
      );
      const parks = path.join(home, 'parks');
      fs.mkdirSync(parks);
      fs.writeFileSync(
        path.join(parks, 'lambda.json'),
        '{\n  "tickets": { "source": "markdown" }\n}\n'
      );
      const fetch = jest.fn(
        async (_url: string | URL | Request, _init?: RequestInit) =>
          new Response(JSON.stringify({ data: { viewer } }))
      );
      const harness = await startHarness({
        setup: {
          home,
          env: { LAMBDA_HOME: path.join(home, '.lambda'), PATH: '' },
          project: { git: () => '', init: () => ({ code: 0 }) },
          fetch,
        },
      });
      opened.splice(opened.length, 0, harness);
      const cookie = harness.signIn();
      await harness.request('POST', '/api/setup/project', {
        cookie,
        body: JSON.stringify({ folder: parks }),
      });
      const connect = async () =>
        (
          await harness.request('POST', '/api/setup/tickets', {
            cookie,
            body: JSON.stringify({
              source: 'linear',
              apiKey: ['lin', 'api', 'pawnee'].join('_'),
            }),
          })
        ).json<{ result: { askWho: unknown } }>().result.askWho;

      return { harness, cookie, connect };
    };

    it('asks about a login that isn’t yours, offering your own email', async () => {
      const { connect } = await connected({
        name: 'Pawnee build bot',
        email: 'bot@pawnee.gov',
      });

      expect(await connect()).toEqual({
        login: { name: 'Pawnee build bot', email: 'bot@pawnee.gov' },
        yourEmail: 'leslie@pawnee.gov',
      });
    });

    it('asks nothing about your own login', async () => {
      const { connect } = await connected({
        name: 'Leslie Knope',
        email: 'Leslie@Pawnee.gov',
      });

      expect(await connect()).toBeNull();
    });

    it('counts a login you say is yours, and never asks about it again', async () => {
      const { harness, cookie, connect } = await connected({
        name: 'Leslie at home',
        email: 'leslie@home.example',
      });

      const you = await harness.request('POST', '/api/setup/tickets/you', {
        cookie,
        body: JSON.stringify({ login: ' Leslie@Home.example ' }),
      });

      expect(you.status).toBe(200);
      expect(you.json<{ result: unknown }>().result).toEqual({
        counts: 'leslie@home.example',
      });
      expect(listAliases(harness.db)).toEqual([
        { kind: 'email', value: 'leslie@home.example' },
      ]);
      expect(await connect()).toBeNull();
    });

    it('refuses an empty login', async () => {
      const { harness, cookie } = await connected({
        name: 'Pawnee build bot',
        email: 'bot@pawnee.gov',
      });

      const you = await harness.request('POST', '/api/setup/tickets/you', {
        cookie,
        body: JSON.stringify({ login: '   ' }),
      });

      expect(you.status).toBe(400);
      expect(listAliases(harness.db)).toEqual([]);
    });
  });
});
