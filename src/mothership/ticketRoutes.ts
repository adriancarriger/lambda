import type * as http from 'http';
import { z } from 'zod';

import {
  shippedTicketDurations,
  typicalTicketMs,
} from '../app/shared/buildTimeline';
import type {
  NewTicket,
  TicketChanges,
  TimelineEvent,
} from '../app/shared/building';
import type { PodSnapshot } from '../app/shared/snapshot';
import type { StoredEvent } from '../events/schema';
import { listEvents, storeEvent } from '../events/store';
import { podKindOf } from '../pod-store/schemas';
import {
  BUILD_TIMEOUT_MS,
  RESUME_ALL_TIMEOUT_MS,
  STOP_TIMEOUT_MS,
  TALK_TIMEOUT_MS,
} from '../runner/budgets';
import { PRIORITIES, TICKET_STATES } from '../tickets/source';
import { randomId } from './crypto';
import type { Db } from './db';
import { json, readBody, str } from './http';
import { locatePod, projectSnapshots } from './pods';
import {
  folderOf,
  getProject,
  getRunner,
  holdings,
  listProjects,
  runnerName,
} from './registry';
import { HttpError, type Relay, offline } from './relay';
import type { Route } from './routes';

/**
 * The Tickets screen and building pods. The mothership never reads a ticket
 * source: every list, full ticket and summary comes from the runner holding
 * the project (`runner_projects`), so tracker keys never leave it.
 */

/**
 * The types a building pod's Workflow rail reads. Read project-wide, since
 * Typical ticket is the median of every shipped ticket, but only the pod's
 * own tickets' events go to the page: Typical is worked out here.
 */
const TIMELINE_TYPES = [
  'stage.start',
  'stage.end',
  'attempt.start',
  'attempt.end',
  'ship.start',
  'ship.end',
] as const;

/**
 * The runner's own budget for Start building, plus a minute: a project switch
 * (its stop, then `resume-all`) before `lambda pod build`.
 */
export const BUILDING_START_TIMEOUT_MS =
  STOP_TIMEOUT_MS + RESUME_ALL_TIMEOUT_MS + BUILD_TIMEOUT_MS + 60_000;

/** The runner's own budget for `ticket-talk`, plus ten seconds. */
export const TICKET_TALK_TIMEOUT_MS = TALK_TIMEOUT_MS + 10_000;

/**
 * Each project's `tickets-list`: shorter than the relay's minute, so one
 * hung computer doesn't hold the whole Tickets screen.
 */
export const TICKETS_LIST_TIMEOUT_MS = 15_000;

/** What the app shows for a project whose list failed in the mothership. */
const TICKETS_UNREADABLE = "Couldn't read this codebase's tickets.";

export interface TicketRoutesContext {
  db: Db;
  relay: Relay;
  /** A connected runner holding the project, else the 409 offline error. */
  runnerForProject: (projectId: string) => string;
  podAction: (
    podId: string,
    action: string,
    body?: Record<string, unknown>
  ) => Promise<unknown>;
  now: () => number;
  /** The mothership's log: what failed in the background, and why. */
  log: (line: string) => void;
  /** Who a change on the Tickets screen is from, for its Activity. */
  ownerName?: () => string;
}

/** Description saves this close together read as one edit in Activity. */
export const DESCRIPTION_SITTING_MS = 15 * 60_000;

const labelList = z.array(z.string().min(1).max(200)).max(50);

