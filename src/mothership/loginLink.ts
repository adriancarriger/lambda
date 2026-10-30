import { loadMachineConfig } from '../config/machineConfig';
import { randomToken, sha256 } from './crypto';
import { type Db, openDb } from './db';

/** A login link works once, for 60 seconds. */
export const LOGIN_LINK_LIFETIME_MS = 60_000;

export const DEFAULT_PORT = 4580;

/** `mothership.port`, else 4580. */
export const mothershipPort = (
  port: number | undefined = loadMachineConfig()?.mothership?.port
): number => port ?? DEFAULT_PORT;

/** Write a login link's hashed token; answers the raw token. */
export const writeLoginLink = (db: Db, now: number): string => {
  const token = randomToken();
  db.prepare(
    'INSERT INTO login_links (token_hash, expires_at, used_at) VALUES (?, ?, NULL)'
  ).run(sha256(token), now + LOGIN_LINK_LIFETIME_MS);

  return token;
};

/**
 * Mint a single-use, 60-second login link by writing straight into the
 * mothership's database file. Being able to read that file on the host is
 * the proof; no HTTP route mints one. Used by `lambda open`, and by the Mac
 * app to open its window signed in.
 */
export const mintLoginLink = (
  dbPath: string,
  options: { port?: number; now?: number } = {}
): string => {
  const db = openDb(dbPath);

  try {
    const token = writeLoginLink(db, options.now ?? Date.now());

    return `http://127.0.0.1:${mothershipPort(
      options.port
    )}/auth/link?t=${token}`;
  } finally {
    db.close();
  }
};

/** Use up a login link. A used, expired or unknown one answers `false`. */
export const redeemLoginLink = (db: Db, token: string, now: number): boolean =>
  token !== '' &&
  db
    .prepare(
      'UPDATE login_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?'
    )
    .run(now, sha256(token), now).changes === 1;
