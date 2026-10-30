import * as fs from 'fs';
import type * as http from 'http';
import * as path from 'path';
import { z } from 'zod';

import { prototypeHeaders, withBridge } from '../app/server/prototypes';
import { type TimeEntry, addTime, timeSummary } from '../app/server/timeLog';
import { parseRange } from '../app/server/tts/timing';
import { MP3_TYPE, audioTypeOf } from '../app/server/tts/wav';
import type { DesignSystemPage } from '../app/shared/designSystem';
import type { Made } from '../app/shared/prototypes';
import type { PodIntake } from '../app/shared/snapshot';
import type { Panes, TtsStatus } from '../app/shared/types';
import { waitingPodId } from '../app/shared/waitingPod';
import type { MachineConfig } from '../config/machineConfig';
import { computeAnalytics } from '../events/analytics';
import { listEvents } from '../events/store';
import { decideSwitch } from '../runner/projectSwitch';
import {
  type SetupRouteOptions,
  createSetupRoutes,
  realSetupOptions,
} from '../setup/routes';
import { sharedTrackerUsers } from '../tickets/assignees';
import {
  type Holder,
  computerState,
  findComputer,
  placePod,
} from './computers';
import type { Db } from './db';
import { isHttps } from './gate';
import { json, optStr, readBody, str } from './http';
import { buildingStarts } from './keepBuilding';
import { type Owner, addAliasTo, isOwnersLogin } from './owner';
import { createCode } from './pairing';
import {
  addWaitingPod,
  adoptWaitingPod,
  buildAppState,
  claimWaitingPods,
  locatePod,
  releaseStrandedClaims,
  releaseWaitingPod,
  snapshotsOf,
  unstartedWaitingPods,
} from './pods';
import { protoToken, sessionSecret } from './protoToken';
import {
  folderOf,
  getProject,
  getRunner,
  holdings,
  holdingsOf,
  lastUsedProject,
  linkProject,
  listProjects,
  listRunners,
  runnerName,
  useProject,
} from './registry';
import { HttpError, type Relay, offline } from './relay';
import type { Route, RouteContext } from './routes';
import { clearedCookie, endDevice, listDevices } from './sessions';
import { BUILDING_START_TIMEOUT_MS, createTicketRoutes } from './ticketRoutes';
import { computerIdentities } from './trackers';
import { saveUpload, saveUploadUrl, serveUpload } from './uploads';
import { createViewRoutes } from './viewRoutes';

/**
 * Every signed-in route the app uses. Reads of the mothership's own data
 * answer from the database; anything about a pod goes to the runner that has
 * it, which runs it through `lambda pod`.
 */

export interface AppContext {
  db: Db;
  relay: Relay;
  home: string;
  now: () => number;
  owner: () => Owner;
  broadcast: () => void;
  /** Each live `/api/events` stream → the device it's for. */
  listeners: Map<http.ServerResponse, string>;
  /** Runners mid idle switch → the project they're moving to. */
  switching: Map<string, string>;
  /** Runners → when they arrived on their current project (epoch ms). */
  arrivals: Map<string, number>;
  tts: () => TtsStatus | undefined;
  hostRunnerId: () => string | null;
  config: () => MachineConfig | null;
  /** The mothership's log: what failed in the background, and why. */
  log: (line: string) => void;
  /** First run's routes (tests hand in their own home, pty and fetch). */
  setup?: Partial<SetupRouteOptions>;
}

/** Today's POST table: each runs on the pod's runner as a pod action. */
export const POD_ACTIONS = [
  'answer',
  'checkpoint-complete',
  'chat',
  'carry-on',
  'rename',
  'render-mode',
  'delete',
  'nudge',
  'structure',
  'skip',
  'fork/warm',
  'chat/send',
  'judgements/keep',
  'request/add',
  'chat/warm',
  'fork/send',
  'fork/close',
  'fork/park',
  'fork/discard',
  'tts/clip',
  // Building pods: the header's Pause/Resume, and the Product manager chat.
  'pause',
  'resume',
  'pm-chat',
] as const;

/** A pod that makes its computer switch projects waits this long for its id. */
export const SWITCH_TIMEOUT_MS = 15 * 60_000;

/**
 * A waiting pod whose start failed isn't tried again for this long: a start
 * that timed out may still have made the pod, and its first state says so.
 */
export const WAITING_RETRY_MS = 5 * 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

// The runner is ours: a shape check on the top-level keys is enough.
const isMade = (value: unknown): value is Made =>
  isRecord(value) &&
  Array.isArray(value.prototypes) &&
  Array.isArray(value.pictures);

const isPanes = (value: unknown): value is Panes =>
  isRecord(value) &&
  Array.isArray(value.others) &&
  Array.isArray(value.working);

const isLinkedFolder = (
  value: unknown
): value is {
  name: string;
  folder: string;
  description?: string;
  ticketPrefix?: string;
} =>
  isRecord(value) &&
  typeof value.name === 'string' &&
  typeof value.folder === 'string';

const unexpected = (what: string): Error =>
  new Error(`Unexpected answer from the computer to ${what}.`);

