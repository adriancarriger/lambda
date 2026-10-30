import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { WebSocket } from 'ws';

import type { PodSnapshot } from '../../app/shared/snapshot';
import type { MachineConfig } from '../../config/machineConfig';
import type { Pod } from '../../pod-store';
import { type Message, parseMessage, resultOf } from '../../protocol';
import { generateRunnerKeys, signChallenge } from '../../runner/keys';
import { type Db, openDb } from '../db';
import { addRunner, linkProject, newRunnerId } from '../registry';
import {
  type Mothership,
  type MothershipOptions,
  createMothership,
} from '../server';
import { SESSION_COOKIE, createSession } from '../sessions';

/** A pod as a runner pushes it: idle, nothing waiting. Only its id matters here. */
export const podSnapshot = (podId: string): PodSnapshot => {
  const pod: Pod = {
    id: podId,
    slug: podId,
    createdAt: '2026-10-21T00:00:00.000Z',
    status: 'active',
    phase: 1,
    completedCheckpoints: [],
    worktreePath: `/tmp/${podId}`,
    ownsWorktree: false,
    managerCwd: `/tmp/${podId}`,
    devCwd: `/tmp/${podId}`,
    agentCommand: 'claude',
    sessions: { manager: 'm', dev: 'd' },
  };

  return {
    podId,
    summary: {
      pod,
      running: false,
      status: 'working',
      needsYou: 0,
      liveForks: [],
      chatHold: false,
    },
    inbox: [],
    questions: [],
    rank: 0,
    activity: { midTurn: false, openRequest: false, lastActivityAt: 0 },
  };
};

/**
 * A real mothership on a free port with its own temp home, for tests. Every
 * request goes over HTTP, so the gate is exercised exactly as in use.
 */

export interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  /** The body parsed, as the shape the test expects. */
  json: <T = { ok?: boolean; error?: string; result?: unknown }>() => T;
}

export interface RequestOptions {
  cookie?: string;
  origin?: string | null;
  host?: string;
  contentType?: string | null;
  body?: string | Buffer;
  headers?: Record<string, string>;
}

export interface Harness {
  home: string;
  port: number;
  db: Db;
  mothership: Mothership;
  clock: { now: number };
  logs: string[];
  request: (
    method: string,
    urlPath: string,
    options?: RequestOptions
  ) => Promise<Response>;
  /** A signed-in device's cookie header. */
  signIn: (label?: string) => string;
  close: () => Promise<void>;
}

export const tempHome = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-test-'));

