import { type Message, REQUEST_TIMEOUT_MS, isResult } from '../protocol';
import { randomId } from './crypto';

/** A failure with the HTTP status the app gets for it. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export const offline = (name: string): HttpError =>
  new HttpError(409, `${name} is offline.`);

/** One runner's open socket. */
export interface RunnerLink {
  send: (message: Message) => void;
  close: () => void;
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: HttpError) => void;
  timer: NodeJS.Timeout;
  runnerId: string;
}

export interface Relay {
  attach: (runnerId: string, link: RunnerLink) => void;
  /** Only detaches `link` if it is still that runner's link. */
  detach: (runnerId: string, link: RunnerLink) => void;
  isConnected: (runnerId: string) => boolean;
  connected: () => string[];
  /**
   * Send a request and wait for its `result`. A runner that's offline is
   * refused at once (409, nothing queued); no answer in 60 s is a 504; an
   * `ok: false` result is a 400 with the runner's error text.
   */
  request: (
    runnerId: string,
    message: Message,
    timeoutMs?: number
  ) => Promise<unknown>;
  /** A push that gets no result (`owner`). Dropped when offline. */
  push: (runnerId: string, message: Message) => void;
  /** Everything the runner sends: results settle requests, the rest go on. */
  receive: (runnerId: string, message: Message) => void;
}

export const createRelay = (options: {
  runnerName: (runnerId: string) => string;
  onMessage: (runnerId: string, message: Message) => void;
  timeoutMs?: number;
}): Relay => {
  const links = new Map<string, RunnerLink>();
  const pending = new Map<string, Pending>();
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const settle = (id: string): Pending | undefined => {
    const entry = pending.get(id);

    if (entry !== undefined) {
      clearTimeout(entry.timer);
      pending.delete(id);
    }

    return entry;
  };

  return {
    attach: (runnerId, link) => {
      const previous = links.get(runnerId);
      links.set(runnerId, link);

      // A runner that reconnects replaces its old socket.
      if (previous !== undefined && previous !== link) {
        previous.close();
      }
    },
    detach: (runnerId, link) => {
      if (links.get(runnerId) !== link) {
        return;
      }

      links.delete(runnerId);
      [...pending.entries()]
        .filter(([, entry]) => entry.runnerId === runnerId)
        .forEach(([id]) =>
          settle(id)?.reject(offline(options.runnerName(runnerId)))
        );
    },
    isConnected: (runnerId) => links.has(runnerId),
    connected: () => [...links.keys()],
    request: (runnerId, message, ownTimeoutMs) => {
      const link = links.get(runnerId);
      const name = options.runnerName(runnerId);

      if (link === undefined) {
        return Promise.reject(offline(name));
      }

      const id = randomId('req');

      return new Promise((resolve, reject) => {
        pending.set(id, {
          resolve,
          reject,
          runnerId,
          timer: setTimeout(() => {
            settle(id)?.reject(
              new HttpError(504, `${name} didn't answer. Try again.`)
            );
          }, ownTimeoutMs ?? timeoutMs),
        });
        link.send({ ...message, id });
      });
    },
    push: (runnerId, message) => links.get(runnerId)?.send(message),
    receive: (runnerId, message) => {
      if (isResult(message) && pending.has(message.id)) {
        // Only the runner it was sent to may answer a request.
        if (pending.get(message.id)?.runnerId !== runnerId) {
          options.onMessage(runnerId, message);

          return;
        }

        const entry = settle(message.id);

        if (message.ok) {
          entry?.resolve(message.result);
        } else {
          entry?.reject(new HttpError(400, message.error ?? 'Failed.'));
        }

        return;
      }

      options.onMessage(runnerId, message);
    },
  };
};
