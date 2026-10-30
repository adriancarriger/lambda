import { execFileSync } from 'child_process';
import * as path from 'path';

import {
  type PlannedSummary,
  type SummaryRun,
  claudeSummaryRun,
  createTicketSummaries,
} from '../app/server/ticketSummary';
import {
  BUILD_ONLY_STATES,
  type NewTicket,
  type ShippedCommit,
  type TicketChanges,
  type TicketListItem,
  type TicketPage,
  type TicketTalk,
} from '../app/shared/building';
import { podName } from '../app/shared/podName';
import { writeProductManagerSettings } from '../building/productManager';
import { loadMachineConfig } from '../config/machineConfig';
import { loadProjectConfig, resolvePodsRoot } from '../config/projectConfig';
import { type PodStore, type Question, createPodStore } from '../pod-store';
import { lambdaPackageDir } from '../process/workflow-file';
import type { Message } from '../protocol';
import { openTicketSource } from '../tickets/context';
import {
  type Ticket,
  type TicketSource,
  type TrackerFavorite,
  type TrackerProject,
  type TrackerView,
  isUnknownTicket,
} from '../tickets/source';
import { readVerdict } from '../verdict/store';
import { BUILD_TIMEOUT_MS, TALK_TIMEOUT_MS } from './budgets';
import { CREATED_POD, type LambdaCli } from './podHost';

/**
 * The runner's answers for the Tickets screen and building pods: only the
 * runner holding a project reads its ticket source, so Linear and Jira keys
 * never leave it.
 */

export interface TicketRequestDeps {
  lambda: LambdaCli;
  /** The runner's log: why a ticket's summary couldn't be written. */
  log: (line: string) => void;
  /** For tests: a project's ticket source. */
  openSource?: (folder: string) => TicketSource;
  /** For tests: the one-shot summary run. */
  summaryRun?: (folder: string, podsRoot: string) => SummaryRun;
}

const projectOf = (folder: string) => {
  const project = loadProjectConfig(folder);

  if (project === null) {
    throw new Error(`There's no lambda.json at ${folder}.`);
  }

  return project;
};

/**
 * The tracker's label names, by Lambda's key (lambda.json's tickets.labels):
 * the Tickets screen shows "Needs review", not `needsReview`. A change sent
 * back with a name still finds its label.
 */
const labelNamesOf = (folder: string): Record<string, string> => {
  try {
    return loadProjectConfig(folder)?.config.tickets.labels ?? {};
  } catch {
    return {};
  }
};

const named = <T extends { labels: string[] }>(
  item: T,
  names: Record<string, string>
): T => ({
  ...item,
  labels: item.labels.map((label) => names[label] ?? label),
});

const realSource = (folder: string): TicketSource =>
  openTicketSource(projectOf(folder), loadMachineConfig());

/**
 * The Product manager's instructions and read-only settings, for the
 * summary run (its settings are written by `lambda pod build`).
 */
export const productManagerFiles = (podsRoot: string) => ({
  instructionsFile: path.join(
    lambdaPackageDir(),
    'instructions',
    'building',
    'product-manager.md'
  ),
  // Written once per project for the runner's lifetime (summaries are
  // cached by folder): a rule Lambda adds reaches them after a restart.
  settingsFile: writeProductManagerSettings(podsRoot),
});

const realSummaryRun = (folder: string, podsRoot: string): SummaryRun =>
  claudeSummaryRun({ cwd: folder, ...productManagerFiles(podsRoot) });

interface PlannedTicket extends PlannedSummary {
  title: string;
  podTitle: string;
}

/**
 * Every ticket a planning pod's checkpoints name, by id. The latest
 * checkpoint wins across every pod, so a ticket replanned in another pod
 * reads as that pod's.
 */
