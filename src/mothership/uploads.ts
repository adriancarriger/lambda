import { execFileSync } from 'child_process';
import * as fs from 'fs';
import type * as http from 'http';
import * as path from 'path';

import { IMAGE_TYPES, UPLOAD_NAME } from '../app/shared/images';
import { decodePart, readRaw } from './http';
import { HttpError } from './relay';

/**
 * Images dropped into a message, kept on the mothership's machine under
 * `~/.lambda/_uploads`. The message carries each one's path. A refusal is
 * a 400 with its reason, which the app shows as it is.
 */

const MAX_UPLOAD = 20 * 1024 * 1024;
const TOO_BIG = 'An image must be between 1 byte and 20 MB.';

/** Formats the agent can't read, converted to JPEG with macOS `sips`. */
const CONVERTIBLE: Record<string, string> = {
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/tiff': 'tiff',
  'image/bmp': 'bmp',
};

const uploadName = (ext: string): string =>
  `img_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}.${ext}`;

/** The type it was sent with, or (a HEIC from Finder has none) its name's. */
export const imageType = (type: string, fileName: string): string => {
  const known = type.split(';')[0]?.trim().toLowerCase() ?? '';

  if (known !== '' && known !== 'application/octet-stream') {
    return known;
  }

  const ext = path.extname(fileName).slice(1).toLowerCase();
  const all = { ...IMAGE_TYPES, ...CONVERTIBLE, 'image/jpeg': 'jpeg' };

  return (
    Object.entries(all).find(([, value]) => value === ext)?.[0] ??
    (ext === 'jpg' ? 'image/jpeg' : known)
  );
};

/** Save one image (converting if it must); answers its absolute path. */
export const storeImage = (
  dir: string,
  bytes: Buffer,
  type: string,
  fileName = ''
): string => {
  if (bytes.length === 0 || bytes.length > MAX_UPLOAD) {
    throw new HttpError(400, TOO_BIG);
  }

  const kind = imageType(type, fileName);
  fs.mkdirSync(dir, { recursive: true });
  const ext = IMAGE_TYPES[kind];

  if (ext !== undefined) {
    const file = path.join(dir, uploadName(ext));
    fs.writeFileSync(file, bytes);

    return file;
  }

  const source = CONVERTIBLE[kind];

  if (source === undefined) {
    throw new HttpError(
      400,
      `${
        fileName === '' ? 'That' : `"${fileName}"`
      } isn't an image I can attach${
        kind === '' ? '' : ` (${kind})`
      } — PNG, JPEG, GIF, WebP, HEIC, TIFF or BMP.`
    );
  }

  const raw = path.join(dir, `raw_${uploadName(source)}`);
  const file = path.join(dir, uploadName('jpg'));
  fs.writeFileSync(raw, bytes);

  try {
    execFileSync('sips', ['-s', 'format', 'jpeg', raw, '--out', file], {
      stdio: 'ignore',
    });
  } finally {
    fs.rmSync(raw, { force: true });
  }

  return file;
};

/** POST /api/upload: the body is one image. */
export const saveUpload = async (
  dir: string,
  request: http.IncomingMessage
): Promise<string> =>
  storeImage(
    dir,
    await readRaw(request, MAX_UPLOAD),
    request.headers['content-type'] ?? '',
    decodePart(String(request.headers['x-file-name'] ?? ''), 'file name')
  );

/**
 * The body, read no further than MAX_UPLOAD: one that says it's bigger is
 * refused unread, and one that runs past it is cut off there.
 */
const readCapped = async (response: Response): Promise<Buffer> => {
  if (Number(response.headers.get('content-length') ?? 0) > MAX_UPLOAD) {
    await response.body?.cancel();

    throw new HttpError(400, TOO_BIG);
  }

  if (response.body === null) {
    throw new HttpError(400, TOO_BIG);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const read = { bytes: 0 };

  for (;;) {
    const next = await reader.read();

    if (next.done) {
      return Buffer.concat(chunks);
    }

    read.bytes += next.value.length;

    if (read.bytes > MAX_UPLOAD) {
      await reader.cancel();

      throw new HttpError(400, TOO_BIG);
    }

    chunks.splice(chunks.length, 0, next.value);
  }
};

/** POST /api/upload-url: an image dragged from a web page arrives as a link. */
export const saveUploadUrl = async (
  dir: string,
  url: string
): Promise<string> => {
  const data = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);

  if (data !== null) {
    return storeImage(
      dir,
      data[2] === undefined
        ? Buffer.from(decodeURIComponent(data[3] ?? ''))
        : Buffer.from(data[3] ?? '', 'base64'),
      data[1] ?? ''
    );
  }

  if (!/^https?:\/\//.test(url)) {
    throw new HttpError(400, "That link isn't an image I can fetch.");
  }

  // A redirect could lead anywhere, so it isn't followed. No answer at all
  // (a dead host, a timeout) is the link's fault, not ours: a 400 too.
  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  }).catch(() => {
    throw new HttpError(400, "Couldn't fetch the image.");
  });

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();

    throw new HttpError(400, "That link isn't an image I can fetch.");
  }

  if (!response.ok) {
    await response.body?.cancel();

    throw new HttpError(
      400,
      `Couldn't fetch the image (HTTP ${response.status}).`
    );
  }

  return storeImage(
    dir,
    await readCapped(response),
    response.headers.get('content-type') ?? '',
    new URL(url).pathname.split('/').at(-1) ?? ''
  );
};

export const serveUpload = (
  dir: string,
  name: string,
  response: http.ServerResponse
): void => {
  const file = path.join(dir, name);

  if (!UPLOAD_NAME.test(name) || !fs.existsSync(file)) {
    response.writeHead(404).end();

    return;
  }

  const ext = path.extname(name).slice(1);
  response.writeHead(200, {
    'content-type':
      Object.entries(IMAGE_TYPES).find(([, value]) => value === ext)?.[0] ??
      'image/jpeg',
    'cache-control': 'private, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  });
  fs.createReadStream(file).pipe(response);
};
