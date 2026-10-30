import * as fs from 'fs';

import { writeMachineConfig } from '../../config/machineConfig';
import { tempHome } from '../../mothership/__tests__/harness';
import { NOT_THE_HOST, USAGE, runComputer } from '../computer';

/**
 * `lambda computer`: from the computer running Lambda, read another one. It
 * signs in with a fresh login link, as `lambda open` does.
 */
describe('lambda computer', () => {
  const made: string[] = [];
  const home = (): string => {
    const one = tempHome();
    made.splice(made.length, 0, one);

    return one;
  };

  afterEach(() => {
    made
      .splice(0)
      .forEach((one) => fs.rmSync(one, { recursive: true, force: true }));
  });

  const fake = (answers: Record<string, unknown>) => {
    const asked: { url: string; cookie: string | null }[] = [];
    const posted: { route: string; origin: string | null; body: unknown }[] =
      [];
    const fetcher = async (
      input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      asked.splice(asked.length, 0, { url, cookie: headers.get('cookie') });

      if (init?.method === 'POST') {
        posted.splice(posted.length, 0, {
          route: url.replace('http://127.0.0.1:4580', ''),
          origin: headers.get('origin'),
          body: JSON.parse(String(init.body)),
        });

        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      if (url.includes('/auth/link')) {
        return new Response(null, {
          status: 303,
          headers: { 'set-cookie': 'lambda_session=s3cr3t; HttpOnly; Path=/' },
        });
      }

      const route = url.replace('http://127.0.0.1:4580', '');
      const answer = answers[route];

      return answer === undefined
        ? new Response(JSON.stringify({ error: 'No computer tom' }), {
            status: 404,
          })
        : new Response(JSON.stringify(answer), { status: 200 });
    };

    return { asked, posted, fetcher };
  };

  const deps = (env: Record<string, string>, fetcher: typeof fetch) => ({
    env,
    fetch: fetcher,
    mint: (port: number) => `http://127.0.0.1:${port}/auth/link?t=once`,
  });

  it('signs in with a login link, then reads that computer with the session', async () => {
    const { asked, fetcher } = fake({
      '/api/computers/diagnose?computer=Sam+J&action=pod&podId=build-3f2c': {
        podId: 'build-3f2c',
      },
    });

    const printed = await runComputer(
      ['Sam J', 'pod', 'build-3f2c'],
      deps({ LAMBDA_HOME: home() }, fetcher)
    );

    expect(JSON.parse(printed)).toEqual({ podId: 'build-3f2c' });
    expect(asked).toEqual([
      { url: 'http://127.0.0.1:4580/auth/link?t=once', cookie: null },
      {
        url: 'http://127.0.0.1:4580/api/computers/diagnose?computer=Sam+J&action=pod&podId=build-3f2c',
        cookie: 'lambda_session=s3cr3t',
      },
    ]);
  });

  it('lists every computer with no arguments', async () => {
    const { fetcher } = fake({
      '/api/computers': {
        computers: [
          { id: 'rnr_1', name: 'Adrian’s Mac mini', connected: true },
          { id: 'rnr_2', name: 'Sam J', connected: false },
        ],
      },
    });

    expect(await runComputer([], deps({ LAMBDA_HOME: home() }, fetcher))).toBe(
      'Adrian’s Mac mini  online  rnr_1\nSam J  offline  rnr_2'
    );
  });

  it("says the runner's error, not a stack", async () => {
    const { fetcher } = fake({});

    await expect(
      runComputer(['tom', 'status'], deps({ LAMBDA_HOME: home() }, fetcher))
    ).rejects.toThrow('No computer tom');
  });

  it('refuses an action it does not have', async () => {
    const { fetcher } = fake({});

    await expect(
      runComputer(['Sam J', 'exec'], deps({ LAMBDA_HOME: home() }, fetcher))
    ).rejects.toThrow(USAGE);
  });

  it("pauses and resumes a pod through the app's own routes, from its own origin", async () => {
    const { posted, fetcher } = fake({});
    const env = { LAMBDA_HOME: home() };

    expect(
      await runComputer(['Sam J', 'pause', 'build-3f2c'], deps(env, fetcher))
    ).toBe('Paused build-3f2c.');
    expect(
      await runComputer(['Sam J', 'resume', 'build-3f2c'], deps(env, fetcher))
    ).toBe('Resumed build-3f2c.');
    expect(posted).toEqual([
      {
        route: '/api/pause',
        origin: 'http://127.0.0.1:4580',
        body: { podId: 'build-3f2c' },
      },
      {
        route: '/api/resume',
        origin: 'http://127.0.0.1:4580',
        body: { podId: 'build-3f2c' },
      },
    ]);
  });

  it("presses Esc in an agent's window, and says something to it, then Enter", async () => {
    const { posted, fetcher } = fake({});
    const env = { LAMBDA_HOME: home() };

    await runComputer(
      ['Sam J', 'esc', 'build-3f2c', 'dev'],
      deps(env, fetcher)
    );
    await runComputer(
      ['Sam J', 'say', 'build-3f2c', 'dev', 'git', 'status'],
      deps(env, fetcher)
    );

    expect(posted.map(({ body }) => body)).toEqual([
      { podId: 'build-3f2c', window: 'dev', hex: ['1b'] },
      {
        podId: 'build-3f2c',
        window: 'dev',
        // "git status"
        hex: ['67', '69', '74', '20', '73', '74', '61', '74', '75', '73'],
      },
      { podId: 'build-3f2c', window: 'dev', hex: ['0d'] },
    ]);
  });

  it('refuses esc or say without a window, or say without words, before signing in', async () => {
    const { asked, fetcher } = fake({});
    const env = { LAMBDA_HOME: home() };

    await expect(
      runComputer(['Sam J', 'esc', 'build-3f2c'], deps(env, fetcher))
    ).rejects.toThrow(USAGE);
    await expect(
      runComputer(['Sam J', 'say', 'build-3f2c', 'dev'], deps(env, fetcher))
    ).rejects.toThrow(USAGE);
    expect(asked).toEqual([]);
  });

  it('works only on the computer running Lambda', async () => {
    const lambdaHome = home();
    writeMachineConfig(
      { mothership: { url: 'http://adrians-mac-mini:4580' } },
      { LAMBDA_HOME: lambdaHome }
    );
    const { asked, fetcher } = fake({});

    await expect(
      runComputer(
        ['Sam J', 'status'],
        deps({ LAMBDA_HOME: lambdaHome }, fetcher)
      )
    ).rejects.toThrow(NOT_THE_HOST);
    expect(asked).toEqual([]);
  });
});
