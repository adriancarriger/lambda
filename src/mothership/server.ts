import * as crypto from 'crypto';
import * as fs from 'fs';
import type * as http from 'http';
import type { Duplex } from 'stream';
import { WebSocket, WebSocketServer } from 'ws';

import type { TtsStatus } from '../app/shared/types';
import type { MachineConfig } from '../config/machineConfig';
import { flagUnfinishedStages, storeEvent } from '../events/store';
import {
  CHALLENGE_BYTES,
  type Message,
  RUNNER_TYPES,
  parseMessage,
  resultOf,
} from '../protocol';
import { parseIdentities } from '../tickets/assignees';
import { type AppContext, createAppRoutes } from './appRoutes';
import { handleClaimMessage } from './claims';
import { isEd25519PublicKey } from './crypto';
import type { Db } from './db';
import {
  type HostRules,
  checkBodyType,
  checkHostAndOrigin,
  isGated,
  isHttps,
  isPublic,
} from './gate';
import { json, readBody, refuse, remoteAddress, str } from './http';
import { redeemLoginLink } from './loginLink';
import { listAliases, ownerFromConfig } from './owner';
import {
  CODE_REFUSED,
  JOIN_CODE_REFUSED,
  TOO_MANY_TRIES,
  redeemWithLockout,
} from './pairing';
import { storeSnapshots } from './pods';
import { parseProtoPath, sessionSecret, verifyProtoToken } from './protoToken';
import { pruneSpent } from './prune';
import {
  addRunner,
  getRunner,
  linkProject,
  newRunnerId,
  projectOfFolder,
  removeRunner,
  runnerName,
  setRunnerProject,
  touchRunner,
} from './registry';
import { HttpError, type Relay, type RunnerLink, createRelay } from './relay';
import { type Route, matchRoute } from './routes';
import { isPodState, podStateProblem } from './runnerMessages';
import {
  type Session,
  createSession,
  deviceLabel,
  sessionCookie,
  tokenFromCookie,
  useSession,
} from './sessions';
import { serveStatic } from './static';
import {
  type NetworkControl,
  createTailscaleRoutes,
  defaultNetwork,
} from './tailscaleRoutes';
import { knownAssignees, setRunnerTrackers } from './trackers';

export interface MothershipOptions {
  db: Db;
  /** The mothership machine's ~/.lambda/config.json (owner, host, listen). */
  config: () => MachineConfig | null;
  port: number;
  /** The built client (dist/app). */
  clientDir: string;
  /** Where the time log, the page's log and uploads live (~/.lambda). */
  home: string;
  now?: () => number;
  log?: (line: string) => void;
  /** Request timeout for runners (tests shorten it). */
  timeoutMs?: number;
  /** How long a runner socket has to sign in (tests shorten it). */
  authTimeoutMs?: number;
  /** First run's routes (tests hand in their own home, pty and fetch). */
  setup?: AppContext['setup'];
  /** Add a computer's Tailscale check and listen (main hands in its listeners). */
  network?: NetworkControl;
}

export interface Mothership {
  handle: (
    request: http.IncomingMessage,
    response: http.ServerResponse
  ) => void;
  upgrade: (
    request: http.IncomingMessage,
    socket: Duplex,
    head: Buffer
  ) => void;
  relay: Relay;
  routes: Route[];
  /** Tell every open page something changed. */
  broadcast: () => void;
  /** The periodic duties: idle switches, owner pushes. */
  tick: () => Promise<void>;
  close: () => void;
}

/** On every mothership response: what tells it apart from another server. */
export const MOTHERSHIP_HEADER = 'x-lambda';
export const MOTHERSHIP_HEADER_VALUE = 'mothership';

/** The runner the host's first `lambda start` registered. */
export const HOST_RUNNER_SECRET = 'host_runner';

const MAX_RUNNER_NAME = 100;
/** 1 MiB: a runner frame before sign-in. */
export const MAX_RUNNER_FRAME = 1024 * 1024;
/**
 * 64 MiB: a signed-in runner's frame. A pod-state carries every pod of a
 * folder, questions and all, so a busy project outgrows 1 MiB; refused
 * there, the same item would be resent and refused forever.
 */
export const MAX_SIGNED_IN_FRAME = 64 * 1024 * 1024;
/** How long a refused socket's close frame gets before the line is cut. */
const CLOSE_GRACE_MS = 200;
/** How long a new runner socket has to answer the challenge. */
export const AUTH_TIMEOUT_MS = 10_000;
/** What the app sees when the mothership itself failed. */
export const SOMETHING_WENT_WRONG = 'Something went wrong.';
/** How long a read of the config is reused (it is read on every request). */
const CONFIG_REUSE_MS = 1000;

