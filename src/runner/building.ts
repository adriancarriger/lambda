import {
  type ProcessRow,
  agentActivity,
  listProcesses,
} from '../building/activity';
import {
  type BuildingMothership,
  POLL_MS,
  createBuildingDriver,
  pendingReleases,
  pendingShips,
  settleRelease,
  settleShip,
} from '../building/driver';
import { markShippedGroupsDone } from '../building/groups';
import type { OwnerIdentity } from '../building/owner';
import type { ClaimRow } from '../building/queue';
import { loadMachineConfig } from '../config/machineConfig';
import { loadProjectConfig } from '../config/projectConfig';
import { randomId } from '../mothership/crypto';
import { BUILDING_ROLES, type Pod, podKindOf } from '../pod-store';
import { agentWindow, sessionName } from '../pod/context';
import { openTicketSource } from '../tickets/context';
import { type TicketSource, isUnknownTicket } from '../tickets/source';
import { BUILDING_CALL_TIMEOUT_MS } from './budgets';
import type { RunnerClient } from './client';
import type { LambdaCli, PodHost, Tmux } from './podHost';

/**
 * The runner's side of building pods. Every few seconds, for each project it
 * holds: the claims an ended pod left behind are released, and each of this
 * computer's building pods gets its driver's tick (claims, pick-up, the
 * stall watch). Once a minute each one's Product manager and ask forks are
 * put to sleep when idle. Agents are only ever reached through `lambda pod`,
 * which knows each pod's tmux session.
 */

const WATCH_MS = 60_000;
/** A release the tracker refused waits this long before it's tried again. */
const RELEASE_RETRY_MS = POLL_MS;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const claimRows = (value: unknown): ClaimRow[] =>
  isRecord(value) && Array.isArray(value.claims)
    ? value.claims.flatMap((row: unknown): ClaimRow[] =>
        isRecord(row) &&
        typeof row.ticketId === 'string' &&
        typeof row.runnerId === 'string'
          ? [
              {
                ticketId: row.ticketId,
                runnerId: row.runnerId,
                shippedAt:
                  typeof row.shippedAt === 'number' ? row.shippedAt : null,
              },
            ]
          : []
      )
    : [];

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const outcomeOf = (value: unknown) => {
  const outcome = isRecord(value) ? value.outcome : undefined;

  if (outcome === 'claimed' || outcome === 'taken' || outcome === 'not-owner') {
    return outcome;
  }

  throw new Error('Lambda answered the claim with something unexpected.');
};

export interface BuildingRunnerDeps {
  /**
   * Read each tick: a reset mothership has `lambda start` register this
   * computer again under a new id while the runner keeps running.
   */
  runnerId: string | (() => string);
  /** Only its writes: claims asked for, releases and ships queued. */
  client: () => Pick<RunnerClient, 'enqueue' | 'request'>;
  lambda: LambdaCli;
  tmux: Tmux;
  /** The mothership's `owner` message, kept in memory. */
  owner: () => OwnerIdentity | null;
  /** This computer's name: tickets assigned to another one are skipped. */
  computer?: string;
  log: (line: string) => void;
  now?: () => number;
  /** For tests: a project's tickets (by default, its own ticket source). */
  source?: (folder: string) => TicketSource;
  /**
   * Is this the project the computer is on? A host is also made for a page
   * or a screenshot of another project; its pods take no tickets from here.
   * By default, every one.
   */
  isCurrent?: (folder: string) => boolean;
  /** For tests: every process, for who has a command running. */
  processes?: () => ProcessRow[];
}

/**
 * A role's window in a building pod, as tmux names it: the Engineering
 * manager's is `manager` (`agentWindow`), so reading `engineering-manager`
 * read nothing and the stall watch never saw the manager.
 */
export const agentPane = (
  session: string,
  pod: Pick<Pod, 'kind'>,
  role: string
): string => `=${session}:=${agentWindow(pod, role)}`;

/** What it needs of a project's pod host: the pods. */
type HostPods = Pick<PodHost, 'store'>;

