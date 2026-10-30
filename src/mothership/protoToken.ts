import * as crypto from 'crypto';

import { sameSecret } from './crypto';
import type { Db } from './db';

const HOUR = 60 * 60 * 1000;

/** A prototype link works for 12 hours. */
export const PROTO_TOKEN_LIFETIME_MS = 12 * HOUR;

/** The mothership's key for prototype links, made once and kept. */
export const sessionSecret = (db: Db): string => {
  const row = db
    .prepare<[], { value: string }>(
      "SELECT value FROM secrets WHERE name = 'session'"
    )
    .get();

  if (row !== undefined) {
    return row.value;
  }

  const value = crypto.randomBytes(32).toString('hex');
  db.prepare(
    "INSERT OR IGNORE INTO secrets (name, value) VALUES ('session', ?)"
  ).run(value);

  return sessionSecret(db);
};

const sign = (
  secret: string,
  pod: string,
  slug: string,
  version: string,
  expires: number
): string =>
  crypto
    .createHmac('sha256', secret)
    .update(`${pod}\n${slug}\n${version}\n${expires}`)
    .digest('base64url');

/**
 * The token in a prototype's URLs (`/proto/<token>/<pod>/<slug>/v<n>/…`): its
 * expiry and an HMAC of pod, slug and version. A sandboxed frame's own
 * requests carry no session cookie, so this is what lets them in. The expiry
 * is rounded to the hour, so a link stays the same for an hour (an open frame
 * whose src changed would reload) and still works for 12 hours or more.
 */
export const protoToken = (
  secret: string,
  pod: string,
  slug: string,
  version: string,
  now: number
): string => {
  const expires =
    Math.floor(now / HOUR) * HOUR + HOUR + PROTO_TOKEN_LIFETIME_MS;

  return `${expires.toString(36)}.${sign(secret, pod, slug, version, expires)}`;
};

export const verifyProtoToken = (
  secret: string,
  token: string,
  pod: string,
  slug: string,
  version: string,
  now: number
): boolean => {
  const [expiresText, signature] = token.split('.');
  const expires = parseInt(expiresText ?? '', 36);

  return (
    signature !== undefined &&
    Number.isFinite(expires) &&
    expires > now &&
    sameSecret(signature, sign(secret, pod, slug, version, expires))
  );
};

/**
 * `/proto/<token>/<pod>/<slug>/v<n>/<file…>` or, for a signed-in session,
 * `/proto/<pod>/<slug>/v<n>/<file…>`, split up, or `null`. A token always
 * holds a `.` and a pod id never does, so the two can't be confused.
 */
export const parseProtoPath = (
  pathname: string
): {
  token: string | null;
  pod: string;
  slug: string;
  version: string;
  rest: string;
} | null => {
  const match =
    /^\/proto\/(?:([a-z0-9]+\.[A-Za-z0-9_-]+)\/)?([^/]+)\/([^/]+)\/(v\d+)\/(.+)$/.exec(
      pathname
    );

  if (match === null) {
    return null;
  }

  const [, token, pod, slug, version, file] = match;

  return pod === undefined ||
    slug === undefined ||
    version === undefined ||
    file === undefined
    ? null
    : {
        token: token ?? null,
        pod,
        slug,
        version,
        rest: `${pod}/${slug}/${version}/${file}`,
      };
};
