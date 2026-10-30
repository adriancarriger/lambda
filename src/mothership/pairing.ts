import { formatCode, normalizeCode, randomCode, sha256 } from './crypto';
import type { Db } from './db';

const MINUTE = 60 * 1000;

/** A pairing or join code works once, for 10 minutes. */
export const CODE_LIFETIME_MS = 10 * MINUTE;

/** Five refused codes from one address within 10 minutes lock it out… */
export const MAX_REFUSED = 5;
export const REFUSED_WINDOW_MS = 10 * MINUTE;
/** …until 10 minutes after the fifth. */
export const LOCKOUT_MS = 10 * MINUTE;

export const CODE_REFUSED =
  "That code didn't work. Check it, or make a new one with Add a device.";
export const JOIN_CODE_REFUSED =
  "That join code didn't work. Make a new one with Add a computer.";
export const TOO_MANY_TRIES = 'Too many tries. Try again in 10 minutes.';

/** `device`: Add a device (sign in). `runner`: Add a computer (lambda join). */
export type CodeKind = 'device' | 'runner';

/** A new code, shown `XXXX-XXXX`. Only its hash is stored. */
export const createCode = (
  db: Db,
  kind: CodeKind,
  now: number
): { code: string; expiresAt: number } => {
  const code = randomCode();
  const expiresAt = now + CODE_LIFETIME_MS;
  db.prepare(
    'INSERT INTO pairing_codes (code_hash, kind, expires_at, used_at) VALUES (?, ?, ?, NULL)'
  ).run(sha256(code), kind, expiresAt);

  return { code: formatCode(code), expiresAt };
};

/**
 * Use up a typed code of this kind. A wrong, expired, used or other-kind
 * code all answer `false`, alike. One UPDATE, so two at once can't both win.
 */
export const redeemCode = (
  db: Db,
  kind: CodeKind,
  typed: string,
  now: number
): boolean =>
  db
    .prepare(
      'UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?'
    )
    .run(now, sha256(normalizeCode(typed)), kind, now).changes === 1;

/**
 * When this address is locked out until, or `null`: some run of five
 * refused codes within 10 minutes whose fifth is under 10 minutes ago.
 */
export const lockedUntil = (
  db: Db,
  address: string,
  now: number
): number | null => {
  const times = db
    .prepare<[string, number], { at: number }>(
      'SELECT at FROM pair_attempts WHERE remote_address = ? AND at > ? ORDER BY at'
    )
    .all(address, now - REFUSED_WINDOW_MS - LOCKOUT_MS)
    .map((row) => row.at);
  const ends = times.flatMap((at, index) => {
    const first = times[index - (MAX_REFUSED - 1)];

    return first !== undefined && at - first <= REFUSED_WINDOW_MS
      ? [at + LOCKOUT_MS]
      : [];
  });
  const until = Math.max(...ends, -Infinity);

  return until > now ? until : null;
};

export const recordRefused = (db: Db, address: string, now: number): void => {
  db.prepare(
    'INSERT INTO pair_attempts (remote_address, at) VALUES (?, ?)'
  ).run(address, now);
  // Nothing older than a window plus a lockout can matter again.
  db.prepare('DELETE FROM pair_attempts WHERE at <= ?').run(
    now - REFUSED_WINDOW_MS - LOCKOUT_MS
  );
};

export type RedeemOutcome = 'ok' | 'refused' | 'locked';

/**
 * The shared door for `POST /api/auth/pair` and `POST /api/runners/join`: a
 * locked-out address is refused without the code being checked; a refused
 * code counts toward the lockout.
 */
export const redeemWithLockout = (
  db: Db,
  kind: CodeKind,
  typed: string,
  address: string,
  now: number
): RedeemOutcome => {
  if (lockedUntil(db, address, now) !== null) {
    return 'locked';
  }

  if (redeemCode(db, kind, typed, now)) {
    return 'ok';
  }

  recordRefused(db, address, now);

  return 'refused';
};
