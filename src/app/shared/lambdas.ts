import type { Question } from '../../pod-store';
import type { RunView } from './building';
import { podName } from './podName';
import type { AppState, InboxEntry, PodSummary } from './types';

/**
 * A Lambda is one piece of work across its whole life: the planning pod that
 * planned it, its tickets, and those tickets' building runs on any computer,
 * until they ship. Its row stays in the sidebar the whole way, moving between
 * sections as the work moves. Worked out here from the app's state alone:
 * pure, so the client bundles it.
 */

export type LambdaPhase =
  | 'planning'
  | 'queued'
  | 'building'
  | 'qa'
  | 'shipped'
  | 'done';

/** Where one ticket of a Lambda is. */
export type TicketWhere =
  | {
      kind: 'building';
      step: string;
      startedAt: string;
      computer: string;
      podId: string;
    }
  | {
      kind: 'blocked';
      computer: string;
      podId: string;
      messageId: string | null;
    }
  | {
      kind: 'queued';
      place: number;
      computer: string;
      podId: string;
      ahead: Array<{ id: string; title: string }>;
    }
  | { kind: 'shipped'; at: string; computer: string; podId: string }
  | { kind: 'waiting' };

export interface LambdaTicket {
  id: string;
  title: string;
  where: TicketWhere;
}

export interface Lambda {
  /** `pod:<planning pod id>`, or `ticket:<project>/<ticket id>`. */
  key: string;
  title: string;
  projectId: string | null;
  /** The planning pod that planned it; null for a ticket made directly. */
  planningPodId: string | null;
  /** The epic or the one ticket it's about, when there is one. */
  ticketId: string | null;
  tickets: LambdaTicket[];
  phase: LambdaPhase;
  /** Its items waiting on the owner, in Auto's order. */
  needsYou: InboxEntry[];
  /** An agent of it is mid-turn: the sidebar's spinner. */
  working: boolean;
  /** Its newest ship (ISO), once any ticket of it shipped. */
  shippedAt: string | null;
  /** Its planning pod is paused. */
  paused: boolean;
}

/** How long a shipped Lambda stays in the sidebar. */
export const SHIPPED_KEPT_MS = 24 * 60 * 60_000;

const isBuildingPod = (summary: PodSummary): boolean =>
  summary.pod.kind === 'building' && summary.pod.talk === undefined;

/** Every ticket a planning pod planned, with its plain title. */
const plannedTickets = (
  summary: PodSummary,
  questions: Question[]
): Array<{ id: string; title: string }> => {
  const planned = questions.flatMap((question) =>
    (question.checkpoint?.planTickets ?? []).map((ticket) => ({
      id: ticket.id,
      title: ticket.name ?? ticket.title,
    }))
  );
  // The latest checkpoint's title wins; tickets named only on the pod come too.
  const byId = new Map<string, string>();
  planned.forEach((ticket) => byId.set(ticket.id, ticket.title));
  (summary.pod.tickets ?? []).forEach((id) => {
    if (!byId.has(id)) {
      byId.set(id, id);
    }
  });

  return [...byId].map(([id, title]) => ({ id, title }));
};

interface BuildingFacts {
  podId: string;
  computer: string;
  runs: RunView[];
  upNext: Array<{ id: string; title: string }>;
  hasCurrent: boolean;
}

const buildingFacts = (state: AppState): BuildingFacts[] =>
  state.pods.filter(isBuildingPod).map((summary) => {
    // An ended pod put back the ticket it hadn't shipped (`lambda pod done`):
    // only what it shipped is still its, or the ticket reads as building
    // there for good.
    const ended = summary.pod.status === 'done';
    const runs = (summary.building?.runs ?? []).filter(
      (run) => !ended || run.shippedAt !== null
    );

    return {
      podId: summary.pod.id,
      computer: state.lambda?.podComputers?.[summary.pod.id] ?? 'A computer',
      runs,
      upNext: ended ? [] : summary.building?.upNext ?? [],
      hasCurrent:
        !ended &&
        summary.building?.current !== null &&
        summary.building?.current !== undefined,
    };
  });

