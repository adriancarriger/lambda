import type * as http from 'http';

/**
 * The only requests the mothership answers without a session: the
 * `lambda open` login link, signing in with a pairing code, registering a
 * runner with a join code, and the runner socket (which signs a challenge
 * instead of carrying a cookie). Exactly these four.
 */
export const PUBLIC_ROUTES: readonly { method: string; path: string }[] = [
  { method: 'GET', path: '/auth/link' },
  { method: 'POST', path: '/api/auth/pair' },
  { method: 'POST', path: '/api/runners/join' },
  { method: 'GET', path: '/api/runner/socket' },
];

/**
 * Every path under these needs a session (or, under `/proto/`, a prototype
 * link token), whether or not a route exists for it. Anything else is the
 * built client's static files, which hold no data.
 */
export const GATED_PREFIXES = ['/api/', '/proto/'] as const;

export const REFUSED = 'Request refused.';

export const isPublic = (method: string, pathname: string): boolean =>
  PUBLIC_ROUTES.some(
    (route) => route.method === method && route.path === pathname
  );

export const isGated = (pathname: string): boolean =>
  GATED_PREFIXES.some((prefix) => pathname.startsWith(prefix));

export interface HostRules {
  port: number;
  /** `mothership.listen`, when set. */
  listen?: string;
  /** `mothership.host`, a bare name, when set. */
  host?: string;
}

/** The `Host` values that name this mothership. */
export const allowedHosts = ({ port, listen, host }: HostRules): string[] => [
  `127.0.0.1:${port}`,
  `localhost:${port}`,
  // An IPv6 address is bracketed in a Host header: `[fd7a::1]:4580`.
  ...(listen === undefined
    ? []
    : [`${listen.includes(':') ? `[${listen}]` : listen}:${port}`]),
  ...(host === undefined ? [] : [`${host}:${port}`]),
];

export const isHttps = (request: http.IncomingMessage): boolean =>
  'encrypted' in request.socket && request.socket.encrypted === true;

/** The request's own origin, `<scheme>://<Host>`. */
export const ownOrigin = (request: http.IncomingMessage): string =>
  `${isHttps(request) ? 'https' : 'http'}://${request.headers.host ?? ''}`;

const mediaType = (request: http.IncomingMessage): string =>
  (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ??
  '';

/**
 * A POST body's type is one we parse: JSON, or on `/api/upload` the raw
 * image (`image/*`, or `application/octet-stream` named by `x-file-name`,
 * what the browser sends for a file it gives no type).
 */
export const acceptsBody = (
  request: http.IncomingMessage,
  pathname: string
): boolean => {
  const type = mediaType(request);

  if (pathname === '/api/upload') {
    return (
      type.startsWith('image/') ||
      (type === 'application/octet-stream' &&
        typeof request.headers['x-file-name'] === 'string')
    );
  }

  return type === 'application/json';
};

export type GateVerdict =
  | { ok: true }
  | { ok: false; status: 403 | 415; error: string };

/**
 * Host, then Origin (POSTs), then — for POSTs — the body type. The session
 * check sits between Origin and body type (server.ts), so a stranger learns
 * nothing about which bodies are accepted.
 */
export const checkHostAndOrigin = (
  request: http.IncomingMessage,
  pathname: string,
  rules: HostRules
): GateVerdict => {
  const hosts = allowedHosts(rules);

  if (!hosts.includes(request.headers.host ?? '')) {
    return { ok: false, status: 403, error: REFUSED };
  }

  if (request.method !== 'POST') {
    return { ok: true };
  }

  const { origin } = request.headers;

  // `lambda join` posts from Node's fetch, which sends no Origin; it is
  // authenticated by its one-time code, not a cookie.
  if (origin === undefined && pathname === '/api/runners/join') {
    return { ok: true };
  }

  return origin === ownOrigin(request)
    ? { ok: true }
    : { ok: false, status: 403, error: REFUSED };
};

export const checkBodyType = (
  request: http.IncomingMessage,
  pathname: string
): GateVerdict =>
  request.method !== 'POST' || acceptsBody(request, pathname)
    ? { ok: true }
    : { ok: false, status: 415, error: 'Send JSON.' };