const plannedTickets = (
  store: PodStore,
  log: (line: string) => void
): Map<string, PlannedTicket> => {
  const byId = new Map<string, PlannedTicket>();
  store
    .listPodIds()
    // A pod that can't be read never stops the rest.
    .flatMap((podId) => {
      try {
        const pod = store.requirePod(podId);

        return store
          .listQuestions(pod.id)
          .filter(
            (
              question
            ): question is Question & {
              checkpoint: NonNullable<Question['checkpoint']>;
            } => question.checkpoint !== undefined
          )
          .map((question) => ({ pod, question }));
      } catch (error) {
        log(
          `Couldn't read pod ${podId} in ${store.root}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );

        return [];
      }
    })
    .sort((a, b) => a.question.createdAt.localeCompare(b.question.createdAt))
    .forEach(({ pod, question }) =>
      (question.checkpoint.planTickets ?? []).forEach((planned) => {
        byId.set(planned.id, {
          title: planned.title,
          name: planned.name ?? planned.title,
          today: planned.today ?? planned.summary ?? '',
          after: planned.after ?? '',
          podId: pod.id,
          podTitle: podName(pod),
        });
      })
    );

  return byId;
};

/**
 * A ticket's conversation from every pod it was talked about in: each
 * "About ticket <id>…" message, and the answers after it up to the next
 * thing the owner said there. A pod that can't be read is left out.
 */
export const ticketTalk = (
  store: PodStore,
  ticket: { id: string; title: string }
): TicketTalk[] => {
  // What talk-ticket writes: with the title to a building pod, else without.
  const prefixes = [
    `About ticket ${ticket.id} ${ticket.title}: `,
    `About ticket ${ticket.id}: `,
  ];
  const asked = (text: string): string | null => {
    const prefix = prefixes.find((one) => text.startsWith(one));

    return prefix === undefined ? null : text.slice(prefix.length);
  };

  return store
    .listPodIds()
    .flatMap((podId) => {
      try {
        return store.readThread(podId).map((message) => ({ podId, message }));
      } catch {
        return [];
      }
    })
    .reduce<{ talk: TicketTalk[]; open: Set<string> }>(
      ({ talk, open }, { podId, message }) => {
        if (message.from === 'human') {
          const question = asked(message.text);

          if (question === null) {
            open.delete(podId);

            return { talk, open };
          }

          open.add(podId);

          return {
            talk: [
              ...talk,
              { at: message.createdAt, from: 'you', text: question, podId },
            ],
            open,
          };
        }

        const answer =
          (message.from === 'product-manager' || message.from === 'dev') &&
          open.has(podId) &&
          message.progress !== true;

        return {
          talk: answer
            ? [
                ...talk,
                {
                  at: message.createdAt,
                  from: message.from === 'dev' ? 'dev' : 'product-manager',
                  text: message.text,
                  podId,
                },
              ]
            : talk,
          open,
        };
      },
      { talk: [], open: new Set() }
    )
    .talk.sort((a, b) => a.at.localeCompare(b.at));
};

const listItem = (
  ticket: Ticket,
  projectId: string,
  source: string,
  commits: ReadonlyMap<string, string> = new Map()
): TicketListItem => ({
  id: ticket.id,
  title: ticket.title,
  status: ticket.status,
  parent: ticket.parent,
  labels: ticket.labels,
  url: ticket.url,
  projectId,
  source,
  priority: ticket.priority,
  assignee: ticket.assignee,
  blockReason: ticket.blockReason,
  commit: ticket.status === 'done' ? commits.get(ticket.id) ?? null : null,
  updatedAt:
    (ticket.updatedAt ?? null) === null
      ? null
      : Date.parse(ticket.updatedAt ?? ''),
  trackerStatus: ticket.trackerStatus ?? null,
  project: ticket.project ?? null,
});

/**
 * The files a commit changed, with lines added and removed (a binary file
 * counts 0 and 0). Null when git can't read it.
 */
export const commitFiles = (
  root: string,
  hash: string
): ShippedCommit | null => {
  if (!/^[0-9a-f]{4,40}$/.test(hash)) {
    return null;
  }

  try {
    const out = execFileSync('git', ['show', '--numstat', '--format=', hash], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    return {
      hash,
      files: out
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => {
          const [added = '0', removed = '0', ...rest] = line.split('\t');

          return {
            path: rest.join('\t'),
            added: Number(added) || 0,
            removed: Number(removed) || 0,
          };
        }),
    };
  } catch {
    return null;
  }
};

/** How far back the project's history is read for shipped tickets' commits. */
const COMMITS_READ = 2000;

/**
 * Each ticket's latest commit (`<id>: <title>`, as Lambda's ship writes it)
 * in the project's history, by ticket id. None when git can't be read.
 */
export const shippedCommits = (root: string): Map<string, string> => {
  try {
    const log = execFileSync(
      'git',
      ['log', `-n${COMMITS_READ}`, '--format=%h%x09%s'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );

    return log.split('\n').reduce<Map<string, string>>((found, line) => {
      const [hash = '', subject = ''] = line.split('\t');
      const id = /^([A-Za-z0-9_-]+):\s/.exec(subject)?.[1];

      // Newest first: a ticket's first match is its latest commit.
      return id === undefined || found.has(id) ? found : found.set(id, hash);
    }, new Map());
  } catch {
    return new Map();
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** The Tickets screen's change, refused when it sets what only a pod sets. */
export const checkChanges = (
  current: Pick<Ticket, 'status'>,
  changes: TicketChanges
): void => {
  if (changes.status === undefined || changes.status === current.status) {
    return;
  }

  if (BUILD_ONLY_STATES.includes(changes.status)) {
    throw new Error('Building and Shipped are set by the build.');
  }

  if (BUILD_ONLY_STATES.includes(current.status)) {
    throw new Error(
      `${
        current.status === 'done' ? 'Shipped' : 'Building'
      } is set by the build: its status can't be changed here.`
    );
  }
};

const str = (message: Message, key: string): string => {
  const value = message[key];

  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing "${key}"`);
  }

  return value;
};

/** A shipped ticket's commit and files, from the project's history. */
const shippedOf = (
  folder: string,
  ticketId: string,
  status: string
): ShippedCommit | null => {
  if (status !== 'done') {
    return null;
  }

  const hash = shippedCommits(folder).get(ticketId);

  return hash === undefined ? null : commitFiles(folder, hash);
};

export const createTicketRequests = (deps: TicketRequestDeps) => {
  const openSource = deps.openSource ?? realSource;
  const summaryRun = deps.summaryRun ?? realSummaryRun;
  /** One summary cache per project folder, so a run in flight is shared. */
  const summaries = new Map<string, ReturnType<typeof createTicketSummaries>>();

  const storeOf = (folder: string): PodStore =>
    createPodStore(resolvePodsRoot(projectOf(folder)));

  const summariesOf = (folder: string) => {
    const known = summaries.get(folder);

    if (known !== undefined) {
      return known;
    }

    const root = resolvePodsRoot(projectOf(folder));
    const made = createTicketSummaries({
      root,
      project: folder,
      run: summaryRun(folder, root),
      log: deps.log,
    });
    summaries.set(folder, made);

    return made;
  };

  const list = async (
    message: Message
  ): Promise<{
    tickets: TicketListItem[];
  }> => {
    const folder = str(message, 'folder');
    const projectId = str(message, 'projectId');
    const source = openSource(folder);
    const commits = shippedCommits(folder);
    const names = labelNamesOf(folder);
    const fromSource = (await source.list()).map((ticket) => ({
      ...named(listItem(ticket, projectId, source.kind, commits), names),
      ...(source.readOnly === true ? { readOnly: true } : {}),
    }));
    const known = new Set(fromSource.map((ticket) => ticket.id));
    // A ticket a pod planned but the source doesn't have yet: listed once,
    // as the pod's.
    const fromPods = [...plannedTickets(storeOf(folder), deps.log).entries()]
      .filter(([id]) => !known.has(id))
      .map(
        ([id, planned]): TicketListItem => ({
          id,
          title: planned.title,
          status: 'planning',
          parent: null,
          labels: [],
          url: null,
          projectId,
          source: 'pod',
          podId: planned.podId,
        })
      );

    return { tickets: [...fromSource, ...fromPods] };
  };

  /**
   * A ticket only a planning pod's checkpoint names (listed as `planning`):
   * its page comes from the checkpoint, since the source can't read it.
   */
  const plannedPage = (
    ticketId: string,
    projectId: string,
    planned: PlannedTicket
  ): Omit<TicketPage, 'events' | 'verdict' | 'summary'> => ({
    projectId,
    ticket: {
      id: ticketId,
      title: planned.title,
      status: 'planning',
      parent: null,
      labels: [],
      url: null,
      projectId,
      source: 'pod',
      podId: planned.podId,
      description: '',
    },
    plannedIn: { podId: planned.podId, title: planned.podTitle },
  });

  const sourcePage = async (
    source: TicketSource,
    ticketId: string,
    projectId: string,
    planned: PlannedTicket | null,
    labelNames: Record<string, string> = {}
  ): Promise<Omit<TicketPage, 'events' | 'verdict' | 'summary'>> => {
    try {
      const ticket = await source.get(ticketId);

      return {
        projectId,
        ticket: {
          ...named(listItem(ticket, projectId, source.kind), labelNames),
          ...(source.readOnly === true ? { readOnly: true } : {}),
          description: ticket.description,
        },
        plannedIn:
          planned === null
            ? null
            : { podId: planned.podId, title: planned.podTitle },
      };
    } catch (error) {
      if (planned === null || !isUnknownTicket(error, ticketId)) {
        throw error;
      }

      return plannedPage(ticketId, projectId, planned);
    }
  };

  const get = async (message: Message): Promise<Omit<TicketPage, 'events'>> => {
    const folder = str(message, 'folder');
    const projectId = str(message, 'projectId');
    const ticketId = str(message, 'ticketId');
    const planned =
      plannedTickets(storeOf(folder), deps.log).get(ticketId) ?? null;
    const page = await sourcePage(
      openSource(folder),
      ticketId,
      projectId,
      planned,
      labelNamesOf(folder)
    );
    const verdict = readVerdict(projectOf(folder).root, ticketId);

    return {
      ...page,
      summary: summariesOf(folder).stateOf(
        {
          id: ticketId,
          title: page.ticket.title,
          description: page.ticket.description,
        },
        planned,
        { opened: message.opened === true }
      ),
      verdict: verdict.kind === 'found' ? verdict.verdict.verdict : null,
      talk: ticketTalk(storeOf(folder), {
        id: ticketId,
        title: page.ticket.title,
      }),
      shipped: shippedOf(folder, page.ticket.id, page.ticket.status),
    };
  };

  const talk = async (message: Message): Promise<unknown> => {
    const output = await deps.lambda(
      [
        'pod',
        'talk-ticket',
        str(message, 'ticketId'),
        '--',
        str(message, 'text'),
      ],
      { cwd: str(message, 'folder'), timeoutMs: TALK_TIMEOUT_MS }
    );

    try {
      const parsed: unknown = JSON.parse(output.split('\n').at(-1) ?? '');

      return parsed;
    } catch {
      throw new Error(`lambda pod talk-ticket said: ${output}`);
    }
  };

  /**
   * `lambda pod build` for the mothership's project id, so the pod's claims
   * still match after the folder is linked again. `paused`: the pod Lambda
   * keeps on every computer, made paused.
   */
  const startBuilding = async (message: Message): Promise<string> => {
    const projectId = str(message, 'projectId');
    const output = await deps.lambda(
      [
        'pod',
        'build',
        '--project-id',
        projectId,
        ...(message.paused === true ? ['--paused'] : []),
      ],
      { cwd: str(message, 'folder'), timeoutMs: BUILD_TIMEOUT_MS }
    );
    const podId = CREATED_POD.exec(output)?.[1];

    if (podId === undefined) {
      throw new Error(output.trim() || 'lambda pod build made no pod.');
    }

    return podId;
  };

  /** A change from the Tickets screen: the ticket after it. */
  const update = async (message: Message): Promise<TicketListItem> => {
    const folder = str(message, 'folder');
    const projectId = str(message, 'projectId');
    const ticketId = str(message, 'ticketId');
    const changes: TicketChanges = isRecord(message.changes)
      ? message.changes
      : {};
    const source = openSource(folder);
    checkChanges(await source.get(ticketId), changes);
    const updated = await source.update(ticketId, {
      ...changes,
      // A Blocked set here has no reason: the person can say it in a comment.
      ...(changes.status === 'blocked' ? { reason: undefined } : {}),
    });

    return listItem(updated, projectId, source.kind, shippedCommits(folder));
  };

  /** A new ticket from the New ticket dialog. */
  const create = async (message: Message): Promise<TicketListItem> => {
    const folder = str(message, 'folder');
    const projectId = str(message, 'projectId');
    const input: NewTicket = isRecord(message.ticket)
      ? { title: '', ...message.ticket }
      : { title: '' };

    if (input.title.trim() === '') {
      throw new Error('A ticket needs a title.');
    }

    if (
      input.status !== undefined &&
      BUILD_ONLY_STATES.includes(input.status)
    ) {
      throw new Error('Building and Shipped are set by the build.');
    }

    const source = openSource(folder);

    return listItem(
      await source.create({ ...input, title: input.title.trim() }),
      projectId,
      source.kind
    );
  };

  /**
   * Moves a ticket in queue order: right after `after`, or first among its
   * siblings when `after` is null. Only among its own siblings.
   */
  const move = async (message: Message): Promise<void> => {
    const ticketId = str(message, 'ticketId');
    const after = typeof message.after === 'string' ? message.after : null;
    const source = openSource(str(message, 'folder'));
    const tickets = await source.list();
    const moving = tickets.find((ticket) => ticket.id === ticketId);

    if (moving === undefined) {
      throw new Error(`${ticketId} isn't a ticket I can read.`);
    }

    const siblings = tickets
      .filter((ticket) => ticket.parent === moving.parent)
      .map((ticket) => ticket.id);

    if (after !== null && !siblings.includes(after)) {
      throw new Error(`${after} isn't next to ${ticketId} in the queue.`);
    }

    const rest = siblings.filter((id) => id !== ticketId);
    const at = after === null ? 0 : rest.indexOf(after) + 1;
    const order = [...rest.slice(0, at), ticketId, ...rest.slice(at)];

    if (moving.parent !== null) {
      await source.reorder(moving.parent, order);

      return;
    }

    // Top level: `place` puts a block after a ticket, so the first place
    // moves everything else after it instead.
    const [first] = order;

    if (first === ticketId) {
      const others = order.slice(1);

      if (others.length > 0) {
        await source.place(others, ticketId);
      }

      return;
    }

    await source.place([ticketId], order[at - 1] ?? first ?? ticketId);
  };

  /**
   * "Plan more" on a Lambda past planning: its tickets go back to Planning
   * (out of the build queue), and the planning pod that planned them opens
   * again with the ask as a work request. Refused when the pod is gone: the
   * app starts a new planning chat instead.
   */
  const planMore = async (message: Message): Promise<{ podId: string }> => {
    const folder = str(message, 'folder');
    const podId = str(message, 'podId');
    const text = str(message, 'text');
    const ticketIds = Array.isArray(message.ticketIds)
      ? message.ticketIds.filter(
          (id): id is string => typeof id === 'string' && id !== ''
        )
      : [];
    const store = storeOf(folder);

    if (store.readPod(podId) === null) {
      throw new Error(`The planning Lambda ${podId} is gone.`);
    }

    const source = openSource(folder);
    await ticketIds.reduce(async (sofar, id) => {
      await sofar;
      const ticket = await source.get(id).catch(() => null);

      if (ticket !== null && !BUILD_ONLY_STATES.includes(ticket.status)) {
        await source.update(id, { status: 'planning' });
      }
    }, Promise.resolve());

    await deps.lambda(['pod', 'resume', podId], {
      cwd: folder,
      timeoutMs: BUILD_TIMEOUT_MS,
    });
    const about = ticketIds.length === 0 ? '' : ` on ${ticketIds.join(', ')}`;
    await deps.lambda(
      [
        'pod',
        'request',
        'add',
        '--pod',
        podId,
        '--quote',
        text,
        '--',
        `Plan more${about}: ${text.split('\n')[0] ?? ''}`.slice(0, 200),
      ],
      { cwd: folder, timeoutMs: TALK_TIMEOUT_MS }
    );

    return { podId };
  };

  /** The codebase's tracker projects, for the Projects page and the picker. */
  const trackerProjects = async (
    message: Message
  ): Promise<{ projects: TrackerProject[] }> => ({
    projects: await openSource(str(message, 'folder')).projects(),
  });

  /**
   * The tracker's saved views (translated) and its key's favorites, for
   * Import from Linear. A tracker with neither answers empty.
   */
  const trackerViews = async (
    message: Message
  ): Promise<{ views: TrackerView[]; favorites: TrackerFavorite[] }> => {
    const folder = str(message, 'folder');
    const source = openSource(folder);
    const names = labelNamesOf(folder);

    return {
      // A label chip names the label as the list shows it, so it matches.
      views: ((await source.views?.()) ?? []).map((view) => ({
        ...view,
        chips: view.chips.map((chip) =>
          chip.field === 'label'
            ? { ...chip, value: names[chip.value] ?? chip.value }
            : chip
        ),
      })),
      favorites: await (source.favorites?.() ?? Promise.resolve([])).catch(
        () => []
      ),
    };
  };

  return {
    list,
    get,
    talk,
    startBuilding,
    update,
    create,
    move,
    planMore,
    trackerProjects,
    trackerViews,
  };
};

export type TicketRequests = ReturnType<typeof createTicketRequests>;
