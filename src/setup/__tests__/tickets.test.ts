import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadMachineConfig } from '../../config/machineConfig';
import { loadProjectConfig } from '../../config/projectConfig';
import { TicketsBody } from '../schemas';
import {
  JIRA_SITE_HTTPS,
  KEY_DIDNT_WORK,
  connectTickets,
  prefixFromName,
} from '../tickets';

const KEY_FOR_SCHEMA = ['lin', 'api', 'pawneeparks'].join('_');

describe("the Tickets step's body", () => {
  it.each([
    ['a Linear key', { source: 'linear', apiKey: `${KEY_FOR_SCHEMA}\nx` }],
    [
      'a Jira token',
      {
        source: 'jira',
        site: 'https://pawnee.atlassian.net',
        email: 'ann@pawnee.gov',
        apiToken: 'pawnee\r\ntoken',
      },
    ],
  ])('refuses %s with a line break or space inside it', (_what, body) => {
    expect(TicketsBody.safeParse(body).success).toBe(false);
  });
});

const project = (lambdaJson: string) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-tickets-'));
  const root = path.join(home, 'pawnee');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'lambda.json'), lambdaJson);
  const env = { LAMBDA_HOME: path.join(home, '.lambda') };

  return { root, env };
};

const MARKDOWN = '{\n  "tickets": { "source": "markdown" }\n}\n';

const answer = (status: number, body: unknown) =>
  jest.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status })
  );

const KEY = ['lin', 'api', 'pawneeparks'].join('_');

