import { randomId, randomToken, sha256 } from './crypto';
import type { Db } from './db';

export const SESSION_COOKIE = 'lambda_session';

const DAY = 24 * 60 * 60 * 1000;

/** Sliding: each use renews it to 30 days from that use. */
export const SESSION_LIFETIME_MS = 30 * DAY;

export interface Device {
  id: string;
  label: string;
  lastSeenAt: number;
}

export interface Session {
  deviceId: string;
  tokenHash: string;
}

/** A new device and its session. Answers the raw token, for the cookie only. */
export const createSession = (
  db: Db,
  label: string,
  now: number
): { token: string; deviceId: string } => {
  const token = randomToken();
  const deviceId = randomId('dev');

  db.transaction(() => {
    db.prepare(
      'INSERT INTO devices (id, label, last_seen_at) VALUES (?, ?, ?)'
    ).run(deviceId, label, now);
    db.prepare(
      'INSERT INTO sessions (token_hash, device_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)'
    ).run(sha256(token), deviceId, now, now);
  })();

  return { token, deviceId };
};

/**
 * The session for a cookie's token, renewed to 30 days from `now`; `null`
 * for no such session, or one unused for 30 days (whose row is deleted, with
 * its device).
 */
export const useSession = (
  db: Db,
  token: string | undefined,
  now: number
): Session | null => {
  if (token === undefined || token === '') {
    return null;
  }

  const tokenHash = sha256(token);
  const row = db
    .prepare<[string], { device_id: string; last_seen_at: number }>(
      'SELECT device_id, last_seen_at FROM sessions WHERE token_hash = ?'
    )
    .get(tokenHash);

  if (row === undefined) {
    return null;
  }

  if (now - row.last_seen_at >= SESSION_LIFETIME_MS) {
    db.prepare('DELETE FROM devices WHERE id = ?').run(row.device_id);

    return null;
  }

  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(
    now,
    tokenHash
  );
  db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(
    now,
    row.device_id
  );

  return { deviceId: row.device_id, tokenHash };
};

export const listDevices = (db: Db): Device[] =>
  db
    .prepare<[], { id: string; label: string; last_seen_at: number }>(
      'SELECT id, label, last_seen_at FROM devices ORDER BY last_seen_at DESC'
    )
    .all()
    .map((row) => ({
      id: row.id,
      label: row.label,
      lastSeenAt: row.last_seen_at,
    }));

/** Sign out: the device and its session go at once. */
export const endDevice = (db: Db, deviceId: string): boolean =>
  db.prepare('DELETE FROM devices WHERE id = ?').run(deviceId).changes > 0;

/** The `Set-Cookie` value: `Secure` only when served over https. */
export const sessionCookie = (token: string, secure: boolean): string =>
  [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    `Max-Age=${Math.floor(SESSION_LIFETIME_MS / 1000)}`,
    'HttpOnly',
    'SameSite=Strict',
    ...(secure ? ['Secure'] : []),
  ].join('; ');

export const clearedCookie = (secure: boolean): string =>
  [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Strict',
    ...(secure ? ['Secure'] : []),
  ].join('; ');

/** The session token in a `Cookie` header. */
export const tokenFromCookie = (
  header: string | undefined
): string | undefined =>
  (header ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);

/**
 * "<owner>'s <device type>", the type from the browser's user agent:
 * iPhone, iPad, Mac, Android phone, Windows PC, otherwise computer.
 */
export const deviceLabel = (owner: string, userAgent: string | undefined) => {
  const agent = userAgent ?? '';
  const type = /iPhone/.test(agent)
    ? 'iPhone'
    : /iPad/.test(agent)
    ? 'iPad'
    : /Android/.test(agent)
    ? 'Android phone'
    : /Windows/.test(agent)
    ? 'Windows PC'
    : /Macintosh|Mac OS X/.test(agent)
    ? 'Mac'
    : 'computer';

  return `${owner}'s ${type}`;
};