export const startHarness = async (
  options: {
    config?: MachineConfig | (() => MachineConfig | null);
    timeoutMs?: number;
    authTimeoutMs?: number;
    clientDir?: string;
    /** A fixed port (a runner already trying to reach it); else a free one. */
    port?: number;
    setup?: MothershipOptions['setup'];
    network?: MothershipOptions['network'];
  } = {}
): Promise<Harness> => {
  const home = tempHome();
  const db = openDb(path.join(home, 'mothership.db'));
  const clock = { now: Date.UTC(2026, 9, 21, 12) };
  const holder: { mothership: Mothership | null; logs: string[] } = {
    mothership: null,
    logs: [],
  };
  const server = http.createServer((request, response) =>
    holder.mothership?.handle(request, response)
  );
  server.on('upgrade', (request, socket, head) =>
    holder.mothership?.upgrade(request, socket, head)
  );
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, '127.0.0.1', resolve)
  );
  const address = server.address();
  const port =
    typeof address === 'object' && address !== null ? address.port : 0;
  const mothership = createMothership({
    db,
    config: (() => {
      const { config } = options;

      if (typeof config === 'function') {
        return config;
      }

      return () =>
        config ?? {
          owner: { name: 'Leslie Knope', email: 'leslie@pawnee.gov' },
        };
    })(),
    port,
    clientDir: options.clientDir ?? path.join(home, 'no-client'),
    home,
    now: () => clock.now,
    log: (line) => {
      holder.logs = [...holder.logs, line];
    },
    timeoutMs: options.timeoutMs,
    authTimeoutMs: options.authTimeoutMs,
    setup: options.setup,
    network: options.network,
  });
  holder.mothership = mothership;

  const request = (
    method: string,
    urlPath: string,
    requestOptions: RequestOptions = {}
  ): Promise<Response> =>
    new Promise((resolve, reject) => {
      const host = requestOptions.host ?? `127.0.0.1:${port}`;
      const headers: Record<string, string> = {
        host,
        ...(requestOptions.cookie === undefined
          ? {}
          : { cookie: requestOptions.cookie }),
        ...(requestOptions.origin === null
          ? {}
          : method === 'POST'
          ? { origin: requestOptions.origin ?? `http://${host}` }
          : requestOptions.origin === undefined
          ? {}
          : { origin: requestOptions.origin }),
        ...(requestOptions.contentType === null
          ? {}
          : method === 'POST'
          ? { 'content-type': requestOptions.contentType ?? 'application/json' }
          : {}),
        ...requestOptions.headers,
      };
      const outgoing = http.request(
        { host: '127.0.0.1', port, method, path: urlPath, headers },
        (incoming) => {
          const body: { chunks: Buffer[] } = { chunks: [] };
          incoming.on('data', (chunk: Buffer) => {
            body.chunks = [...body.chunks, chunk];
          });
          incoming.on('end', () => {
            const text = Buffer.concat(body.chunks).toString('utf8');
            resolve({
              status: incoming.statusCode ?? 0,
              headers: incoming.headers,
              text,
              json: <T>(): T => JSON.parse(text),
            });
          });
        }
      );
      outgoing.on('error', reject);
      outgoing.end(
        requestOptions.body ?? (method === 'POST' ? '{}' : undefined)
      );
    });

  return {
    home,
    port,
    db,
    mothership,
    clock,
    get logs() {
      return holder.logs;
    },
    request,
    signIn: (label = "Leslie's Mac") =>
      `${SESSION_COOKIE}=${createSession(db, label, clock.now).token}`,
    close: async () => {
      mothership.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // The mothership's side of each runner socket closes after the test's:
      // wait for it, or its detach reads a database already closed.
      await eventually(() => mothership.relay.connected().length === 0);
      db.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
};

export interface FakeRunner {
  runnerId: string;
  privateKey: string;
  socket: WebSocket;
  received: Message[];
  /** Answer requests of a type. */
  on: (type: string, answer: (message: Message) => unknown) => void;
  send: (message: Message) => void;
  /** Resolves once a message of the type has arrived. */
  next: (type: string) => Promise<Message>;
  close: () => Promise<void>;
}

/** Register a runner in the database and connect it over the real socket. */
export const connectRunner = async (
  harness: Harness,
  options: {
    name?: string;
    runnerId?: string;
    privateKey?: string;
    answerRequests?: boolean;
  } = {}
): Promise<FakeRunner> => {
  const keys = generateRunnerKeys();
  const runnerId = options.runnerId ?? newRunnerId();

  if (options.runnerId === undefined) {
    addRunner(
      harness.db,
      {
        id: runnerId,
        name: options.name ?? "Leslie's Mac mini",
        publicKey: keys.publicKey,
      },
      harness.clock.now
    );
  }

  const privateKey = options.privateKey ?? keys.privateKey;
  const socket = new WebSocket(
    `ws://127.0.0.1:${harness.port}/api/runner/socket`
  );
  const seen: {
    received: Message[];
    waiters: { type: string; resolve: (message: Message) => void }[];
  } = { received: [], waiters: [] };
  const answers = new Map<string, (message: Message) => unknown>();

  socket.on('message', (data) => {
    const message = parseMessage(data.toString());

    if (message === null) {
      return;
    }

    seen.received = [...seen.received, message];

    if (message.type === 'challenge') {
      socket.send(
        JSON.stringify({
          type: 'auth',
          runnerId,
          signature: signChallenge(
            privateKey,
            Buffer.from(String(message.challenge), 'base64')
          ),
        })
      );
    }

    seen.waiters
      .filter((waiter) => waiter.type === message.type)
      .forEach((waiter) => {
        seen.waiters = seen.waiters.filter((other) => other !== waiter);
        waiter.resolve(message);
      });
    const answer = answers.get(message.type);

    if (answer !== undefined && typeof message.id === 'string') {
      Promise.resolve()
        .then(() => answer(message))
        .then(
          (result) =>
            socket.send(
              JSON.stringify(resultOf(String(message.id), { ok: true, result }))
            ),
          (error: unknown) =>
            socket.send(
              JSON.stringify(
                resultOf(String(message.id), {
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                })
              )
            )
        );
    }
  });

  const next = (type: string): Promise<Message> => {
    const already = seen.received.find((message) => message.type === type);

    return already !== undefined
      ? Promise.resolve(already)
      : new Promise((resolve) => {
          seen.waiters = [...seen.waiters, { type, resolve }];
        });
  };

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });

  return {
    runnerId,
    privateKey,
    socket,
    get received() {
      return seen.received;
    },
    on: (type, answer) => answers.set(type, answer),
    send: (message) => socket.send(JSON.stringify(message)),
    next,
    close: () =>
      new Promise((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();

          return;
        }

        socket.once('close', () => resolve());
        socket.close();
      }),
  };
};

/** Wait until a condition holds (socket events land asynchronously). */
export const eventually = async (
  check: () => boolean,
  ms = 2000
): Promise<void> => {
  const deadline = Date.now() + ms;

  const attempt = async (): Promise<void> => {
    if (check()) {
      return;
    }

    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for a condition.');
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
    await attempt();
  };

  await attempt();
};

/** A runner holding "Pawnee Parks site" in a folder, on it right now. */
export const holdProject = (
  harness: Harness,
  runnerId: string,
  options: { name?: string; folder?: string; current?: boolean } = {}
): string => {
  const projectId = linkProject(
    harness.db,
    {
      runnerId,
      name: options.name ?? 'Pawnee Parks site',
      folder: options.folder ?? '/home/leslie/pawnee-parks',
    },
    harness.clock.now
  );

  if (options.current !== false) {
    harness.db
      .prepare('UPDATE runners SET current_project_id = ? WHERE id = ?')
      .run(projectId, runnerId);
  }

  return projectId;
};