describe('the Tickets step', () => {
  it('gives markdown tickets a prefix from the project name, so planning can create them', async () => {
    const { root, env } = project('{\n  "name": "pawnee-parks-app"\n}\n');

    await connectTickets(root, { source: 'markdown' }, { env });

    expect(loadProjectConfig(root)?.config.tickets).toEqual({
      source: 'markdown',
      prefix: 'PAWNEE',
    });
  });

  it('adds the prefix to a markdown project set up without one, and keeps one it has', async () => {
    const without = project(MARKDOWN);

    await connectTickets(without.root, { source: 'markdown' }, without);

    // No name: the folder's.
    expect(loadProjectConfig(without.root)?.config.tickets?.prefix).toBe(
      'PAWNEE'
    );

    const own =
      '{\n  "tickets": { "source": "markdown", "prefix": "EAGLE" }\n}\n';
    const kept = project(own);

    await connectTickets(kept.root, { source: 'markdown' }, kept);

    expect(fs.readFileSync(path.join(kept.root, 'lambda.json'), 'utf8')).toBe(
      own
    );
  });

  it.each([
    ['Lambda trial', 'LAMBDA'],
    ['  ice-town 2 ', 'ICE'],
    ['!!!', 'TICKET'],
  ])('makes the prefix for %j: %s', (name, prefix) => {
    expect(prefixFromName(name)).toBe(prefix);
  });

  it("shows That key didn't work for a refused Linear key, and saves nothing", async () => {
    const { root, env } = project(MARKDOWN);
    const fetch = answer(401, { errors: [{ message: 'no' }] });

    expect(
      await connectTickets(
        root,
        { source: 'linear', apiKey: KEY },
        { env, fetch }
      )
    ).toEqual({ ok: false, error: KEY_DIDNT_WORK });
    expect(loadMachineConfig(env)).toBeNull();
    expect(fs.readFileSync(path.join(root, 'lambda.json'), 'utf8')).toBe(
      MARKDOWN
    );
  });

  it("treats Linear's 400 AUTHENTICATION_ERROR as a bad key", async () => {
    const { root, env } = project(MARKDOWN);
    const fetch = answer(400, {
      errors: [
        {
          message: 'Authentication required',
          extensions: { code: 'AUTHENTICATION_ERROR' },
        },
      ],
    });

    expect(
      await connectTickets(
        root,
        { source: 'linear', apiKey: KEY },
        { env, fetch }
      )
    ).toEqual({ ok: false, error: KEY_DIDNT_WORK });
  });

  it('connects a good Linear key: the name, the key saved, lambda.json naming linear', async () => {
    const { root, env } = project(MARKDOWN);
    const fetch = answer(200, {
      data: { viewer: { name: 'Leslie Knope', email: 'leslie@pawnee.gov' } },
    });

    expect(
      await connectTickets(
        root,
        { source: 'linear', apiKey: KEY },
        { env, fetch }
      )
    ).toEqual({
      ok: true,
      connectedAs: 'Leslie Knope',
      login: { name: 'Leslie Knope', email: 'leslie@pawnee.gov' },
    });
    expect(loadMachineConfig(env)?.tokens?.linear).toBe(KEY);
    expect(loadMachineConfig(env)?.firstRun?.projects[root]?.tickets).toBe(
      true
    );
    expect(loadProjectConfig(root)?.config.tickets.source).toBe('linear');
    expect(
      fs.readFileSync(path.join(root, 'lambda.json'), 'utf8')
    ).not.toContain(KEY);

    const [url, init] = fetch.mock.calls[0] ?? [''];
    expect(url).toBe('https://api.linear.app/graphql');
    expect(String(init?.body)).toContain('viewer { name email }');
  });

  it('refuses a Jira key Jira answers 403 for, and saves nothing', async () => {
    const { root, env } = project(MARKDOWN);
    const fetch = answer(403, {});

    expect(
      await connectTickets(
        root,
        {
          source: 'jira',
          site: 'https://pawnee.atlassian.net',
          email: 'leslie@pawnee.gov',
          apiToken: 'pawnee-token',
        },
        { env, fetch }
      )
    ).toEqual({ ok: false, error: KEY_DIDNT_WORK });
    expect(loadMachineConfig(env)).toBeNull();
  });

  it("checks Jira's myself with basic auth, and keeps the site in lambda.json", async () => {
    const { root, env } = project(MARKDOWN);
    // A Jira site can hide emails: the login is then its name alone.
    const fetch = answer(200, { displayName: 'Ann Perkins' });

    expect(
      await connectTickets(
        root,
        {
          source: 'jira',
          site: 'https://pawnee.atlassian.net/',
          email: 'ann@pawnee.gov',
          apiToken: 'pawnee-token',
        },
        { env, fetch }
      )
    ).toEqual({
      ok: true,
      connectedAs: 'Ann Perkins',
      login: { name: 'Ann Perkins', email: null },
    });

    const [url, init] = fetch.mock.calls[0] ?? [''];
    expect(url).toBe('https://pawnee.atlassian.net/rest/api/3/myself');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Basic ${Buffer.from('ann@pawnee.gov:pawnee-token').toString('base64')}`
    );
    expect(loadProjectConfig(root)?.config.tickets).toMatchObject({
      source: 'jira',
      site: 'https://pawnee.atlassian.net/',
    });
    expect(loadMachineConfig(env)?.tokens?.jira).toEqual({
      email: 'ann@pawnee.gov',
      apiToken: 'pawnee-token',
    });
  });

  it.each([
    ['a 503', () => answer(503, {}), "Couldn't reach Linear (503)"],
    [
      'ECONNREFUSED',
      () =>
        jest.fn(async () => {
          throw new TypeError('fetch failed', {
            cause: Object.assign(new Error('connect'), {
              code: 'ECONNREFUSED',
            }),
          });
        }),
      "Couldn't reach Linear (ECONNREFUSED)",
    ],
  ])(
    'says it couldn’t reach Linear on %s, saving nothing',
    async (_what, make, error) => {
      const { root, env } = project(MARKDOWN);

      expect(
        await connectTickets(
          root,
          { source: 'linear', apiKey: KEY },
          { env, fetch: make() }
        )
      ).toEqual({ ok: false, error });
      expect(loadMachineConfig(env)).toBeNull();
    }
  );

  it('never echoes a failed request’s message, which can carry the key', async () => {
    const { root, env } = project(MARKDOWN);
    const fetch = jest.fn(async () => {
      throw new TypeError(
        `Headers.append: "${KEY}\nx" is an invalid header value.`
      );
    });

    const result = await connectTickets(
      root,
      { source: 'linear', apiKey: `${KEY}\nx` },
      { env, fetch }
    );

    expect(result).toEqual({
      ok: false,
      error: "Couldn't reach Linear (TypeError)",
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('says it timed out after the 10 s limit', async () => {
    const { root, env } = project(MARKDOWN);
    const fetch = jest.fn(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });

    expect(
      await connectTickets(
        root,
        { source: 'linear', apiKey: KEY },
        { env, fetch }
      )
    ).toEqual({ ok: false, error: "Couldn't reach Linear (timed out)" });
  });

  it.each([
    ['a 503', () => answer(503, {}), "Couldn't reach Jira (503)"],
    [
      'ECONNREFUSED',
      () =>
        jest.fn(async () => {
          throw new TypeError('fetch failed', {
            cause: Object.assign(new Error('connect'), {
              code: 'ECONNREFUSED',
            }),
          });
        }),
      "Couldn't reach Jira (ECONNREFUSED)",
    ],
  ])(
    'says it couldn’t reach Jira on %s, saving nothing',
    async (_what, make, error) => {
      const { root, env } = project(MARKDOWN);

      expect(
        await connectTickets(
          root,
          {
            source: 'jira',
            site: 'https://pawnee.atlassian.net',
            email: 'ann@pawnee.gov',
            apiToken: 'pawnee-token',
          },
          { env, fetch: make() }
        )
      ).toEqual({ ok: false, error });
      expect(loadMachineConfig(env)).toBeNull();
    }
  );

  it('refuses an http:// Jira site before any request', async () => {
    const { root, env } = project(MARKDOWN);
    const fetch = answer(200, { displayName: 'Ann Perkins' });

    expect(
      await connectTickets(
        root,
        {
          source: 'jira',
          site: 'http://pawnee.atlassian.net',
          email: 'ann@pawnee.gov',
          apiToken: 'pawnee-token',
        },
        { env, fetch }
      )
    ).toEqual({ ok: false, error: JIRA_SITE_HTTPS });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('leaves a lambda.json that already names linear byte-for-byte, writing only the key', async () => {
    const original = [
      '{',
      '    "tickets": {',
      '        "statuses": { "planning": "Ideas", "ready": "Up next", "building": "Doing",',
      '          "blocked": "Stuck", "done": "Shipped", "canceled": "Dropped" },',
      '        "source":   "linear",',
      '        "labels": { "hotkey": "Hot" },',
      '        "team": "PAWNEE"',
      '    },',
      '    "app": { "start": "npm run dev" }',
      '}',
      '',
    ].join('\n');
    const { root, env } = project(original);
    const file = path.join(root, 'lambda.json');
    const before = fs.statSync(file).mtimeMs;
    const fetch = answer(200, { data: { viewer: { name: 'Leslie Knope' } } });

    await connectTickets(
      root,
      { source: 'linear', apiKey: KEY },
      { env, fetch }
    );

    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.statSync(file).mtimeMs).toBe(before);
    expect(loadMachineConfig(env)?.tokens?.linear).toBe(KEY);
  });

  it('rewrites a markdown lambda.json to name linear, with statuses it accepts', async () => {
    const { root, env } = project(MARKDOWN);
    const fetch = answer(200, { data: { viewer: { name: 'Leslie Knope' } } });

    await connectTickets(
      root,
      { source: 'linear', apiKey: KEY },
      { env, fetch }
    );

    expect(loadProjectConfig(root)?.config.tickets.source).toBe('linear');
    expect(loadProjectConfig(root)?.config.tickets.statuses?.ready).toBe(
      'Todo'
    );
  });
});
