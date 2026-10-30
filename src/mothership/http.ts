import type * as http from 'http';

import { HttpError } from './relay';

export const json = (
  response: http.ServerResponse,
  status: number,
  data: unknown,
  headers: Record<string, string> = {}
): void => {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(JSON.stringify(data));
};

/** `{ ok: false, error }`: what the app's `post` shows. */
export const refuse = (
  response: http.ServerResponse,
  status: number,
  error: string
): void => json(response, status, { ok: false, error });

const MAX_JSON = 2 * 1024 * 1024;

export const readRaw = (
  request: http.IncomingMessage,
  limit: number
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const size: { bytes: number; chunks: Buffer[] } = { bytes: 0, chunks: [] };
    const onData = (chunk: Buffer) => {
      size.bytes += chunk.length;

      if (size.bytes > limit) {
        // Refused now, not after the rest arrives: the caller answers 413
        // and closes the connection.
        request.off('data', onData);
        reject(new HttpError(413, 'Too large.'));

        return;
      }

      size.chunks = [...size.chunks, chunk];
    };
    request.on('data', onData);
    request.on('error', reject);
    request.on('end', () => resolve(Buffer.concat(size.chunks)));
  });

/**
 * A JSON body as an object. Only called after the gate has checked the
 * content type, so nothing but JSON is ever parsed.
 */
export const readBody = async (
  request: http.IncomingMessage
): Promise<Record<string, unknown>> => {
  const raw = (await readRaw(request, MAX_JSON)).toString('utf8');

  try {
    const parsed: unknown = raw === '' ? {} : JSON.parse(raw);

    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : {};
  } catch {
    throw new HttpError(400, "That body isn't JSON.");
  }
};

export const str = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];

  if (typeof value !== 'string' || value === '') {
    throw new HttpError(400, `Missing "${key}"`);
  }

  return value;
};

export const optStr = (
  body: Record<string, unknown>,
  key: string
): string | undefined => {
  const value = body[key];

  return typeof value === 'string' && value !== '' ? value : undefined;
};

/** One percent-encoded part, or a 400 naming what couldn't be read. */
export const decodePart = (part: string, what: string): string => {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new HttpError(400, `That ${what} isn't readable.`);
  }
};

/** The peer's address: what the pairing lockout counts by. */
export const remoteAddress = (request: http.IncomingMessage): string =>
  request.socket.remoteAddress ?? 'unknown';