/** Where a ticket is: its newest run anywhere, else its place in a queue. */
const whereIs = (id: string, facts: BuildingFacts[]): TicketWhere => {
  const latest = facts
    .flatMap((fact) =>
      fact.runs.filter((run) => run.id === id).map((run) => ({ run, fact }))
    )
    .sort((a, b) => a.run.startedAt.localeCompare(b.run.startedAt))
    .at(-1);

  if (latest !== undefined) {
    const { run, fact } = latest;

    if (run.shippedAt !== null) {
      return {
        kind: 'shipped',
        at: run.shippedAt,
        computer: fact.computer,
        podId: fact.podId,
      };
    }

    if (run.blocked !== null) {
      return {
        kind: 'blocked',
        computer: fact.computer,
        podId: fact.podId,
        messageId: run.blocked.messageId,
      };
    }

    return {
      kind: 'building',
      step: run.step,
      startedAt: run.startedAt,
      computer: fact.computer,
      podId: fact.podId,
    };
  }

  const queued = facts
    .map((fact) => ({
      fact,
      index: fact.upNext.findIndex((next) => next.id === id),
    }))
    .find(({ index }) => index !== -1);

  if (queued !== undefined) {
    const { fact, index } = queued;
    const current = fact.runs.find(
      (run) => run.shippedAt === null && run.blocked === null
    );

    return {
      kind: 'queued',
      place: index + 1 + (fact.hasCurrent ? 1 : 0),
      computer: fact.computer,
      podId: fact.podId,
      ahead: [
        ...(current === undefined
          ? []
          : [{ id: current.id, title: current.title }]),
        ...fact.upNext.slice(0, index),
      ],
    };
  }

  return { kind: 'waiting' };
};

/** A Lambda past planning: where its tickets are decides its phase. */
const phaseOf = (tickets: LambdaTicket[], reviewing: boolean): LambdaPhase => {
  if (tickets.length === 0) {
    return 'done';
  }

  if (reviewing) {
    return 'qa';
  }

  if (
    tickets.some(
      (ticket) =>
        ticket.where.kind === 'building' || ticket.where.kind === 'blocked'
    )
  ) {
    return 'building';
  }

  if (tickets.every((ticket) => ticket.where.kind === 'shipped')) {
    return 'shipped';
  }

  return 'queued';
};

const newestShip = (tickets: LambdaTicket[]): string | null =>
  tickets
    .flatMap((ticket) =>
      ticket.where.kind === 'shipped' ? [ticket.where.at] : []
    )
    .sort()
    .at(-1) ?? null;

/** Every Lambda in the app's state, in the sidebar's priority order. */
export const lambdasOf = (state: AppState): Lambda[] => {
  const facts = buildingFacts(state);
  const projects = state.lambda?.podProjects ?? {};
  const rank = (podId: string): number => {
    const index = state.priority.indexOf(podId);

    return index === -1 ? state.priority.length : index;
  };
  const planning = state.pods
    .filter((summary) => summary.pod.kind !== 'building')
    .sort((a, b) => rank(a.pod.id) - rank(b.pod.id));
  const claimed = new Set<string>();

  const fromPods = planning.map((summary): Lambda => {
    const { pod } = summary;
    const planned = plannedTickets(summary, state.questions[pod.id] ?? []);
    // An epic's children are what gets built; a ticket planned alone is itself.
    const leaves =
      planned.length > 0
        ? planned
        : pod.epicId === undefined
        ? []
        : [{ id: pod.epicId, title: podName(pod) }];
    const tickets = leaves.map((ticket) => ({
      ...ticket,
      where: whereIs(ticket.id, facts),
    }));
    tickets.forEach((ticket) => claimed.add(ticket.id));

    if (pod.epicId !== undefined) {
      claimed.add(pod.epicId);
    }

    const ids = new Set(tickets.map((ticket) => ticket.id));
    const needsYou = state.inbox.filter(
      (entry) =>
        entry.podId === pod.id ||
        (entry.ticketId !== undefined && ids.has(entry.ticketId))
    );
    const done = pod.status === 'done';

    return {
      key: `pod:${pod.id}`,
      title: podName(pod),
      projectId: projects[pod.id] ?? pod.projectId ?? null,
      planningPodId: pod.id,
      ticketId:
        pod.epicId ?? (tickets.length === 1 ? tickets[0]?.id ?? null : null),
      tickets,
      phase: done
        ? phaseOf(
            tickets,
            needsYou.some((entry) => entry.tag === 'review')
          )
        : 'planning',
      needsYou,
      working: !done && summary.devBusy === true,
      shippedAt: newestShip(tickets),
      paused: pod.status === 'paused',
    };
  });

  // Tickets made directly (no planning pod): one Lambda each, once a
  // computer has taken or queued one, or a reply about it waits on the owner.
  const loose = new Map<string, { title: string; projectId: string | null }>();
  facts.forEach((fact) => {
    const projectId = projects[fact.podId] ?? null;
    [...fact.runs, ...fact.upNext].forEach((ticket) => {
      if (!claimed.has(ticket.id) && !loose.has(ticket.id)) {
        loose.set(ticket.id, { title: ticket.title, projectId });
      }
    });
  });
  // Asking about a ticket adds no row: only a reply waiting on the owner.
  state.pods
    .filter(
      (summary) =>
        summary.pod.talk !== undefined &&
        summary.pod.status !== 'done' &&
        state.inbox.some((entry) => entry.podId === summary.pod.id)
    )
    .forEach((summary) => {
      const id = summary.pod.talk?.ticketId ?? '';

      if (!claimed.has(id) && !loose.has(id)) {
        loose.set(id, {
          title: id,
          projectId: projects[summary.pod.id] ?? null,
        });
      }
    });

  const fromTickets = [...loose].map(([id, { title, projectId }]): Lambda => {
    const tickets = [{ id, title, where: whereIs(id, facts) }];
    const talkPods = new Set(
      state.pods
        .filter((summary) => summary.pod.talk?.ticketId === id)
        .map((summary) => summary.pod.id)
    );
    const needsYou = state.inbox.filter(
      (entry) => entry.ticketId === id || talkPods.has(entry.podId)
    );

    return {
      key: `ticket:${projectId ?? ''}/${id}`,
      title,
      projectId,
      planningPodId: null,
      ticketId: id,
      tickets,
      phase: phaseOf(
        tickets,
        needsYou.some((entry) => entry.tag === 'review')
      ),
      needsYou,
      working: false,
      shippedAt: newestShip(tickets),
      paused: false,
    };
  });

  return [...fromPods, ...fromTickets];
};

