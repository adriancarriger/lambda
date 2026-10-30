import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';

import { required } from '../../__tests__/required';
import { openDb } from '../db';
import { createCode } from '../pairing';
import { createMothership } from '../server';
import { deviceLabel } from '../sessions';
import { type Harness, startHarness, tempHome } from './harness';

const DAY = 24 * 60 * 60 * 1000;

describe('sessions', () => {
  const fixture: { harness?: Harness } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');

  beforeEach(async () => {
    fixture.harness = await startHarness();
  });

  afterEach(() => harness().close());

  it('slides: used on day 0 and 29, it still works on day 58', async () => {
    const cookie = harness().signIn();
    const day0 = harness().clock.now;

    expect(
      (await harness().request('GET', '/api/session', { cookie })).status
    ).toBe(200);
    harness().clock.now = day0 + 29 * DAY;
    expect(
      (await harness().request('GET', '/api/session', { cookie })).status
    ).toBe(200);
    harness().clock.now = day0 + 58 * DAY;
    expect(
      (await harness().request('GET', '/api/session', { cookie })).status
    ).toBe(200);
  });

  it('ends after 30 unused days, and its row goes', async () => {
    const cookie = harness().signIn();
    harness().clock.now += 30 * DAY;

    expect(
      (await harness().request('GET', '/api/session', { cookie })).status
    ).toBe(401);
    expect(
      harness()
        .db.prepare<
          [],
          {
            n: number;
          }
        >('SELECT COUNT(*) AS n FROM sessions')
        .get()?.n
    ).toBe(0);
  });

  it('prunes a device whose session went unused for 30 days, and keeps a fresh one', async () => {
    harness().signIn("Ron's iPhone");
    harness().clock.now += 30 * DAY;
    harness().signIn("Leslie's Mac");

    await harness().mothership.tick();

    const count = (table: string): number | undefined =>
      harness()
        .db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
        .get()?.n;
    expect(
      harness()
        .db.prepare<[], { label: string }>('SELECT label FROM devices')
        .all()
    ).toEqual([{ label: "Leslie's Mac" }]);
    expect(count('sessions')).toBe(1);
  });

  it('names a device by its browser', () => {
    expect(
      deviceLabel(
        'Leslie',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
      )
    ).toBe("Leslie's iPhone");
    expect(
      deviceLabel('Leslie', 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')
    ).toBe("Leslie's iPad");
    expect(
      deviceLabel('Leslie', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')
    ).toBe("Leslie's Mac");
    expect(
      deviceLabel('Leslie', 'Mozilla/5.0 (Linux; Android 14; Pixel 8)')
    ).toBe("Leslie's Android phone");
    expect(
      deviceLabel('Leslie', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    ).toBe("Leslie's Windows PC");
    expect(deviceLabel('Leslie', 'curl/8.4.0')).toBe("Leslie's computer");
  });

  it('labels a paired iPhone with the owner’s name, and refuses a bad code in words', async () => {
    const { code } = createCode(harness().db, 'device', harness().clock.now);
    const paired = await harness().request('POST', '/api/auth/pair', {
      body: JSON.stringify({ code }),
      headers: {
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      },
    });
    const refused = await harness().request('POST', '/api/auth/pair', {
      body: JSON.stringify({ code: 'ZZZZ-ZZZZ' }),
    });

    expect(paired.status).toBe(200);
    expect(
      harness()
        .db.prepare<
          [],
          {
            label: string;
          }
        >('SELECT label FROM devices')
        .get()?.label
    ).toBe("Leslie Knope's iPhone");
    expect(refused.json().error).toBe(
      "That code didn't work. Check it, or make a new one with Add a device."
    );
  });

  it('keeps only a hash: no column of any table holds the raw token', async () => {
    const { code } = createCode(harness().db, 'device', harness().clock.now);
    const paired = await harness().request('POST', '/api/auth/pair', {
      body: JSON.stringify({ code }),
    });
    const cookie = String(paired.headers['set-cookie']?.[0]);
    const token = /lambda_session=([^;]+)/.exec(cookie)?.[1] ?? '';

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toContain('Secure');

    const tables = harness()
      .db.prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
      )
      .all()
      .map((row) => row.name);
    const values = tables.flatMap((table) =>
      harness()
        .db.prepare<[], Record<string, unknown>>(`SELECT * FROM ${table}`)
        .all()
        .flatMap((row) => Object.values(row))
    );

    expect(token.length).toBeGreaterThan(20);
    expect(values).not.toContain(token);
    expect(
      harness()
        .db.prepare<
          [],
          {
            token_hash: string;
          }
        >('SELECT token_hash FROM sessions')
        .get()?.token_hash
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signs a device out at once', async () => {
    const mine = harness().signIn("Leslie's Mac");
    const phone = harness().signIn("Leslie's iPhone");
    const { devices } = (
      await harness().request('GET', '/api/devices', { cookie: mine })
    ).json<{
      devices: { id: string; label: string; current: boolean }[];
    }>();
    const phoneId = devices.find(
      (device) => device.label === "Leslie's iPhone"
    )?.id;

    await harness().request('POST', '/api/devices/signout', {
      cookie: mine,
      body: JSON.stringify({ deviceId: phoneId }),
    });

    expect(
      (await harness().request('GET', '/api/session', { cookie: phone })).status
    ).toBe(401);
    expect(
      (await harness().request('GET', '/api/session', { cookie: mine })).status
    ).toBe(200);
  });
  it('ends the signed-out device’s live stream, and leaves the others’', async () => {
    const mine = harness().signIn("Leslie's Mac");
    const phone = harness().signIn("Leslie's iPhone");
    const stream = (cookie: string) =>
      new Promise<{ ended: Promise<boolean> }>((resolve, reject) => {
        const request = http.get(
          {
            host: '127.0.0.1',
            port: harness().port,
            path: '/api/events',
            headers: { host: `127.0.0.1:${harness().port}`, cookie },
          },
          (response) =>
            resolve({
              ended: new Promise<boolean>((settle) => {
                response.on('end', () => settle(true));
                response.on('close', () => settle(true));
                response.resume();
                setTimeout(() => {
                  request.destroy();
                  settle(false);
                }, 1000).unref();
              }),
            })
        );
        request.on('error', () => undefined);
        request.on('timeout', reject);
      });
    const phoneStream = await stream(phone);
    const myStream = await stream(mine);
    const { devices } = (
      await harness().request('GET', '/api/devices', { cookie: mine })
    ).json<{ devices: { id: string; label: string }[] }>();

    await harness().request('POST', '/api/devices/signout', {
      cookie: mine,
      body: JSON.stringify({
        deviceId: devices.find((device) => device.label === "Leslie's iPhone")
          ?.id,
      }),
    });

    expect(await phoneStream.ended).toBe(true);
    expect(await myStream.ended).toBe(false);
  });
});

describe('the cookie over https', () => {
  it('is Secure over https only', async () => {
    const home = tempHome();
    const key = path.join(home, 'key.pem');
    const cert = path.join(home, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
      ],
      { stdio: 'ignore' }
    );
    const db = openDb(path.join(home, 'mothership.db'));
    const server = https.createServer({
      key: fs.readFileSync(key),
      cert: fs.readFileSync(cert),
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    const port =
      typeof address === 'object' && address !== null ? address.port : 0;
    const mothership = createMothership({
      db,
      config: () => ({ owner: { name: 'Leslie Knope' } }),
      port,
      clientDir: home,
      home,
      log: () => undefined,
    });
    server.on('request', mothership.handle);
    const { code } = createCode(db, 'device', Date.now());

    const cookie = await new Promise<string>((resolve, reject) => {
      const request = https.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/auth/pair',
          rejectUnauthorized: false,
          headers: {
            host: `127.0.0.1:${port}`,
            origin: `https://127.0.0.1:${port}`,
            'content-type': 'application/json',
            // Not trusted: the scheme comes from the socket.
            'x-forwarded-proto': 'http',
          },
        },
        (response) => {
          response.resume();
          resolve(String(response.headers['set-cookie']?.[0]));
        }
      );
      request.on('error', reject);
      request.end(JSON.stringify({ code }));
    });

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');

    mothership.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
});

/**
 * What a browser does with the cookie: keeps it until its Max-Age runs out,
 * counted from the response that last set it, and sends it while it lasts.
 */
const browserJar = (now: () => number) => {
  const jar: { value: string | null; expiresAt: number } = {
    value: null,
    expiresAt: 0,
  };

  return {
    take: (setCookie: string[] | undefined): void => {
      const cookie = setCookie?.find((line) =>
        line.startsWith('lambda_session=')
      );

      if (cookie === undefined) {
        return;
      }

      const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)?.[1] ?? 0);
      jar.value = cookie.split(';')[0] ?? null;
      jar.expiresAt = now() + maxAge * 1000;
    },
    header: (): string | undefined =>
      jar.value !== null && now() < jar.expiresAt ? jar.value : undefined,
  };
};

describe('the session cookie slides in the browser', () => {
  const fixture: { harness?: Harness } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');

  beforeEach(async () => {
    fixture.harness = await startHarness();
  });

  afterEach(() => harness().close());

  it('renews the cookie on every signed-in response', async () => {
    const cookie = harness().signIn();
    const response = await harness().request('GET', '/api/session', {
      cookie,
    });
    const renewed = String(response.headers['set-cookie']?.[0]);

    expect(renewed.split(';')[0]).toBe(cookie);
    expect(renewed).toContain('Max-Age=2592000');
    expect(renewed).toContain('HttpOnly');
    expect(renewed).toContain('SameSite=Strict');
  });

  it('keeps a browser signed in past 30 days while it is used', async () => {
    const jar = browserJar(() => harness().clock.now);
    const day0 = harness().clock.now;
    const { code } = createCode(harness().db, 'device', day0);
    const paired = await harness().request('POST', '/api/auth/pair', {
      body: JSON.stringify({ code }),
    });
    jar.take(paired.headers['set-cookie']);

    const use = async (day: number): Promise<number> => {
      harness().clock.now = day0 + day * DAY;
      const response = await harness().request('GET', '/api/session', {
        cookie: jar.header(),
      });
      jar.take(response.headers['set-cookie']);

      return response.status;
    };

    expect(await use(20)).toBe(200);
    expect(await use(40)).toBe(200);
    expect(await use(58)).toBe(200);
  });
});