/** A link the page opens: http(s) only, or none. */
const LinkAnswer = z
  .string()
  .regex(/^https?:\/\//i)
  .nullable();

/**
 * A computer's Settings → Design system page: every field the page reads,
 * checked, and nothing else relayed.
 */
const DesignSystemPageAnswer = z.object({
  project: z.string(),
  branch: z.string(),
  dir: z.string(),
  look: z.string(),
  components: z.string(),
  designAvailable: z.boolean().nullable(),
  setupTicket: z
    .object({
      id: z.string(),
      title: z.string(),
      url: LinkAnswer,
      status: z.enum([
        'planning',
        'ready',
        'building',
        'blocked',
        'done',
        'canceled',
      ]),
      blockReason: z.string().nullable(),
    })
    .nullable(),
  system: z
    .object({
      version: z.number().nullable(),
      madeByHand: z.boolean(),
      syncedBy: z.string().nullable(),
      builtFrom: z.string().nullable(),
      source: z.enum(['code', 'photos', 'code+photos']).nullable(),
      check: z
        .object({
          result: z.enum(['match', 'close', 'not-checked']),
          rounds: z.number(),
          photos: z.number(),
          issues: z.array(
            z.object({
              severity: z.enum(['high', 'medium', 'medium-low', 'low']),
              where: z.string(),
              what: z.string(),
            })
          ),
          reason: z.string().optional(),
        })
        .nullable(),
      components: z.array(z.string()),
      patterns: z.array(z.string()),
      screens: z.array(z.string()),
      sampleData: z.boolean(),
      lastChanged: z
        .object({ ticket: z.string(), sha: z.string(), rest: z.string() })
        .nullable(),
      picturesUrl: LinkAnswer,
    })
    .nullable(),
  ticketsError: z.string().nullable(),
}) satisfies z.ZodType<DesignSystemPage>;

/** A computer's Make it answer: the ticket it created, or the open one. */
const MadeAnswer = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string().nullable().optional(),
  existing: z.boolean().optional(),
});

const ok = (response: http.ServerResponse, result: unknown): void =>
  json(response, 200, { ok: true, result });

/** The pod folders `/api/pod-file/` serves. */
const PICTURE_FOLDERS = ['screenshots', 'designs', 'shots'];

const decodeFile = (
  result: unknown
): { bytes: Buffer; headers: Record<string, string> } | null => {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('base64' in result) ||
    typeof result.base64 !== 'string'
  ) {
    return null;
  }

  const headers =
    'headers' in result &&
    typeof result.headers === 'object' &&
    result.headers !== null
      ? Object.fromEntries(
          Object.entries(result.headers).map(([key, value]) => [
            key,
            String(value),
          ])
        )
      : {};

  return { bytes: Buffer.from(result.base64, 'base64'), headers };
};