export interface SidebarSections {
  needsYou: Lambda[];
  planning: Lambda[];
  queued: Lambda[];
  building: Lambda[];
  shipped: Lambda[];
  done: Lambda[];
}

/**
 * The sidebar's sections. A Lambda waiting on the owner is in Needs you
 * only (in Auto's order: its first item's place in the inbox); the rest go
 * by phase. A shipped Lambda stays a day; a plan or chat that made no
 * tickets goes to Done.
 */
export const sidebarSections = (
  lambdas: Lambda[],
  inbox: InboxEntry[],
  now: number
): SidebarSections => {
  const firstItem = (lambda: Lambda): number =>
    Math.min(
      ...lambda.needsYou.map((entry) => {
        const at = inbox.findIndex((candidate) => candidate.key === entry.key);

        return at === -1 ? inbox.length : at;
      })
    );
  const waiting = lambdas
    .filter((lambda) => lambda.needsYou.length > 0)
    .sort((a, b) => firstItem(a) - firstItem(b));
  const rest = lambdas.filter((lambda) => lambda.needsYou.length === 0);
  const inPhase = (phase: LambdaPhase): Lambda[] =>
    rest.filter((lambda) => lambda.phase === phase);

  return {
    needsYou: waiting,
    planning: inPhase('planning'),
    queued: inPhase('queued'),
    building: [...inPhase('building'), ...inPhase('qa')],
    shipped: inPhase('shipped')
      .filter(
        (lambda) =>
          lambda.shippedAt !== null &&
          now - Date.parse(lambda.shippedAt) < SHIPPED_KEPT_MS
      )
      .sort((a, b) => (b.shippedAt ?? '').localeCompare(a.shippedAt ?? '')),
    done: inPhase('done'),
  };
};

/** The Lambda an inbox item belongs to. */
export const lambdaOfEntry = (
  lambdas: Lambda[],
  entry: InboxEntry
): Lambda | undefined =>
  lambdas.find((lambda) =>
    lambda.needsYou.some((item) => item.key === entry.key)
  );

/**
 * The pod a Lambda's page stands on (what `view` is set to while it's up):
 * its planning pod, else the computer that has its ticket.
 */
export const anchorOf = (lambda: Lambda): string | null =>
  lambda.planningPodId ??
  lambda.tickets.flatMap((ticket) =>
    'podId' in ticket.where ? [ticket.where.podId] : []
  )[0] ??
  null;

/** The Lambda a ticket is part of: its own, or its epic's. */
export const lambdaOfTicket = (
  lambdas: Lambda[],
  projectId: string,
  ticketId: string
): Lambda | undefined =>
  lambdas.find(
    (lambda) =>
      (lambda.projectId === null || lambda.projectId === projectId) &&
      (lambda.ticketId === ticketId ||
        lambda.tickets.some((ticket) => ticket.id === ticketId))
  );

/**
 * Where "Ask about this ticket" goes, and what its box says: the block it's
 * waiting on, the planning chat while it's planned, else Lambda.
 */
export type AskRoute =
  | { to: 'block'; podId: string; messageId: string }
  | { to: 'planning'; podId: string }
  | { to: 'lambda' };

export const askRouteOf = (
  lambda: Lambda | undefined,
  ticketId: string
): AskRoute => {
  const blocked = lambda?.needsYou.find(
    (entry) => entry.tag === 'blocked' && entry.ticketId === ticketId
  );

  if (blocked?.messageId !== undefined) {
    return { to: 'block', podId: blocked.podId, messageId: blocked.messageId };
  }

  if (lambda?.phase === 'planning' && lambda.planningPodId !== null) {
    return { to: 'planning', podId: lambda.planningPodId };
  }

  return { to: 'lambda' };
};
