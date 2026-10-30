import * as fs from 'fs';
import * as http from 'http';
import type * as net from 'net';
import * as path from 'path';

import { required } from '../../__tests__/required';
import { saveUploadUrl } from '../uploads';
import { type Harness, startHarness, tempHome } from './harness';

/** One tiny valid PNG (1×1). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const MB = 1024 * 1024;

/** Every host a test opened: closed after it, whether the test passed or not. */
const openHosts: Array<() => Promise<void>> = [];

/** A web server standing in for the page an image was dragged from. */
const imageHost = async (
  answer: (response: http.ServerResponse) => void
): Promise<{ url: string; sent: { bytes: number } }> => {
  // What it sent, counted on its sockets (headers and all).
  const sockets = new Set<net.Socket>();
  const sent = {
    get bytes(): number {
      return [...sockets].reduce(
        (total, socket) => total + socket.bytesWritten,
        0
      );
    },
  };
  const server = http.createServer((_request, response) => answer(response));
  server.on('connection', (socket) => sockets.add(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  openHosts.splice(openHosts.length, 0, async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  const port =
    typeof address === 'object' && address !== null ? address.port : 0;

  return { url: `http://127.0.0.1:${port}/photo.png`, sent };
};

afterEach(async () => {
  await Promise.all(openHosts.splice(0).map((close) => close()));
});

describe('an image fetched from a link', () => {
  const dir = { path: '' };

  beforeEach(() => {
    dir.path = path.join(tempHome(), '_uploads');
  });

  it('is stored when it is a small image', async () => {
    const host = await imageHost((response) => {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(PNG);
    });

    const file = await saveUploadUrl(dir.path, host.url);

    expect(fs.readFileSync(file)).toEqual(PNG);
  });

  it('is refused unread when it says it is over 20 MB', async () => {
    const host = await imageHost((response) => {
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(30 * MB),
      });
      // Ends short of what it claims, so a reader that ignores the length
      // fails on the contents at once instead of waiting out the timeout.
      response.end(PNG);
    });

    await expect(saveUploadUrl(dir.path, host.url)).rejects.toThrow(
      'An image must be between 1 byte and 20 MB.'
    );
  });

  it('stops reading an endless body at 20 MB', async () => {
    const chunk = Buffer.alloc(MB);
    // "Endless" as far as the reader can tell, but it stops at 64 MB: a reader
    // with no cap then fails this test quickly instead of buffering ~1 GB/s
    // until its timeout (20 GB on a 20 s timeout).
    const host = await imageHost((response) => {
      response.writeHead(200, { 'content-type': 'image/png' });
      const pump = (): void => {
        if (response.destroyed) {
          return;
        }

        if (host.sent.bytes >= 64 * MB) {
          response.end();

          return;
        }

        if (response.write(chunk)) {
          setImmediate(pump);

          return;
        }

        response.once('drain', pump);
      };
      pump();
    });

    await expect(saveUploadUrl(dir.path, host.url)).rejects.toThrow(
      'An image must be between 1 byte and 20 MB.'
    );
    expect(host.sent.bytes).toBeLessThan(40 * MB);
  });

  it('is refused as a 400 when nothing answers at the link', async () => {
    await expect(
      saveUploadUrl(dir.path, 'http://127.0.0.1:1/ron-swanson.png')
    ).rejects.toMatchObject({
      status: 400,
      message: "Couldn't fetch the image.",
    });
  });

  it('is refused when the link redirects', async () => {
    const target = await imageHost((response) => {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(PNG);
    });
    const host = await imageHost((response) => {
      response.writeHead(302, { location: target.url });
      response.end();
    });

    await expect(saveUploadUrl(dir.path, host.url)).rejects.toThrow(
      "That link isn't an image I can fetch."
    );
    expect(target.sent.bytes).toBe(0);
  });
});

describe('the upload routes', () => {
  const fixture: { harness?: Harness } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');

  beforeEach(async () => {
    fixture.harness = await startHarness();
  });

  afterEach(() => harness().close());

  it('answer 400, not 500, to a file name that isn’t percent-encoding', async () => {
    const response = await harness().request('POST', '/api/upload', {
      cookie: harness().signIn(),
      contentType: 'application/octet-stream',
      headers: { 'x-file-name': 'photo%E0.png' },
      body: PNG,
    });

    expect(response.status).toBe(400);
    expect(response.json().error).toBe("That file name isn't readable.");
  });

  it('answer 400 with the reason, not 500, to an image type it can’t attach', async () => {
    const response = await harness().request('POST', '/api/upload', {
      cookie: harness().signIn(),
      contentType: 'image/svg+xml',
      headers: { 'x-file-name': 'pawnee-seal.svg' },
      body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
    });

    expect(response.status).toBe(400);
    expect(response.json().error).toBe(
      '"pawnee-seal.svg" isn\'t an image I can attach (image/svg+xml) — PNG, JPEG, GIF, WebP, HEIC, TIFF or BMP.'
    );
  });

  it('answer 400 with the reason, not 500, to a link that isn’t an image', async () => {
    const response = await harness().request('POST', '/api/upload-url', {
      cookie: harness().signIn(),
      body: JSON.stringify({ url: 'ftp://pawnee.gov/seal.png' }),
    });

    expect(response.status).toBe(400);
    expect(response.json().error).toBe("That link isn't an image I can fetch.");
  });

  it('serve an upload that is never sniffed as another type', async () => {
    const cookie = harness().signIn();
    const stored = await harness().request('POST', '/api/upload', {
      cookie,
      contentType: 'image/png',
      body: PNG,
    });
    const name = path.basename(String(stored.json().result));

    const served = await harness().request('GET', `/api/uploads/${name}`, {
      cookie,
    });

    expect(served.status).toBe(200);
    expect(served.headers['x-content-type-options']).toBe('nosniff');
  });
});
