import * as http from 'http';
import type { Duplex } from 'stream';

export const LOOPBACK = '127.0.0.1';
export const LISTEN_RETRY_MS = 5000;

const codeOf = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : error instanceof Error
    ? error.message
    : String(error);

export const portInUse = (address: string, port: number): string =>
  `Can't listen on ${address}:${port}: the port is in use. Set mothership.port in ~/.lambda/config.json.`;

export const notHereYet = (address: string, port: number): string =>
  `Can't listen on ${address}:${port}: that address isn't on this computer yet. Trying again in ${
    LISTEN_RETRY_MS / 1000
  } seconds.`;

/** Add a computer's refusal: the address was just reported, so no retry. */
export const notOnThisComputer = (address: string, port: number): string =>
  `Can't listen on ${address}:${port}: that address isn't on this computer.`;

const cantListen = (address: string, port: number, code: string): string =>
  `Can't listen on ${address}:${port}: ${code}.`;

/** Bind one server; resolves once listening, rejects with the bind error. */
export type Bind = (
  server: http.Server,
  port: number,
  address: string
) => Promise<void>;

export const bind: Bind = (server, port, address) =>
  new Promise((resolve, reject) => {
    const onError = (error: unknown) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, address);
  });

export interface Listeners {
  /** Every address answering, as `<address>:<port>`. */
  addresses: () => string[];
  /**
   * Listen on this address now, in place of any other besides 127.0.0.1.
   * Never retried: rejects with the line to show, changing nothing.
   */
  listenOn: (address: string) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Always 127.0.0.1, so `lambda open` and the local runner keep working; also
 * `mothership.listen` when set (a Tailscale address, say). That one may not
 * exist yet at login (EADDRNOTAVAIL): it's retried every 5 s while 127.0.0.1
 * stays up. Any other failure of it, or any 127.0.0.1 failure, is fatal:
 * `onFatal` gets the line to print, and the caller exits 1.
 */
export const startListeners = async (options: {
  handle: http.RequestListener;
  upgrade: (
    request: http.IncomingMessage,
    socket: Duplex,
    head: Buffer
  ) => void;
  port: number;
  listen?: string;
  log: (line: string) => void;
  onFatal: (line: string) => void;
  bind?: Bind;
}): Promise<Listeners> => {
  const doBind = options.bind ?? bind;
  const up: { list: { address: string; server: http.Server }[] } = {
    list: [],
  };
  const timers = new Set<NodeJS.Timeout>();
  const closed = { value: false };
  const isUp = (address: string): boolean =>
    up.list.some((entry) => entry.address === address);
  /** The extra address wanted now: a retry for an older one stops. */
  const wanted: { address: string | undefined } = { address: options.listen };

  const make = (): http.Server => {
    const server = http.createServer(options.handle);
    server.on('upgrade', options.upgrade);

    return server;
  };

  const loopback = make();

  try {
    await doBind(loopback, options.port, LOOPBACK);
  } catch (error) {
    throw new Error(
      codeOf(error) === 'EADDRINUSE'
        ? portInUse(LOOPBACK, options.port)
        : `Can't listen on ${LOOPBACK}:${options.port}: ${codeOf(error)}.`
    );
  }

  up.list = [...up.list, { address: LOOPBACK, server: loopback }];

  const tryExtra = (address: string): void => {
    if (closed.value || wanted.address !== address) {
      return;
    }

    const server = make();
    doBind(server, options.port, address)
      .then(() => {
        if (closed.value || wanted.address !== address || isUp(address)) {
          server.close();

          return;
        }

        up.list = [...up.list, { address, server }];
        options.log(`Listening on ${address}:${options.port}.`);
      })
      .catch((error: unknown) => {
        server.close();

        // listenOn took this address over, or moved to another, meanwhile.
        if (closed.value || wanted.address !== address || isUp(address)) {
          return;
        }

        const code = codeOf(error);

        if (code === 'EADDRINUSE') {
          options.onFatal(portInUse(address, options.port));

          return;
        }

        // Only an address not up yet (Tailscale at login) is worth waiting
        // for; a typo or a port it may not use won't fix itself.
        if (code !== 'EADDRNOTAVAIL') {
          options.onFatal(cantListen(address, options.port, code));

          return;
        }

        options.log(notHereYet(address, options.port));
        const timer = setTimeout(() => {
          timers.delete(timer);
          tryExtra(address);
        }, LISTEN_RETRY_MS);
        timers.add(timer);
      });
  };

  if (options.listen !== undefined && options.listen !== LOOPBACK) {
    tryExtra(options.listen);
  }

  const shut = (server: http.Server): void => {
    server.closeAllConnections();
    server.close();
  };

  const listenOn = async (address: string): Promise<void> => {
    if (isUp(address)) {
      return;
    }

    const server = make();

    try {
      await doBind(server, options.port, address);
    } catch (error) {
      server.close();

      // The login-time retry bound it first: it is listening, as asked.
      if (isUp(address)) {
        return;
      }

      const code = codeOf(error);

      throw new Error(
        code === 'EADDRINUSE'
          ? portInUse(address, options.port)
          : code === 'EADDRNOTAVAIL'
          ? notOnThisComputer(address, options.port)
          : cantListen(address, options.port, code)
      );
    }

    wanted.address = address;
    timers.forEach((timer) => clearTimeout(timer));
    timers.clear();
    const old = up.list.filter((entry) => entry.address !== LOOPBACK);
    up.list = [
      ...up.list.filter((entry) => entry.address === LOOPBACK),
      { address, server },
    ];
    old.forEach((entry) => shut(entry.server));
    options.log(`Listening on ${address}:${options.port}.`);
  };

  return {
    addresses: () => up.list.map(({ address }) => `${address}:${options.port}`),
    listenOn,
    close: async () => {
      closed.value = true;
      timers.forEach((timer) => clearTimeout(timer));
      await Promise.all(
        up.list.map(
          ({ server }) =>
            new Promise<void>((resolve) => {
              server.closeAllConnections();
              server.close(() => resolve());
            })
        )
      );
    },
  };
};
