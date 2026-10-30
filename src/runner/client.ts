import { WebSocket } from 'ws';

import {
  MOTHERSHIP_TYPES,
  type Message,
  REQUEST_TIMEOUT_MS,
  isResult,
  parseMessage,
  resultOf,
} from '../protocol';
import { type KnownAssignees, parseKnownAssignees } from '../tickets/assignees';
import { createBackoff } from './backoff';
import { signChallenge } from './keys';
import type { Outbox, OutboxItem } from './outbox';

/**
 * The runner's one outgoing WebSocket to the mothership. It opens no
 * listening port. On connect it signs the mothership's challenge; once in
 * (the mothership's first push, `owner`), it sends the outbox in order. A
 * drop reconnects after 1 s, doubling to 30 s; a completed connect resets
 * that.
 */

export interface Owner {
  name: string;
  email: string | null;
  aliases: { kind: string; value: string }[];
}

export interface RunnerClientOptions {
  url: string;
  runnerId: string;
  privateKey: string;
  outbox: Outbox;
  /** A mothership request: answered with its result, or its error. */
  handle: (message: Message) => Promise<unknown>;
  /** `known`: the assignee map, when the mothership sends one. */
  onOwner?: (owner: Owner, known?: KnownAssignees) => void;
  onConnected?: (connected: boolean) => void;
  log: (line: string) => void;
  /**
   * The id and key to sign in with, read again for every connect: after the
   * mothership is reset, `lambda start` writes new ones while this runs.
   */
  credentials?: () => { runnerId: string; privateKey: string };
  /** How often the socket is pinged; a missed pong drops it. */
  pingEveryMs?: number;
  /** For tests: when to reconnect. */
  schedule?: (fn: () => void, ms: number) => void;
  /** How long a request waits for its result before it counts as unreachable. */
  requestTimeoutMs?: number;
}

/** The close code the mothership signs a refused runner out with. */
const REFUSED = 4401;
const PING_EVERY_MS = 20_000;
export const KEY_REFUSED =
  "Lambda refused this computer's key. It's read again for the next try; if this keeps happening, run lambda leave, then lambda join.";

export interface RunnerClient {
  start: () => void;
  stop: () => void;
  isConnected: () => boolean;
  /** Keep it in the outbox and send it when connected. */
  enqueue: (
    item: OutboxItem,
    replaces?: (other: OutboxItem) => boolean
  ) => void;
  /** A write of the runner's own (project-link, leave): waits for its result. */
  request: (message: Message & { id: string }) => Promise<unknown>;
}

/** `http://host:port` → `ws://host:port/api/runner/socket`. */
export const socketUrl = (url: string): string =>
  `${url.replace(/\/+$/, '').replace(/^http/, 'ws')}/api/runner/socket`;