/** A Tickets screen change, as the app may send it: nothing else passes. */
const ChangesSchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().max(100_000).optional(),
    status: z.enum(TICKET_STATES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    assignee: z.string().trim().min(1).max(200).nullable().optional(),
    labels: labelList.optional(),
    removeLabels: labelList.optional(),
    parent: z.string().min(1).max(100).nullable().optional(),
    project: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict();

const NewTicketSchema = z
  .object({
    title: z.string().trim().min(1, 'A ticket needs a title.').max(500),
    description: z.string().max(100_000).optional(),
    status: z.enum(TICKET_STATES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    assignee: z.string().trim().min(1).max(200).nullable().optional(),
    labels: labelList.optional(),
    parent: z.string().min(1).max(100).optional(),
    project: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const parsed = <T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: unknown
): T => {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new HttpError(
      400,
      result.error.issues
        .map((issue) =>
          issue.path.length === 0
            ? issue.message
            : `${issue.path.join('.')}: ${issue.message}`
        )
        .join('; ')
    );
  }

  return result.data;
};

/** What a change reads as in the ticket's Activity: field → what it became. */
export const changeNotes = (
  changes: TicketChanges
): Array<{ name: string; note: string }> =>
  [
    changes.title === undefined ? null : { name: 'title', note: changes.title },
    changes.description === undefined
      ? null
      : { name: 'description', note: '' },
    changes.status === undefined
      ? null
      : { name: 'status', note: changes.status },
    changes.priority === undefined
      ? null
      : { name: 'priority', note: changes.priority },
    changes.assignee === undefined
      ? null
      : { name: 'assignee', note: changes.assignee ?? '' },
    changes.labels === undefined || changes.labels.length === 0
      ? null
      : { name: 'labels', note: `+${changes.labels.join(', +')}` },
    changes.removeLabels === undefined || changes.removeLabels.length === 0
      ? null
      : { name: 'labels', note: `-${changes.removeLabels.join(', -')}` },
    changes.parent === undefined
      ? null
      : { name: 'parent', note: changes.parent ?? '' },
  ].filter((note): note is { name: string; note: string } => note !== null);

/**
 * How far back Shipping together reads a project's groups, which are kept
 * for ever: it leaves out groups shipped before then (an open group is always
 * read whole).
 */
const RECENT_MS = 90 * 24 * 60 * 60_000;

export const toTimelineEvent = (event: StoredEvent): TimelineEvent => ({
  type: event.type,
  name: event.name,
  ticket: event.ticket,
  attempt: event.attempt,
  pod: event.pod,
  result: event.result,
  at: event.at,
  ...(event.skipped === true
    ? { skipped: true, skipReason: event.reason }
    : {}),
  ...(event.type.startsWith('ticket.')
    ? { note: event.note, source: event.source }
    : {}),
});

const ok = (response: http.ServerResponse, result: unknown): void =>
  json(response, 200, { ok: true, result });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The tickets a building pod's detail says it has taken. */
const takenTicketIds = (detail: Record<string, unknown>): Set<string> => {
  if (!isRecord(detail.building)) {
    throw new HttpError(404, 'Not a building pod.');
  }

  const { runs } = detail.building;

  if (!Array.isArray(runs)) {
    throw new Error('Unexpected answer from the computer to building-detail.');
  }

  return new Set(
    runs.flatMap((run) =>
      isRecord(run) && typeof run.id === 'string' ? [run.id] : []
    )
  );
};

/**
 * The pods a runner's `ticket-talk` picks from (building/talkAboutTicket.ts):
 * a live planning pod planning the ticket, else a live building pod that
 * isn't itself a one-shot conversation.
 */
const isPlanningTicket = (snapshot: PodSnapshot, ticketId: string): boolean => {
  const { pod } = snapshot.summary;

  return (
    podKindOf(pod) === 'planning' &&
    pod.status === 'active' &&
    (pod.epicId === ticketId ||
      (pod.tickets ?? []).includes(ticketId) ||
      snapshot.questions.some((question) =>
        (question.checkpoint?.planTickets ?? []).some(
          (planned) => planned.id === ticketId
        )
      ))
  );
};

const isBuildingPod = (snapshot: PodSnapshot): boolean => {
  const { pod } = snapshot.summary;

  return (
    podKindOf(pod) === 'building' &&
    pod.status !== 'done' &&
    pod.talk === undefined
  );
};

export const createTicketRoutes = (context: TicketRoutesContext): Route[] => {
  const { db, relay } = context;

  /**
   * The runner a ticket's page and talk go to. The runner decides between
   * the planning dev, the building pod's Product manager and a one-shot one
   * from its own pods, so with the project on two computers it must be the
   * one with the pod: the computer planning the ticket, else the one running
   * the building pod. With neither connected, the project's runner.
   */
  const ticketRunner = (projectId: string, ticketId: string): string => {
    const snapshots = projectSnapshots(db, projectId).filter(
      ({ runnerId }) =>
        relay.isConnected(runnerId) &&
        folderOf(db, runnerId, projectId) !== null
    );
    const pick =
      snapshots.find(({ snapshot }) => isPlanningTicket(snapshot, ticketId)) ??
      snapshots.find(({ snapshot }) => isBuildingPod(snapshot));

    return pick?.runnerId ?? context.runnerForProject(projectId);
  };

  /** The project's runner (or the ticket's) and its folder there. */
  const projectRunner = (
    projectId: string,
    ticketId?: string
  ): { runnerId: string; folder: string } => {
    if (getProject(db, projectId) === null) {
      throw new HttpError(404, 'No such codebase.');
    }

    const runnerId =
      ticketId === undefined
        ? context.runnerForProject(projectId)
        : ticketRunner(projectId, ticketId);
    const folder = folderOf(db, runnerId, projectId);

    if (folder === null) {
      throw new HttpError(409, 'No computer has this codebase yet.');
    }

    return { runnerId, folder };
  };

  /** The later of two times (epoch ms), either of which may be missing. */
  const latest = (a: unknown, b: unknown): number | null => {
    const times = [a, b].filter(
      (time): time is number =>
        typeof time === 'number' && Number.isFinite(time)
    );

    return times.length === 0 ? null : Math.max(...times);
  };

  /** When each of a project's tickets last had an event, by ticket. */
  const lastTouched = (projectId: string): Map<string, number> =>
    new Map(
      db
        .prepare<[string], { ticket: string; at: number }>(
          'SELECT ticket, MAX(at) AS at FROM events WHERE project_id = ? AND ticket IS NOT NULL GROUP BY ticket'
        )
        .all(projectId)
        .map((row) => [row.ticket, row.at])
    );

  /**
   * What the Workflow rail reads: never the project's metrics or groups.
   * Every one, however old: Typical ticket is every shipped ticket's median,
   * and Whole run every ticket the pod has taken.
   */
  const timelineEvents = (projectId: string): StoredEvent[] =>
    listEvents(db, projectId, { types: TIMELINE_TYPES });

  /**
   * Typical ticket, per project, with the ship stage ends it was worked out
   * from: the page asks on every push and poll, but it only moves when a
   * ticket ships, so the whole history is read again only then.
   */
  const typical = new Map<
    string,
    { shipped: string; typicalMs: number | null }
  >();
  const typicalMs = (projectId: string): number | null => {
    const shipped = JSON.stringify(
      db
        .prepare<[string], { n: number; latest: number | null }>(
          "SELECT COUNT(*) AS n, MAX(received_at) AS latest FROM events WHERE project_id = ? AND type = 'stage.end' AND name = 'ship'"
        )
        .get(projectId)
    );
    const cached = typical.get(projectId);

    if (cached?.shipped === shipped) {
      return cached.typicalMs;
    }

    const worked = typicalTicketMs(
      shippedTicketDurations(timelineEvents(projectId).map(toTimelineEvent))
    );
    typical.set(projectId, { shipped, typicalMs: worked });

    return worked;
  };

  /** One `ticket.*` event, from a person on the Tickets screen. */
  const recordEdit = (
    projectId: string,
    ticketId: string,
    type: 'ticket.edit' | 'ticket.create',
    name: string,
    note: string
  ): void => {
    const at = context.now();

    // A description saves at every pause in typing: one "edited the
    // description" for a sitting, not one per pause.
    const sitting =
      name === 'description' &&
      listEvents(db, projectId, { ticket: ticketId, types: ['ticket.edit'] })
        .filter((event) => event.name === 'description')
        .some((event) => at - event.at < DESCRIPTION_SITTING_MS);

    if (sitting) {
      return;
    }

    storeEvent(db, {
      id: randomId('edit'),
      projectId,
      receivedAt: at,
      event: {
        type,
        name,
        note,
        ticket: ticketId,
        source: context.ownerName?.() ?? 'Owner',
        at: new Date(at).toISOString(),
      },
    });
  };

  return [
    {
      method: 'POST',
      path: '/api/tickets/update',
      sample: '/api/tickets/update',
      handle: async ({ request, response }) => {
        const input = await readBody(request);
        const projectId = str(input, 'projectId');
        const ticketId = str(input, 'ticketId');
        const changes = parsed(ChangesSchema, input.changes);
        const { runnerId, folder } = projectRunner(projectId, ticketId);
        const after = await relay.request(runnerId, {
          type: 'ticket-update',
          folder,
          projectId,
          ticketId,
          changes,
        });

        changeNotes(changes).forEach(({ name, note }) =>
          recordEdit(projectId, ticketId, 'ticket.edit', name, note)
        );
        ok(response, after);
      },
    },
    {
      method: 'POST',
      path: '/api/tickets/new',
      sample: '/api/tickets/new',
      handle: async ({ request, response }) => {
        const input = await readBody(request);
        const projectId = str(input, 'projectId');
        const ticket: NewTicket = parsed(NewTicketSchema, input.ticket);
        const { runnerId, folder } = projectRunner(projectId);
        const made = await relay.request(runnerId, {
          type: 'ticket-create',
          folder,
          projectId,
          ticket,
        });

        if (!isRecord(made) || typeof made.id !== 'string') {
          throw new Error(
            'Unexpected answer from the computer to ticket-create.'
          );
        }

        recordEdit(
          projectId,
          made.id,
          'ticket.create',
          'created',
          ticket.title
        );
        ok(response, made);
      },
    },
    {
      method: 'POST',
      path: '/api/lambdas/plan-more',
      sample: '/api/lambdas/plan-more',
      handle: async ({ request, response }) => {
        const input = await readBody(request);
        const projectId = str(input, 'projectId');
        const podId = str(input, 'podId');
        const text = str(input, 'text');
        const ticketIds = Array.isArray(input.ticketIds)
          ? input.ticketIds.filter(
              (id): id is string => typeof id === 'string' && id !== ''
            )
          : [];
        const { runnerId, folder } = projectRunner(projectId);
        const done = await relay.request(
          runnerId,
          { type: 'plan-more', folder, projectId, podId, text, ticketIds },
          TICKET_TALK_TIMEOUT_MS
        );

        ticketIds.forEach((ticketId) =>
          recordEdit(projectId, ticketId, 'ticket.edit', 'status', 'planning')
        );
        ok(response, done);
      },
    },
    {
      method: 'POST',
      path: '/api/tickets/move',
      sample: '/api/tickets/move',
      handle: async ({ request, response }) => {
        const input = await readBody(request);
        const projectId = str(input, 'projectId');
        const ticketId = str(input, 'ticketId');
        const after =
          typeof input.after === 'string' && input.after !== ''
            ? input.after
            : null;
        const { runnerId, folder } = projectRunner(projectId);

        await relay.request(runnerId, {
          type: 'ticket-move',
          folder,
          projectId,
          ticketId,
          after,
        });
        ok(response, null);
      },
    },
    {
      method: 'GET',
      path: /^\/api\/building\/([^/]+)$/,
      sample: '/api/building/p1',
      handle: async ({ response, params }) => {
        const podId = params[0] ?? '';
        const detail = await context.podAction(podId, 'building-detail');
        const location = locatePod(db, podId);

        if (!isRecord(detail) || location === null) {
          throw new Error(
            'Unexpected answer from the computer to building-detail.'
          );
        }

        // Only the pod's own tickets' events, each an index lookup.
        const events = [...takenTicketIds(detail)]
          .flatMap((ticket) =>
            listEvents(db, location.projectId, {
              types: TIMELINE_TYPES,
              ticket,
            })
          )
          .sort((a, b) => a.at - b.at || a.receivedAt - b.receivedAt)
          .map(toTimelineEvent);

        json(response, 200, {
          ...detail,
          events,
          typicalMs: typicalMs(location.projectId),
        });
      },
    },
    {
      method: 'POST',
      path: '/api/building/start',
      sample: '/api/building/start',
      handle: async ({ request, response }) => {
        const input = await readBody(request);
        const projectId = str(input, 'projectId');
        const runnerId = str(input, 'runnerId');
        const folder = folderOf(db, runnerId, projectId);

        if (folder === null) {
          throw new HttpError(
            409,
            `${runnerName(db, runnerId)} doesn't have this codebase.`
          );
        }

        if (!relay.isConnected(runnerId)) {
          throw offline(runnerName(db, runnerId));
        }

        const podId = await relay.request(
          runnerId,
          { type: 'building-start', folder, projectId },
          BUILDING_START_TIMEOUT_MS
        );

        if (typeof podId !== 'string' || podId === '') {
          throw new Error(`${runnerName(db, runnerId)} started no pod.`);
        }

        ok(response, { podId });
      },
    },
    {
      method: 'GET',
      path: '/api/tracker-projects',
      sample: '/api/tracker-projects',
      handle: async ({ response }) => {
        const codebases = await Promise.all(
          listProjects(db).map(async (project) => {
            try {
              const { runnerId, folder } = projectRunner(project.id);
              const answer = await relay.request(
                runnerId,
                { type: 'tracker-projects', folder },
                TICKETS_LIST_TIMEOUT_MS
              );

              if (!isRecord(answer) || !Array.isArray(answer.projects)) {
                throw new Error(
                  'Unexpected answer from the computer to tracker-projects.'
                );
              }

              return {
                projectId: project.id,
                name: project.name,
                projects: answer.projects,
              };
            } catch (error) {
              if (!(error instanceof HttpError)) {
                context.log(
                  `Listing ${project.name}'s projects failed: ${errorText(
                    error
                  )}`
                );
              }

              return {
                projectId: project.id,
                name: project.name,
                offline:
                  error instanceof HttpError
                    ? error.message
                    : TICKETS_UNREADABLE,
              };
            }
          })
        );

        ok(response, { codebases });
      },
    },
    {
      method: 'GET',
      path: '/api/tickets',
      sample: '/api/tickets',
      handle: async ({ response }) => {
        const allProjects = listProjects(db);
        const projects = await Promise.all(
          allProjects.map(async (project) => {
            try {
              const { runnerId, folder } = projectRunner(project.id);
              const answer = await relay.request(
                runnerId,
                { type: 'tickets-list', folder, projectId: project.id },
                TICKETS_LIST_TIMEOUT_MS
              );

              if (!isRecord(answer) || !Array.isArray(answer.tickets)) {
                throw new Error(
                  'Unexpected answer from the computer to tickets-list.'
                );
              }

              const touched = lastTouched(project.id);

              return {
                projectId: project.id,
                name: project.name,
                tickets: answer.tickets.map((ticket: unknown) =>
                  isRecord(ticket) && typeof ticket.id === 'string'
                    ? {
                        ...ticket,
                        updatedAt: latest(
                          touched.get(ticket.id),
                          ticket.updatedAt
                        ),
                      }
                    : ticket
                ),
              };
            } catch (error) {
              // The project's computer is the only one that can read it.
              // Only an HttpError's words are for the app; anything else is
              // the mothership's own failure, kept in the log.
              if (!(error instanceof HttpError)) {
                context.log(
                  `Listing ${project.name}'s tickets failed: ${errorText(
                    error
                  )}`
                );
              }

              return {
                projectId: project.id,
                name: project.name,
                offline:
                  error instanceof HttpError
                    ? error.message
                    : TICKETS_UNREADABLE,
              };
            }
          })
        );
        const groupEvents = allProjects.flatMap((project) =>
          listEvents(db, project.id, {
            typePrefix: 'group.',
            groupsShippedSince: context.now() - RECENT_MS,
          }).map((event) => ({
            ...toTimelineEvent(event),
            groupId: event.groupId,
            reason: event.reason,
            held: event.held,
            projectId: project.id,
          }))
        );

        json(response, 200, {
          projects,
          groupEvents,
          holdings: holdings(db).map((holding) => ({
            runnerId: holding.runnerId,
            computer: getRunner(db, holding.runnerId)?.name ?? 'A computer',
            projectId: holding.projectId,
            connected: relay.isConnected(holding.runnerId),
          })),
        });
      },
    },
    {
      method: 'GET',
      path: /^\/api\/tickets\/([^/]+)\/([^/]+)$/,
      sample: '/api/tickets/prj_1/3',
      handle: async ({ response, params, url }) => {
        const projectId = params[0] ?? '';
        const ticketId = params[1] ?? '';
        const { runnerId, folder } = projectRunner(projectId, ticketId);
        const page = await relay.request(runnerId, {
          type: 'ticket-get',
          folder,
          projectId,
          ticketId,
          // Its first load, not a refresh: a failed summary is tried again.
          opened: url.searchParams.get('opened') === '1',
        });

        if (!isRecord(page)) {
          throw new Error('Unexpected answer from the computer to ticket-get.');
        }

        json(response, 200, {
          ...page,
          events: listEvents(db, projectId, { ticket: ticketId }).map(
            toTimelineEvent
          ),
        });
      },
    },
    {
      method: 'POST',
      path: '/api/tickets/talk',
      sample: '/api/tickets/talk',
      handle: async ({ request, response }) => {
        const input = await readBody(request);
        const ticketId = str(input, 'ticketId');
        const { runnerId, folder } = projectRunner(
          str(input, 'projectId'),
          ticketId
        );

        ok(
          response,
          await relay.request(
            runnerId,
            {
              type: 'ticket-talk',
              folder,
              ticketId,
              text: str(input, 'text'),
            },
            TICKET_TALK_TIMEOUT_MS
          )
        );
      },
    },
  ];
};