/** The request-target as a URL, or null when it isn't one (`GET //`). */
const parseUrl = (request: http.IncomingMessage): URL | null => {
  try {
    return new URL(request.url ?? '/', 'http://mothership');
  } catch {
    // Answered 400 by the caller.
    return null;
  }
};
export const NOT_A_RUNNER_KEY = "That isn't a runner key.";

export const hostRunnerId = (db: Db): string | null => {
  const row = db
    .prepare<[string], { value: string }>(
      'SELECT value FROM secrets WHERE name = ?'
    )
    .get(HOST_RUNNER_SECRET);

  return row?.value ?? null;
};

/** A path as the log keeps it: a prototype link's token is a live key. */
const loggedPath = (pathname: string): string =>
  pathname.replace(/^\/proto\/[^/]+/, '/proto/…');

const isRunnerType = (type: string): boolean =>
  RUNNER_TYPES.some((known) => known === type);

export const createMothership = (options: MothershipOptions): Mothership => {
  const { db } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.error(line));
  /** Each live `/api/events` stream → the device it's for. */
  const listeners = new Map<http.ServerResponse, string>();
  const ttsByRunner = new Map<string, TtsStatus>();
  /** Runners mid idle switch → the project they're moving to. */
  const switching = new Map<string, string>();
  /**
   * Runners → when they arrived on their current project (`runner-state`'s
   * `arrivedAt`): a project with no pods counts as idle from then.
   */
  const arrivals = new Map<string, number>();

  const configRead: { at: number; config: MachineConfig | null } = {
    at: Number.NEGATIVE_INFINITY,
    config: null,
  };
  const config = (): MachineConfig | null => {
    if (now() - configRead.at >= CONFIG_REUSE_MS) {
      configRead.config = options.config();
      configRead.at = now();
    }

    return configRead.config;
  };

  const hostRules = (): HostRules => {
    const mothership = config()?.mothership;

    return {
      port: options.port,
      listen: mothership?.listen,
      host: mothership?.host,
    };
  };
  const owner = () => ownerFromConfig(config());

  const broadcast = (): void => {
    listeners.forEach((_device, response) =>
      response.write('data: change\n\n')
    );
  };

  const answerRunner = (
    runnerId: string,
    message: Message,
    run: () => unknown
  ) => {
    const id = typeof message.id === 'string' ? message.id : null;

    try {
      const result = run();

      if (id !== null) {
        pushToRunner(runnerId, resultOf(id, { ok: true, result }));
      }
    } catch (error) {
      if (id !== null) {
        pushToRunner(
          runnerId,
          resultOf(id, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        );
      }
    }
  };

  /** An outbox item already stored: acknowledged again, not stored again. */
  const seen = (id: string): boolean =>
    db.prepare('SELECT 1 FROM received WHERE id = ?').get(id) !== undefined;
  const markSeen = (id: string): void => {
    db.prepare('INSERT OR IGNORE INTO received (id, at) VALUES (?, ?)').run(
      id,
      now()
    );
  };

  /**
   * What computers were last handed: the tick pushes the owner message again
   * when either changes. A computer's tracker report empties `assignees`.
   */
  const ownerPushed = {
    aliases: JSON.stringify(listAliases(db)),
    assignees: '',
  };

  const onRunnerMessage = (runnerId: string, message: Message): void => {
    touchRunner(db, runnerId, now());

    switch (message.type) {
      case 'pod-state': {
        if (!isPodState(message)) {
          const problem = podStateProblem(message) ?? 'unreadable';
          log(`Refusing a pod-state from ${runnerId}: ${problem}`);
          answerRunner(runnerId, message, () => {
            throw new Error(`That pod-state can't be stored: ${problem}`);
          });

          return;
        }

        answerRunner(runnerId, message, () => {
          const state = message;

          if (seen(state.id)) {
            return 'duplicate';
          }

          storeSnapshots(
            db,
            runnerId,
            state.folder,
            state.pods,
            state.removed,
            now(),
            state.all
          );

          if (state.tts !== undefined) {
            ttsByRunner.set(runnerId, state.tts);
          }

          markSeen(state.id);

          broadcast();

          return 'stored';
        });

        return;
      }
      case 'event': {
        const { id } = message;

        // The id is what makes a resend a duplicate: without one there is
        // nothing to dedupe by, and nothing to acknowledge.
        if (typeof id !== 'string' || id === '') {
          log(`Ignoring an event with no id from ${runnerId}.`);

          return;
        }

        // A rewritten file's event: its own id is `eventId`, and `id` is
        // only the outbox's (see `eventMessage`). Generation 0 sends just `id`.
        const { generation = 0, eventId = id } = message;

        if (
          typeof generation !== 'number' ||
          !Number.isInteger(generation) ||
          generation < 0 ||
          typeof eventId !== 'string' ||
          (generation > 0 && message.eventId === undefined)
        ) {
          log(
            `Ignoring event ${id} from ${runnerId}: generation ${String(
              generation
            )} with no eventId.`
          );

          return;
        }

        answerRunner(runnerId, message, () => {
          const folder = String(message.folder);
          const projectId = projectOfFolder(db, runnerId, folder);

          // Stored with no project, no Analytics page would ever show it:
          // refused, it stays in the runner's outbox until the folder is linked.
          if (projectId === null) {
            log(
              `Refusing event ${id} from ${runnerId}: ${folder} is no codebase.`
            );

            throw new Error(`${folder} isn't a codebase of this computer yet.`);
          }

          return storeEvent(db, {
            id: eventId,
            generation,
            projectId,
            event: message.event,
            receivedAt: now(),
          });
        });

        return;
      }
      case 'runner-state': {
        const folder =
          typeof message.folder === 'string' ? message.folder : null;
        const projectId =
          folder === null ? null : projectOfFolder(db, runnerId, folder);
        const target =
          typeof message.switching === 'string'
            ? projectOfFolder(db, runnerId, message.switching)
            : null;

        if (target === null) {
          switching.delete(runnerId);
        } else {
          switching.set(runnerId, target);
        }

        if (typeof message.arrivedAt === 'number') {
          arrivals.set(runnerId, message.arrivedAt);
        } else {
          arrivals.delete(runnerId);
        }

        // Acknowledged like every outbox item, so it leaves the runner's
        // outbox once it has arrived.
        answerRunner(runnerId, message, () =>
          setRunnerProject(
            db,
            runnerId,
            projectId,
            target === null ? 'idle' : 'switching'
          )
        );
        broadcast();

        return;
      }
      case 'project-link':
        answerRunner(runnerId, message, () => ({
          projectId: linkProject(
            db,
            {
              runnerId,
              name: str(message, 'name'),
              folder: str(message, 'folder'),
              description:
                typeof message.description === 'string'
                  ? message.description
                  : null,
              ticketPrefix:
                typeof message.ticketPrefix === 'string'
                  ? message.ticketPrefix
                  : null,
            },
            now()
          ),
        }));
        broadcast();

        return;
      case 'leave':
        arrivals.delete(runnerId);
        answerRunner(runnerId, message, () => {
          removeRunner(db, runnerId);

          // For "✓ Left Leslie Knope's Lambda".
          return owner().name;
        });
        sockets.get(runnerId)?.close(4000, 'left');
        broadcast();

        return;
      case 'tracker-identity':
        answerRunner(runnerId, message, () =>
          setRunnerTrackers(
            db,
            runnerId,
            parseIdentities(message.identities),
            now()
          )
        );
        // The map changed for every computer: the tick hands it out.
        ownerPushed.assignees = '';
        broadcast();

        return;
      case 'ticket-claim':
      case 'ticket-claims':
      case 'ticket-release':
      case 'ticket-shipped':
        answerRunner(runnerId, message, () =>
          handleClaimMessage(
            { db, runnerId, owner, now, seen, markSeen },
            message
          )
        );

        return;
      case 'result':
        // The relay settles every result a request is waiting for: this one's
        // request already timed out (or was never this runner's).
        log(
          `Ignoring a late result for ${String(message.id)} from ${runnerName(
            db,
            runnerId
          )}.`
        );

        return;
      default:
        log(`Ignoring a runner message of unknown type "${message.type}".`);
    }
  };

  const relay = createRelay({
    runnerName: (id) => runnerName(db, id),
    onMessage: onRunnerMessage,
    timeoutMs: options.timeoutMs,
  });
  // `push` is a closure; called bare because the lint rule flags `.push(`.
  const { push: pushToRunner } = relay;

  const app = createAppRoutes({
    db,
    relay,
    home: options.home,
    now,
    owner,
    broadcast,
    listeners,
    switching,
    arrivals,
    tts: () => [...ttsByRunner.values()][0],
    hostRunnerId: () => hostRunnerId(db),
    config: options.config,
    log,
    setup: options.setup,
  });
  const routes: Route[] = [
    ...app.routes,
    ...createTailscaleRoutes({
      network: options.network ?? defaultNetwork(),
      port: options.port,
      configChanged: () => {
        configRead.at = Number.NEGATIVE_INFINITY;
      },
    }),
  ];

  // ── the runner socket ──────────────────────────────────────────────────────
  const wss = new WebSocketServer({
    noServer: true,
    // A signed-in runner's largest message is a pod-state of every pod in a
    // folder; before sign-in the raw bytes are counted (`capBeforeSignIn`),
    // so a stranger can't make the mothership hold a 64 MiB frame.
    maxPayload: MAX_SIGNED_IN_FRAME,
  });
  const sockets = new Map<string, WebSocket>();
  const closed = { value: false };

  /** The assignee map as every computer is handed it, right now. */
  const assigneesNow = () => {
    const who = owner();

    return knownAssignees(db, { name: who.name, email: who.email });
  };

  const pushOwner = (runnerId: string): void => {
    const who = owner();
    pushToRunner(runnerId, {
      type: 'owner',
      name: who.name,
      email: who.email,
      aliases: listAliases(db),
      assignees: assigneesNow(),
    });
  };

  /**
   * Before sign-in nothing may be bigger than MAX_RUNNER_FRAME, counted as
   * the bytes arrive: ws only hands a frame over once it's whole, by which
   * time it's all in memory. Past the cap the socket is closed (1009) and
   * read no further.
   */
  const capBeforeSignIn = (
    socket: WebSocket,
    raw: Duplex,
    state: { runnerId: string | null }
  ): void => {
    const seen = { bytes: 0 };
    const count = (chunk: Buffer): void => {
      if (state.runnerId !== null) {
        raw.off('data', count);

        return;
      }

      seen.bytes += chunk.length;

      if (seen.bytes <= MAX_RUNNER_FRAME) {
        return;
      }

      raw.off('data', count);
      raw.pause();
      socket.close(1009, 'too big before sign-in');
      setTimeout(() => raw.destroy(), CLOSE_GRACE_MS).unref();
    };
    raw.on('data', count);
  };

  const onSocket = (socket: WebSocket, raw: Duplex): void => {
    const challenge = crypto.randomBytes(CHALLENGE_BYTES);
    const state: { runnerId: string | null } = { runnerId: null };
    capBeforeSignIn(socket, raw, state);
    // A socket that never signs in is closed, not kept open forever.
    const signInTimer = setTimeout(() => {
      if (state.runnerId === null) {
        socket.close(4408, 'sign in took too long');
      }
    }, options.authTimeoutMs ?? AUTH_TIMEOUT_MS);
    socket.on('close', () => clearTimeout(signInTimer));
    // A frame over the cap, or a broken frame: ws closes the socket itself
    // (1009, 1002); without a listener the error would end the process.
    socket.on('error', (error) =>
      log(`A runner socket failed: ${error.message}`)
    );
    socket.send(
      JSON.stringify({
        type: 'challenge',
        challenge: challenge.toString('base64'),
      })
    );

    socket.on('message', (data) => {
      const message = parseMessage(data.toString());

      if (state.runnerId === null) {
        const runnerId = verifyAuth(message, challenge);

        if (runnerId === null) {
          socket.close(4401, 'not a runner');

          return;
        }

        state.runnerId = runnerId;
        clearTimeout(signInTimer);
        const link: RunnerLink = {
          send: (outgoing) => socket.send(JSON.stringify(outgoing)),
          close: () => socket.close(4000, 'replaced'),
        };
        sockets.set(runnerId, socket);
        relay.attach(runnerId, link);
        socket.on('close', () => {
          relay.detach(runnerId, link);

          // Closing down: the database may already be gone.
          if (closed.value) {
            return;
          }

          if (sockets.get(runnerId) === socket) {
            sockets.delete(runnerId);
            switching.delete(runnerId);
          }

          touchRunner(db, runnerId, now());
          broadcast();
        });
        touchRunner(db, runnerId, now());
        pushOwner(runnerId);
        broadcast();

        return;
      }

      if (closed.value) {
        return;
      }

      if (message === null) {
        log('Ignoring a runner message that is not JSON with a type.');

        return;
      }

      if (!isRunnerType(message.type)) {
        log(`Ignoring a runner message of unknown type "${message.type}".`);

        return;
      }

      relay.receive(state.runnerId, message);
    });
  };

  const verifyAuth = (
    message: Message | null,
    challenge: Buffer
  ): string | null => {
    if (
      message === null ||
      message.type !== 'auth' ||
      typeof message.runnerId !== 'string' ||
      typeof message.signature !== 'string'
    ) {
      return null;
    }

    const runner = getRunner(db, message.runnerId);

    if (runner === null) {
      return null;
    }

    try {
      return crypto.verify(
        null,
        challenge,
        runner.publicKey,
        Buffer.from(message.signature, 'base64')
      )
        ? runner.id
        : null;
    } catch {
      return null;
    }
  };

  const upgrade = (
    request: http.IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): void => {
    const url = parseUrl(request);

    if (url === null) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();

      return;
    }

    const verdict = checkHostAndOrigin(request, url.pathname, hostRules());

    if (url.pathname !== '/api/runner/socket' || !verdict.ok) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();

      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => onSocket(ws, socket));
  };

  // ── the public routes ──────────────────────────────────────────────────────
  const signIn = (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    status: number,
    extra: Record<string, string> = {}
  ): void => {
    const { token } = createSession(
      db,
      deviceLabel(owner().name, request.headers['user-agent']),
      now()
    );
    response.writeHead(status, {
      'set-cookie': sessionCookie(token, isHttps(request)),
      'cache-control': 'no-store',
      ...extra,
    });
  };

  const handlePublic = async (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL
  ): Promise<void> => {
    if (url.pathname === '/auth/link') {
      if (redeemLoginLink(db, url.searchParams.get('t') ?? '', now())) {
        signIn(request, response, 303, { location: '/' });
        response.end();

        return;
      }

      response.writeHead(303, { location: '/', 'cache-control': 'no-store' });
      response.end();

      return;
    }

    if (url.pathname === '/api/auth/pair') {
      const body = await readBody(request);
      const outcome = redeemWithLockout(
        db,
        'device',
        typeof body.code === 'string' ? body.code : '',
        remoteAddress(request),
        now()
      );

      if (outcome === 'ok') {
        signIn(request, response, 200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));

        return;
      }

      refuse(
        response,
        outcome === 'locked' ? 429 : 400,
        outcome === 'locked' ? TOO_MANY_TRIES : CODE_REFUSED
      );

      return;
    }

    if (url.pathname === '/api/runners/join') {
      const body = await readBody(request);
      // Checked before the code is used: a bad body never burns a good code.
      const name = str(body, 'name').trim();
      const publicKey = str(body, 'publicKey');

      if (name === '' || name.length > MAX_RUNNER_NAME) {
        throw new HttpError(400, 'Give this computer a shorter name.');
      }

      if (!isEd25519PublicKey(publicKey)) {
        throw new HttpError(400, NOT_A_RUNNER_KEY);
      }

      const runnerId = newRunnerId();
      // The code is used and the runner stored together, or neither.
      const outcome = db.transaction(() => {
        const redeemed = redeemWithLockout(
          db,
          'runner',
          typeof body.code === 'string' ? body.code : '',
          remoteAddress(request),
          now()
        );

        if (redeemed === 'ok') {
          addRunner(db, { id: runnerId, name, publicKey }, now());
        }

        return redeemed;
      })();

      if (outcome !== 'ok') {
        refuse(
          response,
          outcome === 'locked' ? 429 : 400,
          outcome === 'locked' ? TOO_MANY_TRIES : JOIN_CODE_REFUSED
        );

        return;
      }

      json(response, 200, {
        ok: true,
        result: { runnerId, owner: owner().name },
      });
      broadcast();

      return;
    }

    // GET /api/runner/socket without an upgrade.
    refuse(response, 426, 'This is the runner socket.');
  };

  // ── prototypes: the session, or a link token for that one version ──────────
  const handleProto = async (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL
  ): Promise<void> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      refuse(response, 405, 'Prototype files are read-only.');

      return;
    }

    const parts = parseProtoPath(url.pathname);
    // A sandboxed frame's own requests may carry no cookie, so a token for
    // exactly this version also lets them in.
    const tokenOpens =
      parts !== null &&
      parts.token !== null &&
      verifyProtoToken(
        sessionSecret(db),
        parts.token,
        parts.pod,
        parts.slug,
        parts.version,
        now()
      );
    const signedIn =
      useSession(db, tokenFromCookie(request.headers.cookie), now()) !== null;

    // Signed in, a path that names no prototype file is simply not found.
    if (parts === null && signedIn) {
      refuse(response, 404, 'Not found.');

      return;
    }

    if (parts === null || !(tokenOpens || signedIn)) {
      refuse(response, 401, 'Sign in first.');

      return;
    }

    await app.serveProto(request, response, parts);
  };

  // ── the gate, then dispatch ────────────────────────────────────────────────
  const dispatch = async (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL
  ): Promise<void> => {
    const method = request.method ?? 'GET';
    const hostAndOrigin = checkHostAndOrigin(
      request,
      url.pathname,
      hostRules()
    );

    if (!hostAndOrigin.ok) {
      refuse(response, hostAndOrigin.status, hostAndOrigin.error);

      return;
    }

    if (isPublic(method, url.pathname)) {
      const body = checkBodyType(request, url.pathname);

      if (!body.ok) {
        refuse(response, body.status, body.error);

        return;
      }

      await handlePublic(request, response, url);

      return;
    }

    if (url.pathname.startsWith('/proto/')) {
      await handleProto(request, response, url);

      return;
    }

    if (!isGated(url.pathname)) {
      serveStatic(options.clientDir, url.pathname, response);

      return;
    }

    const token = tokenFromCookie(request.headers.cookie);
    const session: Session | null = useSession(db, token, now());

    if (session === null || token === undefined) {
      refuse(response, 401, 'Sign in first.');

      return;
    }

    // Sliding on the browser's side too: every signed-in request sends the
    // cookie again, good for 30 days from now, as the row was just renewed.
    response.setHeader('set-cookie', sessionCookie(token, isHttps(request)));

    const body = checkBodyType(request, url.pathname);

    if (!body.ok) {
      refuse(response, body.status, body.error);

      return;
    }

    const matched = matchRoute(routes, method, url.pathname);

    if (matched === null) {
      refuse(response, 404, 'No such route.');

      return;
    }

    await matched.route.handle({
      request,
      response,
      url,
      params: matched.params,
      session,
    });
  };

  const handle = (
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): void => {
    const parsed = parseUrl(request);

    if (parsed === null) {
      refuse(response, 400, 'Bad request.');

      return;
    }

    const url = parsed;
    // How `lambda start` and `lambda open` know it's this, not some other
    // server holding the port.
    response.setHeader(MOTHERSHIP_HEADER, MOTHERSHIP_HEADER_VALUE);

    dispatch(request, response, url).catch((error: unknown) => {
      // Only an HttpError's words are meant for the app; anything else is
      // the mothership's own failure, kept in the log.
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      log(
        `[${new Date(now()).toISOString()}] ${
          request.method ?? '?'
        } ${loggedPath(url.pathname)} failed: ${message}`
      );

      if (!response.headersSent) {
        if (status === 413) {
          // The body is still arriving: close rather than read the rest.
          response.setHeader('connection', 'close');
        }

        refuse(
          response,
          status,
          error instanceof HttpError ? message : SOMETHING_WENT_WRONG
        );

        return;
      }

      response.end();
    });
  };

  const tick = async (): Promise<void> => {
    // An alias added with `lambda account alias` writes the file, not us;
    // a computer renamed or reporting a new tracker user changes the map.
    const aliases = JSON.stringify(listAliases(db));
    const assignees = JSON.stringify(assigneesNow());

    if (
      aliases !== ownerPushed.aliases ||
      assignees !== ownerPushed.assignees
    ) {
      ownerPushed.aliases = aliases;
      ownerPushed.assignees = assignees;
      relay.connected().forEach(pushOwner);
    }

    pruneSpent(db, now());

    // A stage still open after 24 hours becomes a stored warning row.
    if (flagUnfinishedStages(db, now()) > 0) {
      broadcast();
    }

    await app.idleSwitches();
    app.keepBuilding();
  };

  return {
    handle,
    upgrade,
    relay,
    routes,
    broadcast,
    tick,
    close: () => {
      closed.value = true;
      listeners.forEach((_device, response) => response.end());
      sockets.forEach((socket) => socket.close(1001, 'mothership stopping'));
      wss.close();
    },
  };
};

/** The built client, or a plain note when it hasn't been built. */
export const clientBuilt = (clientDir: string): boolean =>
  fs.existsSync(`${clientDir}/index.html`);