export const createAppRoutes = (context: AppContext) => {
  const { db, relay, now } = context;
  const timeFile = path.join(context.home, '_time.json');
  const uiLog = path.join(context.home, '_ui.log');
  const uploads = path.join(context.home, '_uploads');

  /** Send to the runner that has the pod: 404 unknown, 409 offline. */
  const toPod = async (
    podId: string,
    message: Record<string, unknown> & { type: string }
  ): Promise<unknown> => {
    const location = locatePod(db, podId);

    if (location === null) {
      throw new HttpError(404, `No pod ${podId}`);
    }

    return relay.request(location.runnerId, {
      ...message,
      podId,
      folder: location.folder,
    });
  };

  /**
   * One file of a pod's folder, from the runner that has it: the mothership
   * reads none of a pod's files itself.
   */
  const podFile = async (
    podId: string,
    folder: string,
    rest: string
  ): Promise<unknown> => {
    const location = locatePod(db, podId);

    if (location === null) {
      throw new HttpError(404, `No pod ${podId}`);
    }

    return relay.request(location.runnerId, {
      type: 'pod-file',
      podId,
      folder,
      path: rest,
      projectFolder: location.folder,
    });
  };

  const podAction = (
    podId: string,
    action: string,
    body: Record<string, unknown> = {}
  ): Promise<unknown> => toPod(podId, { type: 'pod-action', action, body });

  const holdersOf = (projectId: string): Holder[] =>
    holdingsOf(db, projectId).flatMap((holding) => {
      const runner = getRunner(db, holding.runnerId);

      return runner === null
        ? []
        : [
            {
              runnerId: runner.id,
              name: runner.name,
              connected: relay.isConnected(runner.id),
              currentProjectId: runner.currentProjectId,
              lastSeenAt: runner.lastSeenAt,
              switching: context.switching.has(runner.id),
            },
          ];
    });

  /**
   * A connected runner holding the project: the one already on it, else the
   * one seen most recently.
   */
  const runnerForProject = (projectId: string): string => {
    const holders = holdersOf(projectId);
    const connected = holders
      .filter((holder) => holder.connected)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    const best =
      connected.find((holder) => holder.currentProjectId === projectId) ??
      connected[0];

    if (best !== undefined) {
      return best.runnerId;
    }

    const [latest] = [...holders].sort((a, b) => b.lastSeenAt - a.lastSeenAt);

    throw offline(latest?.name ?? 'Its computer');
  };

  const projectParam = (url: URL): string => {
    const id = url.searchParams.get('projectId') ?? lastUsedProject(db)?.id;

    if (id === undefined || getProject(db, id) === null) {
      throw new HttpError(404, 'No such codebase.');
    }

    return id;
  };

  /** A project id from the path: 404 when there's no such project. */
  const knownProject = (id: string | undefined): string => {
    if (id === undefined || getProject(db, id) === null) {
      throw new HttpError(404, 'No such codebase.');
    }

    return id;
  };

  const hostRunner = (): string => {
    const id = context.hostRunnerId();

    if (id === null) {
      throw new HttpError(
        409,
        'Run lambda start on the computer running Lambda first.'
      );
    }

    if (!relay.isConnected(id)) {
      throw offline(runnerName(db, id));
    }

    return id;
  };

  // ── a pod asked for: now, or waiting for its computer ──────────────────────
  const newPod = async (body: Record<string, unknown>): Promise<string> => {
    const text = str(body, 'text');
    const projectId = optStr(body, 'projectId') ?? lastUsedProject(db)?.id;

    if (projectId === undefined || getProject(db, projectId) === null) {
      throw new HttpError(400, 'Add a codebase first.');
    }

    const intake: PodIntake = {
      text,
      freeform: body.freeform === true,
      single: body.single === true,
    };
    const placement = placePod(projectId, holdersOf(projectId));

    if (placement.kind === 'offline') {
      throw offline(placement.name);
    }

    if (placement.kind === 'none') {
      throw new HttpError(409, 'No computer has this codebase yet.');
    }

    if (placement.kind === 'wait') {
      const id = addWaitingPod(db, projectId, intake, now());
      // A pod created in it (waiting for its computer): the last project used.
      useProject(db, projectId, now());
      context.broadcast();
      // Not awaited: the pod is already kept. A failure is logged, never an
      // unhandled rejection (which would end the process).
      idleSwitches().catch((error: unknown) =>
        context.log(
          `Couldn't look for a computer to start a waiting pod: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      );

      return waitingPodId(id);
    }

    const folder = folderOf(db, placement.runnerId, projectId);
    const podId = String(
      await relay.request(placement.runnerId, {
        type: 'pod-new',
        folder,
        projectId,
        intake,
      })
    );
    // A pod created in it: the last project used.
    useProject(db, projectId, now());

    return podId;
  };

  // ── the idle project switch ────────────────────────────────────────────────
  const inFlight = new Set<string>();

  const startWaiting = async (
    runnerId: string,
    projectId: string
  ): Promise<void> => {
    const folder = folderOf(db, runnerId, projectId);
    const candidates = unstartedWaitingPods(db, now())
      .filter((row) => row.projectId === projectId)
      .sort((a, b) => a.createdAt - b.createdAt);

    if (folder === null || candidates.length === 0) {
      return;
    }

    // Claimed before it's asked for: another idle runner holding the project
    // finds them taken and leaves them alone.
    const claimed = new Set(
      claimWaitingPods(
        db,
        runnerId,
        candidates.map((row) => row.id),
        now()
      )
    );
    const rows = candidates.filter((row) => claimed.has(row.id));

    if (rows.length === 0) {
      return;
    }

    const started = new Set<string>();
    inFlight.add(runnerId);

    if (getRunner(db, runnerId)?.currentProjectId !== projectId) {
      context.switching.set(runnerId, projectId);
    }

    context.broadcast();

    try {
      await rows.reduce<Promise<void>>(async (done, row) => {
        await done;
        const podId = await relay.request(
          runnerId,
          { type: 'pod-new', folder, projectId, intake: row.intake },
          // Stop, start and resume come first: minutes, not seconds.
          SWITCH_TIMEOUT_MS
        );

        if (typeof podId !== 'string' || podId === '') {
          throw new Error(`${runnerName(db, runnerId)} started no pod.`);
        }

        started.add(row.id);

        // The waiting row takes the new pod's state from here on.
        if (!adoptWaitingPod(db, row.id, podId, runnerId, now())) {
          throw new Error(`Its waiting row was gone when ${podId} started.`);
        }

        context.broadcast();
      }, Promise.resolve());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The rest wait again, held back so a start that did happen isn't
      // repeated straight away.
      rows
        .filter((row) => !started.has(row.id))
        .forEach((row) =>
          releaseWaitingPod(
            db,
            row.id,
            { error: message, retryAt: now() + WAITING_RETRY_MS },
            now()
          )
        );

      throw error;
    } finally {
      inFlight.delete(runnerId);
      context.switching.delete(runnerId);
      context.broadcast();
    }
  };

  /** Start a project's waiting pods on a runner; a failure is logged. */
  const tryStartWaiting = (runnerId: string, projectId: string) =>
    startWaiting(runnerId, projectId).catch((error: unknown) =>
      context.log(
        `Couldn't start a waiting pod on ${runnerName(db, runnerId)} for ${
          getProject(db, projectId)?.name ?? projectId
        }: ${error instanceof Error ? error.message : String(error)}`
      )
    );

  /** Computers starting a building pod now, and when each was last tried. */
  const buildingInFlight = new Set<string>();
  const buildingTried = new Map<string, number>();

  /**
   * Each connected computer on a project, with no building pod (a paused one
   * counts), gets one, made PAUSED: nothing is built until someone resumes it.
   * Not awaited: a start can take minutes, and the tick must not wait for it.
   */
  const keepBuilding = (): void => {
    const candidates = relay
      .connected()
      .filter((runnerId) => !buildingInFlight.has(runnerId))
      .flatMap((runnerId) => {
        const runner = getRunner(db, runnerId);

        if (runner === null) {
          return [];
        }

        const projectId = runner.currentProjectId;

        return [
          {
            runnerId,
            currentProjectId: projectId,
            switching: context.switching.has(runnerId),
            hasFolder:
              projectId !== null && folderOf(db, runnerId, projectId) !== null,
            snapshots: snapshotsOf(db, runnerId).map(
              ({ snapshot }) => snapshot
            ),
          },
        ];
      });

    buildingStarts(candidates, buildingTried, now()).forEach(
      ({ runnerId, projectId }) => {
        const folder = folderOf(db, runnerId, projectId);

        if (folder === null) {
          return;
        }

        buildingInFlight.add(runnerId);
        buildingTried.set(runnerId, now());
        relay
          .request(
            runnerId,
            { type: 'building-start', folder, projectId, paused: true },
            BUILDING_START_TIMEOUT_MS
          )
          .then(() => context.broadcast())
          .catch((error: unknown) =>
            context.log(
              `Starting building on ${runnerName(db, runnerId)} failed: ${
                error instanceof Error ? error.message : String(error)
              }`
            )
          )
          .finally(() => buildingInFlight.delete(runnerId));
      }
    );
  };

  /** For each connected, idle runner with another project waiting: switch. */
  const idleSwitches = async (): Promise<void> => {
    const released = releaseStrandedClaims(
      db,
      (runnerId) => inFlight.has(runnerId),
      {
        error: 'Lambda stopped before its computer started it.',
        retryAt: now() + WAITING_RETRY_MS,
      },
      now()
    );

    if (released > 0) {
      context.broadcast();
    }

    const waiting = unstartedWaitingPods(db, now());

    if (waiting.length === 0) {
      return;
    }

    const all = holdings(db);
    await Promise.all(
      relay
        .connected()
        .filter((runnerId) => !inFlight.has(runnerId))
        .map(async (runnerId) => {
          const runner = getRunner(db, runnerId);
          const held = new Set(
            all
              .filter((holding) => holding.runnerId === runnerId)
              .map((holding) => holding.projectId)
          );
          const current = runner?.currentProjectId ?? null;

          // A pod waiting on the project it's already on: nothing to switch.
          if (
            current !== null &&
            waiting.some((row) => row.projectId === current)
          ) {
            await tryStartWaiting(runnerId, current);

            return;
          }

          const target = decideSwitch({
            now: now(),
            arrivedAt: context.arrivals.get(runnerId),
            activity: snapshotsOf(db, runnerId)
              .filter(
                ({ projectId }) => current === null || projectId === current
              )
              .map(({ snapshot }) => snapshot.activity),
            waiting: waiting
              .filter((row) => held.has(row.projectId))
              .map((row) => ({
                projectId: row.projectId,
                createdAt: row.createdAt,
              })),
          });

          if (target !== null) {
            await tryStartWaiting(runnerId, target);
          }
        })
    );
  };

  /** The connected runner a waiting pod waits on, for its label. */
  const busyRunnerFor = (projectId: string): string | null =>
    holdersOf(projectId).find((holder) => holder.connected)?.runnerId ?? null;

  // ── files from a runner ────────────────────────────────────────────────────
  const sendFile = (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    result: unknown,
    type: string
  ): void => {
    const file = decodeFile(result);

    if (file === null) {
      response.writeHead(404).end();

      return;
    }

    const range = parseRange(request.headers.range, file.bytes.length);
    // A clip is MP3, or WAV where ffmpeg isn't installed (Kokoro in the app).
    const headers = {
      'content-type': type === MP3_TYPE ? audioTypeOf(file.bytes) : type,
      ...file.headers,
    };

    if (range === 'unsatisfiable') {
      response.writeHead(416, {
        'content-range': `bytes */${file.bytes.length}`,
      });
      response.end();

      return;
    }

    if (range === null) {
      response.writeHead(200, {
        ...headers,
        'content-length': file.bytes.length,
      });
      response.end(request.method === 'HEAD' ? undefined : file.bytes);

      return;
    }

    response.writeHead(206, {
      ...headers,
      'content-range': `bytes ${range.start}-${range.end}/${file.bytes.length}`,
      'content-length': range.end - range.start + 1,
    });
    response.end(file.bytes.subarray(range.start, range.end + 1));
  };

  const withBases = (podId: string, made: Made): Made => {
    const secret = sessionSecret(db);

    return {
      ...made,
      bases: Object.fromEntries(
        made.prototypes.flatMap((group) =>
          group.versions.map((manifest) => {
            const version = `v${manifest.version}`;
            const token = protoToken(secret, podId, group.slug, version, now());

            return [
              `${group.slug}/${version}`,
              `/proto/${token}/${podId}/${group.slug}/${version}/`,
            ];
          })
        )
      ),
    };
  };

  const serveProto = async (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    parts: {
      token: string | null;
      pod: string;
      slug: string;
      version: string;
      rest: string;
    }
  ): Promise<void> => {
    const [, ...inPod] = parts.rest.split('/');
    const file = decodeFile(
      await podFile(parts.pod, 'prototype', inPod.join('/'))
    );

    if (file === null) {
      response.writeHead(404).end();

      return;
    }

    const base = `/proto/${parts.token === null ? '' : `${parts.token}/`}${
      parts.pod
    }/${parts.slug}/${parts.version}/`;
    const headers = prototypeHeaders(parts.rest, request.headers.host, base);
    const bytes = parts.rest.endsWith('.dc.html')
      ? Buffer.from(withBridge(file.bytes.toString('utf8')))
      : file.bytes;

    response.writeHead(200, headers);
    response.end(bytes);
  };

  // ── the routes ─────────────────────────────────────────────────────────────
  const body = (routeContext: RouteContext) => readBody(routeContext.request);

  const podActionRoutes: Route[] = POD_ACTIONS.map((action) => ({
    method: 'POST' as const,
    path: `/api/${action}`,
    sample: `/api/${action}`,
    handle: async ({ request, response }) => {
      const input = await readBody(request);
      ok(response, await podAction(str(input, 'podId'), action, input));
    },
  }));

  /** A device signed out: its session gone, and its live streams with it. */
  const signOutDevice = (deviceId: string): void => {
    endDevice(db, deviceId);
    context.listeners.forEach((device, response) => {
      if (device === deviceId) {
        context.listeners.delete(response);
        response.end();
      }
    });
  };

  const timeUnreadable = (movedTo: string, error: string): void =>
    context.log(
      `The time log couldn't be read (${error}); kept as ${movedTo}, counting again from now.`
    );

  const routes: Route[] = [
    // ── live data ────────────────────────────────────────────────────────
    {
      method: 'GET',
      path: '/api/events',
      sample: '/api/events',
      handle: async ({ request, response, session }) => {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        response.write('data: hello\n\n');
        context.listeners.set(response, session.deviceId);
        request.on('close', () => context.listeners.delete(response));
      },
    },
    {
      method: 'GET',
      path: '/api/state',
      sample: '/api/state',
      handle: async ({ response }) =>
        json(
          response,
          200,
          buildAppState(db, {
            owner: context.owner(),
            time: timeSummary(timeFile, undefined, timeUnreadable),
            tts: context.tts(),
            busyRunnerFor,
            isConnected: (runnerId) => relay.isConnected(runnerId),
          })
        ),
    },
    {
      method: 'GET',
      path: /^\/api\/pod\/([^/]+)$/,
      sample: '/api/pod/p1',
      handle: async ({ response, params }) =>
        json(
          response,
          200,
          await podAction(params[0] ?? '', 'detail', {
            time: timeSummary(timeFile, undefined, timeUnreadable),
          })
        ),
    },
    {
      method: 'GET',
      path: '/api/versions',
      sample: '/api/versions',
      handle: async ({ response, url }) =>
        json(response, 200, {
          versions: await podAction(
            url.searchParams.get('podId') ?? '',
            'versions',
            {
              qid: url.searchParams.get('qid') ?? '',
            }
          ),
        }),
    },
    {
      method: 'GET',
      path: /^\/api\/made\/([^/]+)$/,
      sample: '/api/made/p1',
      handle: async ({ response, params }) => {
        const podId = params[0] ?? '';
        const made = await podAction(podId, 'made');

        if (made === null) {
          json(response, 404, { ok: false });

          return;
        }

        if (!isMade(made)) {
          throw unexpected('made');
        }

        json(response, 200, withBases(podId, made));
      },
    },
    {
      method: 'GET',
      path: /^\/api\/panes\/([^/]+)$/,
      sample: '/api/panes/p1',
      handle: async ({ response, params }) => {
        const panes = await podAction(params[0] ?? '', 'panes');

        if (!isPanes(panes)) {
          throw unexpected('panes');
        }

        json(response, 200, panes);
      },
    },
    {
      method: 'GET',
      path: /^\/api\/pod-file\/([^/]+)\/(.+)$/,
      sample: '/api/pod-file/p1/screenshots/3/1/a.png',
      handle: async ({ request, response, params }) => {
        const [folder = '', ...rest] = (params[1] ?? '').split('/');

        // Prototypes go through /proto/, sandboxed; this route is the signed-in
        // origin, so it serves pictures only and types them itself.
        if (!PICTURE_FOLDERS.includes(folder)) {
          response.writeHead(404).end();

          return;
        }

        const file = await podFile(params[0] ?? '', folder, rest.join('/'));
        sendFile(
          request,
          response,
          // Its own headers: a picture is redrawn in place, so never cached.
          typeof file === 'object' && file !== null && 'base64' in file
            ? { base64: file.base64, headers: { 'cache-control': 'no-cache' } }
            : file,
          rest.at(-1) === 'manifest.json' ? 'application/json' : 'image/png'
        );
      },
    },
    {
      method: 'GET',
      path: /^\/api\/pod\/([^/]+)\/visual\/(.+)$/,
      sample: '/api/pod/p1/visual/PAWNEE-5/1/expected-trail-closed.png',
      // The visual check's pictures, `<ticket>/<round>/<file>`: forwarded to
      // the runner that has the pod, which serves only PNGs and each round's
      // manifest.json inside the pod's `visual/` folder.
      handle: async ({ request, response, params }) => {
        const rest = params[1] ?? '';
        const file = await podFile(params[0] ?? '', 'visual', rest);
        sendFile(
          request,
          response,
          typeof file === 'object' && file !== null && 'base64' in file
            ? { base64: file.base64, headers: { 'cache-control': 'no-cache' } }
            : file,
          rest.split('/').at(-1) === 'manifest.json'
            ? 'application/json'
            : 'image/png'
        );
      },
    },
    {
      method: 'GET',
      path: /^\/api\/audio\/([a-z0-9-]+)\/([^/]+)$/,
      sample: '/api/audio/p1/0123456789abcdef01234567.mp3',
      handle: async ({ request, response, params }) =>
        sendFile(
          request,
          response,
          await podAction(params[0] ?? '', 'audio', { file: params[1] ?? '' }),
          'audio/mpeg'
        ),
    },
    {
      method: 'GET',
      path: '/api/tts/stream',
      sample: '/api/tts/stream',
      handle: async ({ request, response, url }) => {
        const result = await podAction(
          url.searchParams.get('podId') ?? '',
          'tts-stream',
          {
            msgId: url.searchParams.get('msgId') ?? '',
          }
        );

        if (decodeFile(result) === null) {
          response.writeHead(204).end();

          return;
        }

        sendFile(request, response, result, 'audio/mpeg');
      },
    },
    {
      method: 'GET',
      path: '/api/term',
      sample: '/api/term',
      handle: async ({ response, url }) =>
        json(
          response,
          200,
          await toPod(url.searchParams.get('podId') ?? '', {
            type: 'term-read',
            window: url.searchParams.get('window') ?? '',
          })
        ),
    },
    {
      method: 'POST',
      path: '/api/term/keys',
      sample: '/api/term/keys',
      handle: async (routeContext) => {
        const input = await body(routeContext);
        ok(
          routeContext.response,
          await toPod(str(input, 'podId'), {
            type: 'term-keys',
            window: str(input, 'window'),
            hex: Array.isArray(input.hex) ? input.hex : [],
          })
        );
      },
    },
    ...podActionRoutes,
    ...createTicketRoutes({
      db,
      relay,
      runnerForProject,
      podAction,
      now,
      log: context.log,
      ownerName: () => context.owner().name,
    }),
    ...createViewRoutes({
      db,
      relay,
      runnerForProject,
      // Whose views and favorites: the owner's, by the email they signed in with.
      owner: () => context.owner().email ?? context.owner().name,
      now,
      broadcast: context.broadcast,
      log: context.log,
    }),
    {
      method: 'POST',
      path: '/api/pods/new',
      sample: '/api/pods/new',
      handle: async (routeContext) =>
        ok(routeContext.response, await newPod(await body(routeContext))),
    },
    {
      method: 'POST',
      path: '/api/priority',
      sample: '/api/priority',
      handle: async (routeContext) => {
        const input = await body(routeContext);
        const order = Array.isArray(input.order)
          ? input.order.filter((id): id is string => typeof id === 'string')
          : [];
        const groups = new Map<string, string[]>();
        order.forEach((podId) => {
          const location = locatePod(db, podId);

          if (location !== null) {
            const key = JSON.stringify([location.runnerId, location.folder]);
            groups.set(key, [...(groups.get(key) ?? []), podId]);
          }
        });
        await Promise.all(
          [...groups.entries()].map(([key, ids]) => {
            const [runnerId, folder]: [string, string] = JSON.parse(key);

            return relay.request(runnerId, {
              type: 'pod-action',
              action: 'priority',
              folder,
              body: { order: ids },
            });
          })
        );
        ok(routeContext.response, 'ok');
      },
    },
    {
      method: 'POST',
      path: '/api/focus',
      sample: '/api/focus',
      handle: async (routeContext) => {
        const input = await body(routeContext);
        const podId = optStr(input, 'podId');

        // Only the audio queue cares, on the pod's own runner: a refusal is
        // logged, never an error for the app.
        if (podId !== undefined) {
          await podAction(podId, 'focus', input).catch((error: unknown) =>
            context.log(
              `Audio focus on ${podId} failed: ${
                error instanceof Error ? error.message : String(error)
              }`
            )
          );
        }

        ok(routeContext.response, 'ok');
      },
    },
    {
      method: 'POST',
      path: '/api/time',
      sample: '/api/time',
      handle: async (routeContext) => {
        const input = await body(routeContext);
        const entries: TimeEntry[] = Array.isArray(input.entries)
          ? input.entries.flatMap((entry): TimeEntry[] =>
              typeof entry === 'object' &&
              entry !== null &&
              'ms' in entry &&
              typeof entry.ms === 'number'
                ? [
                    {
                      ms: entry.ms,
                      podId:
                        'podId' in entry && typeof entry.podId === 'string'
                          ? entry.podId
                          : undefined,
                      qid:
                        'qid' in entry && typeof entry.qid === 'string'
                          ? entry.qid
                          : undefined,
                      version:
                        'version' in entry &&
                        typeof entry.version === 'number' &&
                        Number.isInteger(entry.version) &&
                        entry.version > 0
                          ? entry.version
                          : undefined,
                      card:
                        'card' in entry && typeof entry.card === 'string'
                          ? entry.card
                          : undefined,
                    },
                  ]
                : []
            )
          : [];
        fs.mkdirSync(context.home, { recursive: true });
        addTime(timeFile, entries, undefined, timeUnreadable);
        ok(routeContext.response, 'ok');
      },
    },
    {
      method: 'POST',
      path: '/api/ui-log',
      sample: '/api/ui-log',
      handle: async (routeContext) => {
        const input = await body(routeContext);
        const entries = Array.isArray(input.entries) ? input.entries : [];

        if (entries.length > 0) {
          fs.mkdirSync(context.home, { recursive: true });

          if (
            fs.existsSync(uiLog) &&
            fs.statSync(uiLog).size > 5 * 1024 * 1024
          ) {
            fs.renameSync(uiLog, `${uiLog}.1`);
          }

          fs.appendFileSync(
            uiLog,
            entries
              .map((entry: unknown) => `${JSON.stringify(entry)}\n`)
              .join('')
          );
        }

        ok(routeContext.response, entries.length);
      },
    },
    {
      method: 'POST',
      path: '/api/upload',
      sample: '/api/upload',
      handle: async ({ request, response }) =>
        ok(response, await saveUpload(uploads, request)),
    },
    {
      method: 'POST',
      path: '/api/upload-url',
      sample: '/api/upload-url',
      handle: async (routeContext) =>
        ok(
          routeContext.response,
          await saveUploadUrl(uploads, str(await body(routeContext), 'url'))
        ),
    },
    {
      method: 'GET',
      path: /^\/api\/uploads\/([^/]+)$/,
      sample: '/api/uploads/img_a_b.png',
      handle: async ({ response, params }) =>
        serveUpload(uploads, params[0] ?? '', response),
    },

    // ── you and your devices ─────────────────────────────────────────────
    {
      method: 'GET',
      path: '/api/session',
      sample: '/api/session',
      handle: async ({ response, session }) => {
        const owner = context.owner();
        json(response, 200, {
          owner: { name: owner.name, initials: owner.initials },
          deviceId: session.deviceId,
        });
      },
    },
    {
      method: 'POST',
      path: '/api/auth/signout',
      sample: '/api/auth/signout',
      handle: async ({ request, response, session }) => {
        signOutDevice(session.deviceId);
        json(
          response,
          200,
          { ok: true },
          { 'set-cookie': clearedCookie(isHttps(request)) }
        );
      },
    },
    {
      method: 'GET',
      path: '/api/devices',
      sample: '/api/devices',
      handle: async ({ response, session }) =>
        json(response, 200, {
          devices: listDevices(db).map((device) => ({
            ...device,
            current: device.id === session.deviceId,
          })),
        }),
    },
    {
      method: 'POST',
      path: '/api/devices/code',
      sample: '/api/devices/code',
      handle: async ({ response }) =>
        ok(response, createCode(db, 'device', now())),
    },
    {
      method: 'POST',
      path: '/api/devices/signout',
      sample: '/api/devices/signout',
      handle: async (routeContext) => {
        signOutDevice(str(await body(routeContext), 'deviceId'));
        context.broadcast();
        ok(routeContext.response, 'ok');
      },
    },

    // ── computers and projects ───────────────────────────────────────────
    {
      method: 'GET',
      path: '/api/computers',
      sample: '/api/computers',
      handle: async ({ response }) => {
        const projects = new Map(
          listProjects(db).map((project) => [project.id, project.name])
        );
        const identities = computerIdentities(db);
        json(response, 200, {
          // Two computers on one tracker user: either may build its tickets.
          shared: sharedTrackerUsers(identities),
          computers: listRunners(db).map((runner) => {
            const switchingTo = context.switching.get(runner.id);
            const midTurn = snapshotsOf(db, runner.id).some(
              ({ projectId, snapshot }) =>
                snapshot.activity.midTurn &&
                (runner.currentProjectId === null ||
                  projectId === runner.currentProjectId)
            );

            return {
              id: runner.id,
              name: runner.name,
              trackers:
                identities.find((one) => one.runnerId === runner.id)
                  ?.identities ?? [],
              project:
                runner.currentProjectId === null
                  ? null
                  : projects.get(runner.currentProjectId) ?? null,
              connected: relay.isConnected(runner.id),
              state: computerState(
                {
                  connected: relay.isConnected(runner.id),
                  lastSeenAt: runner.lastSeenAt,
                  switchingTo:
                    switchingTo === undefined
                      ? null
                      : projects.get(switchingTo) ?? null,
                  midTurn,
                },
                now()
              ),
            };
          }),
        });
      },
    },
    {
      method: 'POST',
      path: '/api/computers/code',
      sample: '/api/computers/code',
      handle: async ({ response }) => {
        const { code, expiresAt } = createCode(db, 'runner', now());
        ok(response, { code, expiresAt, command: `lambda join ${code}` });
      },
    },
    {
      // `lambda computer <name> <action>`: one fixed read from that
      // computer's runner (runner/diagnose.ts), never a command line.
      method: 'GET',
      path: '/api/computers/diagnose',
      sample: '/api/computers/diagnose',
      handle: async ({ response, url }) => {
        const query = url.searchParams.get('computer') ?? '';
        const runner = findComputer(listRunners(db), query);

        if (runner === null) {
          throw new HttpError(404, `No computer ${query}`);
        }

        json(
          response,
          200,
          await relay.request(runner.id, {
            type: 'diagnose',
            action: url.searchParams.get('action') ?? '',
            podId: url.searchParams.get('podId') ?? undefined,
            lines: url.searchParams.get('lines') ?? undefined,
          })
        );
      },
    },
    {
      method: 'GET',
      path: '/api/projects',
      sample: '/api/projects',
      handle: async ({ response }) => {
        const hostId = context.hostRunnerId();
        json(response, 200, {
          projects: listProjects(db).map((project) => ({
            id: project.id,
            name: project.name,
            ticketPrefix: project.ticketPrefix,
          })),
          lastProjectId: lastUsedProject(db)?.id ?? null,
          host:
            hostId === null
              ? null
              : {
                  name: runnerName(db, hostId),
                  online: relay.isConnected(hostId),
                },
        });
      },
    },
    {
      method: 'POST',
      path: '/api/projects/add',
      sample: '/api/projects/add',
      handle: async (routeContext) => {
        const input = await body(routeContext);
        const runnerId = hostRunner();
        const result = await relay.request(runnerId, {
          type: 'project-add',
          folder: str(input, 'folder'),
          known: holdings(db)
            .filter((holding) => holding.runnerId === runnerId)
            .map((holding) => holding.folder),
        });

        if (!isLinkedFolder(result)) {
          throw unexpected('project-add');
        }

        const projectId = linkProject(
          db,
          {
            runnerId,
            name: result.name,
            folder: result.folder,
            description: result.description ?? null,
            ticketPrefix: result.ticketPrefix ?? null,
          },
          now()
        );
        context.broadcast();
        ok(routeContext.response, { projectId });
      },
    },
    {
      method: 'POST',
      path: '/api/projects/new',
      sample: '/api/projects/new',
      handle: async (routeContext) => {
        const input = await body(routeContext);
        const runnerId = hostRunner();
        const result = await relay.request(runnerId, {
          type: 'project-new',
          name: str(input, 'name'),
        });

        if (!isLinkedFolder(result)) {
          throw unexpected('project-new');
        }

        const projectId = linkProject(
          db,
          { runnerId, name: result.name, folder: result.folder },
          now()
        );
        context.broadcast();
        const idea = optStr(input, 'idea');
        // The idea is the project's first planning pod — the planning
        // pipeline, not a freeform chat. It goes where any new pod goes (now,
        // or once the computer is free).
        const podId =
          idea === undefined
            ? null
            : await newPod({ text: idea, freeform: false, projectId });
        ok(routeContext.response, { projectId, podId });
      },
    },
    {
      method: 'GET',
      path: '/api/process',
      sample: '/api/process',
      handle: async ({ response, url }) => {
        const projectId = projectParam(url);
        const runnerId = runnerForProject(projectId);
        json(
          response,
          200,
          await relay.request(runnerId, {
            type: 'process-read',
            folder: folderOf(db, runnerId, projectId),
          })
        );
      },
    },
    {
      method: 'POST',
      path: '/api/process/switch',
      sample: '/api/process/switch',
      handle: async (routeContext) => {
        const input = await body(routeContext);
        const projectId = str(input, 'projectId');
        const runnerId = runnerForProject(projectId);
        ok(
          routeContext.response,
          await relay.request(runnerId, {
            type: 'process-switch',
            folder: folderOf(db, runnerId, projectId),
            process: str(input, 'process'),
            step: str(input, 'step'),
            on: input.on === true,
          })
        );
      },
    },
    {
      method: 'GET',
      path: /^\/api\/projects\/([^/]+)\/design-system$/,
      sample: '/api/projects/prj_1/design-system',
      handle: async ({ response, params }) => {
        const projectId = knownProject(params[0]);
        const runnerId = runnerForProject(projectId);
        const page = DesignSystemPageAnswer.safeParse(
          await relay.request(runnerId, {
            type: 'design-system-read',
            folder: folderOf(db, runnerId, projectId),
          })
        );

        if (!page.success) {
          throw unexpected('design-system-read');
        }

        json(response, 200, page.data);
      },
    },
    {
      method: 'POST',
      path: /^\/api\/projects\/([^/]+)\/design-system\/make$/,
      sample: '/api/projects/prj_1/design-system/make',
      handle: async ({ response, params }) => {
        const projectId = knownProject(params[0]);
        const runnerId = runnerForProject(projectId);
        const made = await relay.request(runnerId, {
          type: 'design-system-make',
          folder: folderOf(db, runnerId, projectId),
          by: context.owner().name,
        });

        if (isRecord(made) && typeof made.conflict === 'string') {
          throw new HttpError(409, made.conflict);
        }

        const ticket = MadeAnswer.safeParse(made);

        if (!ticket.success) {
          throw unexpected('design-system-make');
        }

        ok(response, {
          id: ticket.data.id,
          title: ticket.data.title,
          url: ticket.data.url ?? null,
          existing: ticket.data.existing === true,
        });
      },
    },
    {
      method: 'GET',
      path: '/api/analytics',
      sample: '/api/analytics',
      handle: async ({ response, url }) => {
        const projectId = projectParam(url);
        json(response, 200, {
          projectId,
          analytics: computeAnalytics(listEvents(db, projectId)),
        });
      },
    },
  ];

  const setupRoutes = createSetupRoutes({
    ...realSetupOptions(context.broadcast),
    you: {
      email: () => context.owner().email,
      isYou: (login) => isOwnersLogin(db, context.owner(), login),
      claim: (alias) => addAliasTo(db, alias),
    },
    ...context.setup,
  });

  return {
    routes: [...routes, ...setupRoutes],
    serveProto,
    idleSwitches,
    keepBuilding,
  };
};