export const createRunnerClient = (
  options: RunnerClientOptions
): RunnerClient => {
  const backoff = createBackoff();
  const schedule =
    options.schedule ??
    ((fn: () => void, ms: number) => void setTimeout(fn, ms));
  const state: {
    socket: WebSocket | null;
    connected: boolean;
    stopped: boolean;
    credentials: { runnerId: string; privateKey: string };
  } = {
    socket: null,
    connected: false,
    stopped: false,
    credentials: { runnerId: options.runnerId, privateKey: options.privateKey },
  };
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  const send = (message: Message): void => {
    if (state.socket?.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify(message));
    }
  };

  const setConnected = (connected: boolean): void => {
    if (state.connected !== connected) {
      state.connected = connected;
      options.onConnected?.(connected);
    }
  };

  const onRequest = (message: Message): void => {
    const id = typeof message.id === 'string' ? message.id : null;

    options
      .handle(message)
      .then((result) => {
        if (id !== null) {
          send(resultOf(id, { ok: true, result }));
        }
      })
      .catch((error: unknown) => {
        if (id !== null) {
          send(
            resultOf(id, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
          );
        }
      });
  };

  const onMessage = (raw: string): void => {
    const message = parseMessage(raw);

    if (message === null) {
      options.log(
        'Ignoring a mothership message that is not JSON with a type.'
      );

      return;
    }

    if (message.type === 'challenge' && typeof message.challenge === 'string') {
      send({
        type: 'auth',
        runnerId: state.credentials.runnerId,
        signature: signChallenge(
          state.credentials.privateKey,
          Buffer.from(message.challenge, 'base64')
        ),
      });

      return;
    }

    if (message.type === 'owner') {
      if (!state.connected) {
        backoff.reset();
        // Flushed before `onConnected`: what it enqueues is sent by `enqueue`
        // itself, so flushing after would send it twice.
        options.outbox.pending().forEach(send);
        setConnected(true);
      }

      options.onOwner?.(
        {
          name: String(message.name ?? ''),
          email: typeof message.email === 'string' ? message.email : null,
          aliases: Array.isArray(message.aliases) ? message.aliases : [],
        },
        // An older mothership sends no map: what's on disk stays.
        message.assignees === undefined
          ? undefined
          : parseKnownAssignees(message.assignees)
      );

      return;
    }

    if (isResult(message)) {
      const waiting = pending.get(message.id);

      if (waiting !== undefined) {
        pending.delete(message.id);

        if (message.ok) {
          waiting.resolve(message.result);
        } else {
          waiting.reject(new Error(message.error ?? 'Failed.'));
        }

        return;
      }

      if (!message.ok) {
        // Kept: it goes again, in order, on the next connect.
        options.log(
          `Lambda didn't store ${message.id}: ${
            message.error ?? 'Failed.'
          }. It's sent again on the next connect.`
        );

        return;
      }

      // The mothership stored an outbox item.
      options.outbox.ack(message.id);

      return;
    }

    if (MOTHERSHIP_TYPES.some((known) => known === message.type)) {
      onRequest(message);

      return;
    }

    options.log(
      `Ignoring a mothership message of unknown type "${message.type}".`
    );
  };

  const connect = (): void => {
    if (state.stopped) {
      return;
    }

    state.credentials = options.credentials?.() ?? state.credentials;
    const socket = new WebSocket(socketUrl(options.url));
    state.socket = socket;
    // A half-open connection (a laptop asleep, a Wi-Fi change) never closes
    // by itself: a ping that goes unanswered until the next one drops it.
    const alive = { value: true };
    const pinger = setInterval(() => {
      if (!alive.value) {
        socket.terminate();

        return;
      }

      alive.value = false;

      // A ping before the socket opens throws (in a timer: uncaught). One
      // still connecting gets no ping, so it's dropped just the same.
      if (socket.readyState === WebSocket.OPEN) {
        socket.ping();
      }
    }, options.pingEveryMs ?? PING_EVERY_MS);
    socket.on('open', () => {
      alive.value = true;
    });
    socket.on('pong', () => {
      alive.value = true;
    });
    socket.on('message', (data) => onMessage(data.toString()));
    socket.on('error', (error) =>
      options.log(`Socket error: ${error.message}`)
    );
    socket.on('close', (code) => {
      clearInterval(pinger);

      if (state.socket !== socket) {
        return;
      }

      if (code === REFUSED) {
        options.log(KEY_REFUSED);
      }

      state.socket = null;
      setConnected(false);
      [...pending.values()].forEach((waiting) =>
        waiting.reject(new Error("Couldn't reach Lambda."))
      );
      pending.clear();

      if (!state.stopped) {
        schedule(connect, backoff.next());
      }
    });
  };

  return {
    start: () => {
      state.stopped = false;
      connect();
    },
    stop: () => {
      state.stopped = true;
      state.socket?.close(1000, 'runner stopping');
    },
    isConnected: () => state.connected,
    enqueue: (item, replaces) => {
      options.outbox.add(item, replaces);

      if (state.connected) {
        send(item);
      }
    },
    request: (message) =>
      new Promise((resolve, reject) => {
        if (!state.connected) {
          reject(new Error("Couldn't reach Lambda."));

          return;
        }

        // A mothership that never answers (an older one that doesn't know the
        // message) counts as unreachable, so the caller's retry path runs.
        const timer = setTimeout(() => {
          pending.delete(message.id);
          reject(new Error("Couldn't reach Lambda: no answer in time."));
        }, options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
        const settle =
          <T>(done: (value: T) => void) =>
          (value: T) => {
            clearTimeout(timer);
            done(value);
          };
        pending.set(message.id, {
          resolve: settle(resolve),
          reject: settle(reject),
        });
        send(message);
      }),
  };
};
