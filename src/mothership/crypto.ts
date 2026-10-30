import * as crypto from 'crypto';

/** A secret for a cookie or link: 32 random bytes, URL-safe. */
export const randomToken = (): string =>
  crypto.randomBytes(32).toString('base64url');

/** What's stored instead of a token or code. */
export const sha256 = (value: string): string =>
  crypto.createHash('sha256').update(value).digest('hex');

export const randomId = (prefix: string): string =>
  `${prefix}_${crypto.randomBytes(6).toString('hex')}`;

/** Crockford base32: no I, L, O or U. */
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const CODE_LENGTH = 8;

/** 8 Crockford characters (40 random bits), unformatted. */
export const randomCode = (): string =>
  Array.from(
    crypto.randomBytes(CODE_LENGTH),
    (byte) => CROCKFORD[byte % 32]
  ).join('');

/** `7KQ4M2ZD` → `7KQ4-M2ZD`. */
export const formatCode = (code: string): string =>
  `${code.slice(0, 4)}-${code.slice(4)}`;

/** What was typed, the way codes are stored: any case, no spaces or hyphen. */
export const normalizeCode = (typed: string): string =>
  typed.replace(/[\s-]/g, '').toUpperCase();

/** A constant-time comparison of two strings. */
export const sameSecret = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

/** A PEM that is an Ed25519 public key: the only kind a runner signs with. */
export const isEd25519PublicKey = (pem: string): boolean => {
  try {
    return crypto.createPublicKey(pem).asymmetricKeyType === 'ed25519';
  } catch {
    // Not a key at all: refused the same as a key of another kind.
    return false;
  }
};
