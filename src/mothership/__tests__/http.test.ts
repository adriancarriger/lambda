import * as http from 'http';
import * as net from 'net';

import { allowedHosts } from '../gate';
import { readRaw } from '../http';

describe('reading a body', () => {
  it('refuses at once past the limit, without waiting for the rest', async () => {
    const request = new http.IncomingMessage(new net.Socket());

    const reading = readRaw(request, 10);
    // The first chunk is over the limit; the body never ends.
    request.emit('data', Buffer.alloc(11));
    const outcome = await Promise.race([
      reading.then(
        () => 'read',
        (error: { status?: number }) => `refused ${String(error.status)}`
      ),
      new Promise((resolve) => setTimeout(() => resolve('still reading'), 100)),
    ]);

    expect(outcome).toBe('refused 413');
    request.destroy();
  });
});

describe('the Host values the gate accepts', () => {
  it('writes an IPv6 listen address in brackets, as browsers send it', () => {
    expect(allowedHosts({ port: 4580, listen: 'fd7a:115c:a1e0::1' })).toContain(
      '[fd7a:115c:a1e0::1]:4580'
    );
    expect(allowedHosts({ port: 4580, listen: '100.64.0.2' })).toContain(
      '100.64.0.2:4580'
    );
  });
});