export const createBuildingRunner = (deps: BuildingRunnerDeps) => {
  const now = deps.now ?? Date.now;
  /** Each pod's driver, with the runner id it was made for. */
  const drivers = new Map<
    string,
    { runnerId: string; driver: ReturnType<typeof createBuildingDriver> }
  >();
  const watched = new Map<string, number>();
  const sources = new Map<string, TicketSource>();
  /** When each refused release was last tried, by folder and ticket. */
  const releaseTriedAt = new Map<string, number>();
  const currentRunnerId = (): string =>
    typeof deps.runnerId === 'string' ? deps.runnerId : deps.runnerId();

  const sourceFor = (folder: string): TicketSource => {
    if (deps.source !== undefined) {
      return deps.source(folder);
    }

    const known = sources.get(folder);

    if (known !== undefined) {
      return known;
    }

    const project = loadProjectConfig(folder);

    if (project === null) {
      throw new Error(`There's no lambda.json at ${folder}.`);
    }

    const made = openTicketSource(project, loadMachineConfig());
    sources.set(folder, made);

    return made;
  };

  /**
   * `projectId` rides on the queued release and ship, so they still find
   * their claim after the folder is re-linked from another checkout.
   */
  const mothershipFor = (
    folder: string,
    projectId?: string
  ): BuildingMothership => ({
    claims: async () =>
      claimRows(
        await deps
          .client()
          .request({ type: 'ticket-claims', id: randomId('cl'), folder })
      ),
    claim: async (ticketId, reporter) =>
      outcomeOf(
        await deps.client().request({
          type: 'ticket-claim',
          id: randomId('cl'),
          folder,
          ticketId,
          reporter,
        })
      ),
    release: (ticketId) =>
      deps.client().enqueue({
        type: 'ticket-release',
        id: randomId('rl'),
        folder,
        ...(projectId === undefined ? {} : { projectId }),
        ticketId,
      }),
    shipped: (ticketId) =>
      deps.client().enqueue({
        type: 'ticket-shipped',
        id: randomId('sh'),
        folder,
        ...(projectId === undefined ? {} : { projectId }),
        ticketId,
      }),
  });

  const lambdaIn =
    (folder: string) =>
    (args: string[]): Promise<string> =>
      deps.lambda(args, { cwd: folder, timeoutMs: BUILDING_CALL_TIMEOUT_MS });

  const driverFor = (
    folder: string,
    host: HostPods,
    pod: Pod,
    runnerId: string
  ) => {
    const key = `${folder}\u0000${pod.id}`;
    const known = drivers.get(key);

    if (known !== undefined && known.runnerId === runnerId) {
      return known.driver;
    }

    const lambda = lambdaIn(folder);
    const session = sessionName(pod.id, host.store);
    const made = createBuildingDriver({
      store: host.store,
      podId: pod.id,
      projectRoot: folder,
      runnerId,
      computer: deps.computer,
      source: () => sourceFor(folder),
      owner: deps.owner,
      mothership: mothershipFor(folder, pod.projectId),
      send: async (target, text) => {
        await lambda(['pod', 'send', pod.id, target, '--', text]);
      },
      interrupt: async (agent) => {
        await lambda(['pod', 'interrupt', pod.id, agent]);
      },
      block: async (ticketId, parts, how) => {
        await lambda([
          'pod',
          'blocked',
          ticketId,
          '--pod',
          pod.id,
          '--what',
          parts.what,
          '--problem',
          parts.problem,
          '--options',
          parts.options,
          '--recommendation',
          parts.recommendation,
          ...(how?.leftLambda === true ? ['--left-lambda'] : []),
        ]);
      },
      panes: () =>
        BUILDING_ROLES.map((role) =>
          deps.tmux(['capture-pane', '-p', '-t', agentPane(session, pod, role)])
        ).join('\n'),
      activity: () =>
        agentActivity({
          turn: (role) => host.store.readTurn(pod.id, role),
          panePid: (role) => {
            const pid = Number(
              deps
                .tmux([
                  'display-message',
                  '-p',
                  '-t',
                  agentPane(session, pod, role),
                  '#{pane_pid}',
                ])
                .trim()
            );

            return Number.isInteger(pid) && pid > 0 ? pid : null;
          },
          processes: deps.processes ?? listProcesses,
        }),
      now,
      log: deps.log,
    });
    drivers.set(key, { runnerId, driver: made });

    return made;
  };

  /**
   * Claims an ended pod (done, deleted) left: the ticket Ready, then
   * released. Each one on its own: one the tracker refuses stays on the list
   * and is tried again after RELEASE_RETRY_MS, and the others still go. A
   * ticket the tracker no longer has is final: its claim is released and
   * the release dropped. One another runner has claimed since (this release
   * already went, then the runner stopped before settling it) stays
   * `building`: it's that runner's now.
   */
  const releaseLeftovers = async (folder: string, host: HostPods) => {
    await pendingReleases(host.store.root).reduce(async (done, left) => {
      await done;
      const { ticketId } = left;
      const key = `${folder}\u0000${ticketId}`;

      if (
        now() - (releaseTriedAt.get(key) ?? Number.NEGATIVE_INFINITY) <
        RELEASE_RETRY_MS
      ) {
        return;
      }

      try {
        const mothership = mothershipFor(folder, left.projectId);
        const ticket = await sourceFor(folder).get(ticketId);
        const theirs = async (): Promise<boolean> => {
          const runnerId = currentRunnerId();

          return (await mothership.claims()).some(
            (claim) =>
              claim.ticketId === ticketId && claim.runnerId !== runnerId
          );
        };

        if (ticket.status === 'building' && !(await theirs())) {
          await sourceFor(folder).update(ticketId, { status: 'ready' });
        }

        mothership.release(ticketId);
        settleRelease(host.store.root, ticketId);
        releaseTriedAt.delete(key);
      } catch (error) {
        if (isUnknownTicket(error, ticketId)) {
          mothershipFor(folder, left.projectId).release(ticketId);
          settleRelease(host.store.root, ticketId);
          releaseTriedAt.delete(key);
          deps.log(
            `${ticketId} is no longer in ${folder}'s tracker: released its claim, nothing to set back to Ready.`
          );

          return;
        }

        releaseTriedAt.set(key, now());
        deps.log(
          `Couldn't release ${ticketId} in ${folder} (trying again): ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }, Promise.resolve());
  };

  /** Ships an ended pod hadn't reported: sent as ships, the claim kept. */
  const reportLeftoverShips = (folder: string, host: HostPods): void =>
    pendingShips(host.store.root).forEach((left) => {
      mothershipFor(folder, left.projectId).shipped(left.ticketId);
      settleShip(host.store.root, left.ticketId);
    });

  const watch = async (folder: string, pod: Pod): Promise<void> => {
    const key = `${folder}\u0000${pod.id}`;

    if (now() - (watched.get(key) ?? Number.NEGATIVE_INFINITY) < WATCH_MS) {
      return;
    }

    watched.set(key, now());
    await lambdaIn(folder)(['pod', 'watch-building', pod.id]);
  };

  const tickFolder = async (folder: string, host: HostPods): Promise<void> => {
    await releaseLeftovers(folder, host);
    reportLeftoverShips(folder, host);
    // Grouped tickets, shipped by a pod or by hand, done once the group ships.
    await markShippedGroupsDone(folder, sourceFor(folder), { log: deps.log });
    // A pod.json that can't be read never stops the rest.
    const pods = host.store.listPodIds().flatMap((podId): Pod[] => {
      try {
        const pod = host.store.readPod(podId);

        return pod !== null &&
          podKindOf(pod) === 'building' &&
          pod.status !== 'done'
          ? [pod]
          : [];
      } catch (error) {
        deps.log(
          `Couldn't read pod ${podId} in ${folder}: ${messageOf(error)}`
        );

        return [];
      }
    });
    // An ended pod's driver and watch time go with it.
    const live = new Set(pods.map((pod) => `${folder}\u0000${pod.id}`));
    [drivers, watched].forEach((byKey) =>
      [...byKey.keys()]
        .filter((key) => key.startsWith(`${folder}\u0000`) && !live.has(key))
        .forEach((key) => byKey.delete(key))
    );

    // Another project's pods take no tickets from here, but still sleep.
    const current = (deps.isCurrent ?? (() => true))(folder);
    const runnerId = currentRunnerId();

    await pods.reduce(async (done, pod) => {
      await done;

      // One pod's failure never skips the others.
      try {
        // A one-shot Product manager takes no tickets: it only sleeps.
        if (current && pod.talk === undefined && pod.runnerId === runnerId) {
          await driverFor(folder, host, pod, runnerId).tick();
        }

        await watch(folder, pod);
      } catch (error) {
        deps.log(`Building pod ${pod.id} in ${folder}: ${messageOf(error)}`);
      }
    }, Promise.resolve());
  };

  return {
    /** How many pods it keeps a driver and a watch time for. */
    tracked: () => ({ drivers: drivers.size, watched: watched.size }),
    tick: async (hosts: Map<string, HostPods>): Promise<void> => {
      await [...hosts.entries()].reduce(async (done, [folder, host]) => {
        await done;
        await tickFolder(folder, host).catch((error: unknown) =>
          deps.log(
            `Building pods in ${folder}: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
      }, Promise.resolve());
    },
  };
};
