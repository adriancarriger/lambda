import * as fs from 'fs';
import * as path from 'path';

import { required } from '../../__tests__/required';
import { NOT_RUNNING, NOT_THE_HOST, runOpen } from '../../commands/open';
import { writeMachineConfig } from '../../config/machineConfig';
import { ensureHostRunner } from '../../runner/hostRunner';
import { generateRunnerKeys } from '../../runner/keys';
import { openDb } from '../db';
import { mintLoginLink, writeLoginLink } from '../loginLink';
import { ownerFromConfig } from '../owner';
import {
  CODE_REFUSED,
  TOO_MANY_TRIES,
  createCode,
  redeemWithLockout,
} from '../pairing';
import { listRunners } from '../registry';
import { type Harness, startHarness, tempHome } from './harness';

const MINUTE = 60_000;

const count = (harness: Harness, table: string): number => {
  const row = harness.db
    .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
    .get();

  if (row === undefined) {
    throw new Error(`No count from ${table}`);
  }

  return row.n;
};

describe('the lambda open login link', () => {
  const fixture: { harness?: Harness } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');

  beforeEach(async () => {
    fixture.harness = await startHarness();
  });

  afterEach(() => harness().close());

  it('signs in once, then only redirects', async () => {
    const token = writeLoginLink(harness().db, harness().clock.now);

    const first = await harness().request('GET', `/auth/link?t=${token}`);
    const second = await harness().request('GET', `/auth/link?t=${token}`);

    expect(first.status).toBe(303);
    expect(first.headers.location).toBe('/');
    expect(first.headers['set-cookie']?.[0]).toMatch(/^lambda_session=/);
    expect(second.status).toBe(303);
    expect(second.headers.location).toBe('/');
    expect(second.headers['set-cookie']).toBeUndefined();
    expect(count(harness(), 'sessions')).toBe(1);
  });

  it('does nothing after 60 seconds', async () => {
    const token = writeLoginLink(harness().db, harness().clock.now);
    harness().clock.now += 61_000;

    const late = await harness().request('GET', `/auth/link?t=${token}`);

    expect(late.status).toBe(303);
    expect(late.headers.location).toBe('/');
    expect(late.headers['set-cookie']).toBeUndefined();
    expect(count(harness(), 'sessions')).toBe(0);
  });

  it('has no route that mints a login link', () => {
    expect(
      harness().mothership.routes.filter((route) =>
        /link|login/.test(String(route.path))
      )
    ).toEqual([]);
  });

  it('mints through the database file (lambda open)', async () => {
    const url = mintLoginLink(path.join(harness().home, 'mothership.db'), {
      port: harness().port,
      now: harness().clock.now,
    });
    const link = new URL(url);

    expect(link.origin).toBe(`http://127.0.0.1:${harness().port}`);
    expect(count(harness(), 'login_links')).toBe(1);

    const signed = await harness().request(
      'GET',
      `${link.pathname}${link.search}`
    );

    expect(signed.headers['set-cookie']).toBeDefined();
  });
});

describe('pairing codes', () => {
  const fixture: { harness?: Harness } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');

  beforeEach(async () => {
    fixture.harness = await startHarness();
  });

  afterEach(() => harness().close());

  const pair = (code: string) =>
    harness().request('POST', '/api/auth/pair', {
      body: JSON.stringify({ code }),
    });

  it('works once, ignoring case, spaces and the hyphen', async () => {
    const { code } = createCode(harness().db, 'device', harness().clock.now);

    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);

    const typed = ` ${code.toLowerCase().replace('-', ' ')} `;
    const first = await pair(typed);

    expect(first.status).toBe(200);
    expect(first.headers['set-cookie']?.[0]).toMatch(/^lambda_session=/);
    expect(count(harness(), 'sessions')).toBe(1);
  });

  it('answers a wrong, an expired and a used code byte for byte the same', async () => {
    const used = createCode(harness().db, 'device', harness().clock.now).code;
    const expired = createCode(
      harness().db,
      'device',
      harness().clock.now
    ).code;
    await pair(used);
    harness().clock.now += 10 * MINUTE + 1;

    const wrong = await pair('ZZZZ-ZZZZ');
    const late = await pair(expired);
    const again = await pair(used);

    expect(wrong.status).toBe(400);
    expect(wrong.text).toBe(JSON.stringify({ ok: false, error: CODE_REFUSED }));
    expect(late.text).toBe(wrong.text);
    expect(again.text).toBe(wrong.text);
    expect(late.status).toBe(wrong.status);
    expect(again.status).toBe(wrong.status);
  });

  it('locks an address out after five refused codes, for 10 minutes', async () => {
    const { code } = createCode(harness().db, 'device', harness().clock.now);
    await ['A', 'B', 'C', 'D', 'E'].reduce(async (done, letter) => {
      await done;
      await pair(`${letter}AAA-AAAA`);
    }, Promise.resolve());

    const locked = await pair(code);

    expect(locked.status).toBe(429);
    expect(locked.json().error).toBe(TOO_MANY_TRIES);
    expect(count(harness(), 'sessions')).toBe(0);

    harness().clock.now += 10 * MINUTE + 1;
    // The first code has expired by now too: a fresh one.
    const later = await pair(
      createCode(harness().db, 'device', harness().clock.now).code
    );

    expect(later.status).toBe(200);
  });

  it('shares the lockout with lambda join', async () => {
    const join = createCode(harness().db, 'runner', harness().clock.now).code;
    await ['A', 'B', 'C', 'D', 'E'].reduce(async (done, letter) => {
      await done;
      await pair(`${letter}AAA-AAAA`);
    }, Promise.resolve());

    const joined = await harness().request('POST', '/api/runners/join', {
      body: JSON.stringify({
        code: join,
        name: "Leslie's Mac mini",
        publicKey: generateRunnerKeys().publicKey,
      }),
    });

    expect(joined.status).toBe(429);
    expect(listRunners(harness().db)).toEqual([]);
  });

  it('counts by address: another one still gets in', () => {
    const { code } = createCode(harness().db, 'device', harness().clock.now);
    ['1', '2', '3', '4', '5'].forEach((digit) =>
      redeemWithLockout(
        harness().db,
        'device',
        `${digit}AAA-AAAA`,
        '100.64.0.9',
        harness().clock.now
      )
    );

    expect(
      redeemWithLockout(
        harness().db,
        'device',
        code,
        '100.64.0.9',
        harness().clock.now
      )
    ).toBe('locked');
    expect(
      redeemWithLockout(
        harness().db,
        'device',
        code,
        '100.64.0.7',
        harness().clock.now
      )
    ).toBe('ok');
  });

  it("won't take a device code as a join code, or the other way round", () => {
    const device = createCode(harness().db, 'device', harness().clock.now).code;
    const runner = createCode(harness().db, 'runner', harness().clock.now).code;

    expect(
      redeemWithLockout(
        harness().db,
        'runner',
        device,
        'a',
        harness().clock.now
      )
    ).toBe('refused');
    expect(
      redeemWithLockout(
        harness().db,
        'device',
        runner,
        'a',
        harness().clock.now
      )
    ).toBe('refused');
  });
});

describe('the host and its owner', () => {
  const made: { homes: string[] } = { homes: [] };

  afterEach(() => {
    const done = made.homes;
    made.homes = [];
    done.forEach((home) => fs.rmSync(home, { recursive: true, force: true }));
  });

  const home = (): string => {
    const fresh = tempHome();
    made.homes = [...made.homes, fresh];

    return fresh;
  };

  it("registers this computer's runner on the first start, once, with no owner row", () => {
    const lambdaHome = home();
    const env = { LAMBDA_HOME: lambdaHome };
    writeMachineConfig({ owner: { name: 'Leslie Knope' } }, env);
    const db = openDb(path.join(lambdaHome, 'mothership.db'));

    const first = ensureHostRunner(db, {
      name: "Leslie's MacBook",
      now: 1,
      env,
    });
    const second = ensureHostRunner(db, {
      name: "Leslie's MacBook",
      now: 2,
      env,
    });

    expect(second).toBe(first);
    expect(listRunners(db).map((runner) => runner.name)).toEqual([
      "Leslie's MacBook",
    ]);
    expect(fs.statSync(path.join(lambdaHome, 'runner.key')).mode & 0o777).toBe(
      0o600
    );
    expect(
      db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table'"
        )
        .all()
        .map((row) => row.name)
        .filter((name) => /owner|account/.test(name))
    ).toEqual([]);
    db.close();
  });

  it('reads the owner from the config, trimming and lowercasing the email', () => {
    expect(
      ownerFromConfig({
        owner: { name: 'Leslie Knope', email: ' Leslie@Pawnee.gov ' },
      })
    ).toEqual({
      name: 'Leslie Knope',
      initials: 'LK',
      email: 'leslie@pawnee.gov',
    });
    expect(
      ownerFromConfig({ owner: { name: 'Leslie Knope' } }).email
    ).toBeNull();
  });

  it('has no account_id column in any table', () => {
    const db = openDb(path.join(home(), 'mothership.db'));
    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
      )
      .all()
      .map((row) => row.name);
    const columns = tables.flatMap((table) =>
      db
        .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
        .all()
        .map((column) => column.name)
    );

    expect(columns).not.toContain('account_id');
    db.close();
  });

  it('refuses lambda open on a computer that joined another one, writing nothing', async () => {
    const lambdaHome = home();
    const env = { LAMBDA_HOME: lambdaHome };
    writeMachineConfig({ mothership: { url: 'http://100.64.0.2:4580' } }, env);
    const open = jest.fn();

    await expect(
      runOpen({ env, answering: async () => true, open })
    ).rejects.toThrow(NOT_THE_HOST);
    expect(open).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(lambdaHome, 'mothership.db'))).toBe(false);
  });

  it("refuses lambda open when Lambda isn't running, minting nothing", async () => {
    const lambdaHome = home();
    const env = { LAMBDA_HOME: lambdaHome };
    const db = openDb(path.join(lambdaHome, 'mothership.db'));

    await expect(
      runOpen({ env, answering: async () => false, open: jest.fn() })
    ).rejects.toThrow(NOT_RUNNING);
    expect(
      db
        .prepare<
          [],
          {
            n: number;
          }
        >('SELECT COUNT(*) AS n FROM login_links')
        .get()?.n
    ).toBe(0);
    db.close();
  });
});
