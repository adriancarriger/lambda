import type {
  BuildTicketRun,
  BuildingState,
  Pod,
  Screenshot,
  ThreadMessage,
} from '../../pod-store';
import type { TrackerProject } from '../../tickets/source';
import type { Priority, Ticket, TicketState } from '../../tickets/source';
import { pendingReplies } from './conversation';

/**
 * What the app shows of building pods and the Tickets screen, and the shapes
 * the mothership's routes answer with. Pure: the client bundles this file.
 */

// ── a building pod in the sidebar ───────────────────────────────────────────

export type BuildingStateName =
  | 'building'
  | 'testing'
  | 'shipping'
  | 'blocked'
  | 'paused'
  | 'idle';

export interface BuildingSummary {
  state: BuildingStateName;
  /** The ticket it's on, and its step and attempt there. */
  current: Pick<BuildTicketRun, 'id' | 'title' | 'step' | 'attempt'> | null;
  /** "ticket N of M": null before it has taken a ticket. */
  position: { n: number; m: number } | null;
  /** With nothing current: "Nothing ready to build", or why it's waiting. */
  idleReason: string | null;
  /** The last ticket it shipped, and when (ISO); left out by older pods. */
  lastShipped?: { id: string; at: string } | null;
  /**
   * Every ticket it has taken, oldest first (the newest 60): where each
   * Lambda's tickets are, for the sidebar and a Lambda's page. Left out by
   * older pods.
   */
  runs?: RunView[];
  /** Its queue after the current ticket, in order: "3rd in line". */
  upNext?: Array<{ id: string; title: string }>;
}

/** One ticket a building pod took, as the sidebar sees it. */
export interface RunView {
  id: string;
  title: string;
  step: string;
  startedAt: string;
  shippedAt: string | null;
  /** Its Blocked item, while it's blocked: the message the owner answers. */
  blocked: { messageId: string | null } | null;
}

/** How many runs a summary carries. */
export const RUNS_KEPT = 60;

const runView = (run: BuildTicketRun): RunView => ({
  id: run.id,
  title: run.title,
  step: run.step,
  startedAt: run.startedAt,
  shippedAt: run.shippedAt ?? null,
  blocked:
    run.blocked === undefined
      ? null
      : { messageId: run.blocked.messageId ?? null },
});

/** The run a pod is building now: the last one neither shipped nor blocked. */
export const currentRun = (
  state: Pick<BuildingState, 'runs'>
): BuildTicketRun | null => {
  const last = state.runs.at(-1);

  return last === undefined ||
    last.shippedAt !== undefined ||
    last.blocked !== undefined
    ? null
    : last;
};

/**
 * Pause/Resume is held from its click (`clickedFrom`, the pod's status then;
 * null once it failed) until the pod's status is no longer that: the label
 * only changes on the next state push, after the request has settled, and a
 * second click in that gap would send the same one again.
 */
export const pauseHeld = (
  clickedFrom: Pod['status'] | null,
  status: Pod['status']
): boolean => clickedFrom !== null && clickedFrom === status;

/**
 * The building page header's state line: the state push's, live, over the
 * page's own read, which is up to 5 seconds old (after Pause the header
 * would say "building" while the sidebar already says "paused").
 */
export const headerBuilding = (
  live: BuildingSummary | undefined,
  polled: BuildingSummary | undefined
): BuildingSummary | undefined => live ?? polled;

/**
 * A run's screenshots of one test attempt. A ticket blocked and taken again
 * numbers its attempts from 1 again, into the same manifest, so an earlier
 * run's shots are left out: only those taken since this run started.
 */
export const runShots = (
  screenshots: Record<string, Screenshot[]>,
  run: Pick<BuildTicketRun, 'id' | 'startedAt'>,
  attempt: number
): Screenshot[] =>
  (screenshots[`${run.id}/${attempt}`] ?? []).filter(
    (shot) => Date.parse(shot.at) >= Date.parse(run.startedAt)
  );

/**
 * The tickets a pod has taken, each once, in the order it last took them:
 * the current ticket is always the last.
 */
export const takenTickets = (state: Pick<BuildingState, 'runs'>): string[] =>
  state.runs
    .map((run) => run.id)
    .filter((id, index, ids) => ids.lastIndexOf(id) === index);

/**
 * Blocked items whose ticket is no longer blocked: set back to Ready, it's in
 * the runner's last poll (Up next) or a later run took it again. Their ids,
 * so the inbox leaves them out without the owner having to answer.
 */
export const unblockedAsks = (
  state: Pick<BuildingState, 'runs' | 'upNext'>
): Set<string> =>
  new Set(
    state.runs.flatMap((run, index) =>
      run.blocked?.messageId !== undefined &&
      (state.upNext.some((ticket) => ticket.id === run.id) ||
        state.runs.slice(index + 1).some((later) => later.id === run.id))
        ? [run.blocked.messageId]
        : []
    )
  );

/** What a folded block adds to its item (building/breaker.ts). */
export const alsoHeldText = (held: { id: string; title: string }[]): string =>
  `**Also held by this, not started and back in Ready:** ${held
    .map((one) => `${one.id} ${one.title}`)
    .join('; ')}. Lambda paused this builder.`;

/**
 * A building pod's thread with each Blocked item listing the tickets folded
 * into it: the thread is append-only, so the item's text grows as served.
 */
export const withAlsoHeld = (
  thread: ThreadMessage[],
  state: Pick<BuildingState, 'runs'> | null
): ThreadMessage[] => {
  const held = new Map(
    (state?.runs ?? []).flatMap((run) =>
      run.blocked?.messageId !== undefined &&
      (run.blocked.alsoHeld ?? []).length > 0
        ? [[run.blocked.messageId, run.blocked.alsoHeld ?? []] as const]
        : []
    )
  );

  return held.size === 0
    ? thread
    : thread.map((message) => {
        const list = held.get(message.id);

        return list === undefined
          ? message
          : { ...message, text: `${message.text}\n\n${alsoHeldText(list)}` };
      });
};

/**
 * The items a building pod is waiting on the owner for, oldest first: the
 * inbox's "Your turn" entries for it, so its page can answer them too. A
 * Blocked item drops out once its ticket is back in the queue; a one-ticket
 * talk (`null`) has no queue to check.
 */
export const buildingReplyItems = (
  thread: ThreadMessage[],
  state: Pick<BuildingState, 'runs' | 'upNext'> | null
): ThreadMessage[] => {
  const unblocked = state === null ? new Set<string>() : unblockedAsks(state);

  return pendingReplies(thread).filter((message) => !unblocked.has(message.id));
};

/**
 * The Tickets rail: Done (shipped, oldest first), Current and Up next. A
 * blocked ticket isn't done: it's in the owner's inbox and the Tickets
 * screen's Blocked group. Nor is one let go when its pod ended.
 */
export const ticketsRail = (
  state: Pick<BuildingState, 'runs' | 'upNext'>
): {
  done: BuildTicketRun[];
  current: BuildTicketRun | null;
  upNext: BuildingState['upNext'];
} => ({
  done: state.runs.filter((run) => run.shippedAt !== undefined),
  current: currentRun(state),
  upNext: state.upNext,
});

/**
 * The sidebar's state: `test` → testing, `ship` → shipping, any other step
 * (an added one too) → building. Paused wins whatever the step. With no
 * current ticket: blocked when the last ticket went Blocked and nothing is
 * takeable, else idle. N counts every ticket taken (shipped, blocked and the
 * current one); M adds what's still queued. Each ticket counts once: one
 * blocked, set back to Ready and taken again is one ticket, not two.
 */
export const buildingStateOf = (
  pod: Pick<Pod, 'status'>,
  state: BuildingState
): BuildingSummary => {
  const current = currentRun(state);
  const taken = takenTickets(state);
  const n = taken.length;
  const queued = state.upNext.filter((ticket) => !taken.includes(ticket.id));
  const position = n === 0 ? null : { n, m: n + queued.length };
  const base = {
    current:
      current === null
        ? null
        : {
            id: current.id,
            title: current.title,
            step: current.step,
            attempt: current.attempt,
          },
    position,
    idleReason: current === null ? state.idleReason ?? null : null,
    lastShipped: lastShippedOf(state),
    runs: state.runs.slice(-RUNS_KEPT).map(runView),
    upNext: state.upNext.map(({ id, title }) => ({ id, title })),
  };

  if (pod.status === 'paused') {
    return { ...base, state: 'paused' };
  }

  if (current !== null) {
    return {
      ...base,
      state:
        current.step === 'test'
          ? 'testing'
          : current.step === 'ship'
          ? 'shipping'
          : 'building',
    };
  }

  const last = state.runs.at(-1);

  return {
    ...base,
    state:
      last?.blocked !== undefined && state.upNext.length === 0
        ? 'blocked'
        : 'idle',
  };
};

/** "testing · ticket 3 of 7", "idle · Nothing ready to build". */
export const buildingLine = (summary: BuildingSummary): string => {
  const position =
    summary.position === null
      ? null
      : `ticket ${summary.position.n} of ${summary.position.m}`;
  const detail =
    summary.current === null ? summary.idleReason ?? position : position;

  return detail === null ? summary.state : `${summary.state} · ${detail}`;
};

export const NOTHING_READY_TO_BUILD = 'Nothing ready to build';

const lastShippedOf = (
  state: Pick<BuildingState, 'runs'>
): { id: string; at: string } | null => {
  const shipped = state.runs.filter(
    (run): run is BuildTicketRun & { shippedAt: string } =>
      run.shippedAt !== undefined
  );
  const last = shipped.at(-1);

  return last === undefined ? null : { id: last.id, at: last.shippedAt };
};

/** "just now", "4m ago", "2h ago", "3d ago". */
export const agoShort = (then: number, now: number): string => {
  const minutes = Math.floor((now - then) / 60_000);

  if (minutes < 1) {
    return 'just now';
  }

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);

  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
};

/**
 * The sidebar's second line for a building computer: `testing · PAWNEE-2`
 * while on a ticket, `paused`, `idle · shipped PAWNEE-1 4m ago` after a
 * ship, else the waiting reason.
 */
export const sidebarBuildingLine = (
  summary: BuildingSummary,
  now: number
): string => {
  if (summary.state === 'paused') {
    return 'paused';
  }

  if (summary.current !== null) {
    return `${summary.state} · ${summary.current.id}`;
  }

  const shipped = summary.lastShipped ?? null;

  if (summary.state === 'idle' && shipped !== null) {
    return `idle · shipped ${shipped.id} ${agoShort(
      Date.parse(shipped.at),
      now
    )}`;
  }

  return buildingLine(summary);
};

/**
 * The sidebar's Conversations: each "Talk about this ticket" still open. The
 * Product manager answers them in the pod, never in the inbox, so this is
 * the way back to one.
 */
export const openTalks = <T extends { status: string; pod: Pick<Pod, 'talk'> }>(
  summaries: T[]
): T[] =>
  summaries.filter(
    (summary) => summary.status !== 'done' && summary.pod.talk !== undefined
  );

/**
 * A building pod's page re-reads its pod on app events, but at most this
 * often: a busy project sends many. A tick inside the wait is read once it
 * is up, so the page is never left on a stale read.
 */
export const BUILDING_REFRESH_MS = 5_000;

/**
 * What a rail shows before the page's first answer: the load's error once it
 * failed (an offline runner), never "Loading…" for ever.
 */
export const railPlaceholder = (error: string | null): string =>
  error === null ? 'Loading…' : `Couldn't load this pod: ${error}`;

/** How long until the page reads again: 0 for now. */
export const buildingRefreshIn = (lastAt: number | null, now: number): number =>
  lastAt === null ? 0 : Math.max(0, lastAt + BUILDING_REFRESH_MS - now);

/**
 * Which building page a pod gets: a full building pod (Pause, the Workflow
 * and Tickets rails), or a one-ticket "Talk about this ticket" conversation
 * with the Product manager and nothing else. A planning pod gets neither.
 */
export const buildingScreenMode = (
  pod: Pick<Pod, 'kind' | 'talk'>
): 'building' | 'talk' | null => {
  if (pod.kind !== 'building') {
    return null;
  }

  return pod.talk === undefined ? 'building' : 'talk';
};

// ── the visual check's pictures ─────────────────────────────────────────────

/** One issue the visual check's judge found in a picture. */
export interface VisualIssueView {
  severity: 'high' | 'medium' | 'medium-low' | 'low';
  where: string;
  what: string;
}

/**
 * One picture of a visual check round, as its `manifest.json` lists it:
 * `expected` and `actual` are file names in the round's folder,
 * `<pods root>/<pod>/visual/<ticket>/<round>/`.
 */
export interface VisualPictureView {
  scenarioId: string;
  situation: string;
  expected: string;
  actual: string;
  issues: VisualIssueView[];
}

/** A recorded round: its pictures, and when it was copied (ISO). */
export interface VisualRoundView {
  round: number;
  at: string;
  pictures: VisualPictureView[];
}

/** `GET /api/pod/<pod>/visual/<ticket>/<round>/<file>`: a round's picture. */
export const visualPictureUrl = (
  podId: string,
  ticketId: string,
  round: number,
  file: string
): string =>
  `/api/pod/${encodeURIComponent(podId)}/visual/${encodeURIComponent(
    ticketId
  )}/${round}/${encodeURIComponent(file)}`;

/**
 * The Workflow rail's Visual check: this run's rounds (a ticket blocked and
 * taken again starts over), its label ("Visual check · round 2"), and one
 * expected | actual pair per picture per round, `missed` on a picture with
 * an issue.
 */
export const visualRail = (
  visual: Record<string, VisualRoundView[]>,
  run: Pick<BuildTicketRun, 'id' | 'startedAt'>
): {
  label: string | null;
  rounds: VisualRoundView[];
} => {
  const rounds = (visual[run.id] ?? [])
    .filter((round) => Date.parse(round.at) >= Date.parse(run.startedAt))
    .sort((a, b) => a.round - b.round);
  const last = rounds.at(-1);

  return {
    label: last === undefined ? null : `Visual check · round ${last.round}`,
    rounds,
  };
};

// ── GET /api/building/<pod> ─────────────────────────────────────────────────

/** One event the Workflow rail reads (the mothership's stored events). */
export interface TimelineEvent {
  type: string;
  /** A stage's or ship part's name (`build`, `security-review`). */
  name: string | null;
  ticket: string | null;
  attempt: number | null;
  pod: string | null;
  /** `pass` / `fail`. */
  result: string | null;
  /** Epoch ms. */
  at: number;
  /** A `stage.end` for a step that was skipped, never run. */
  skipped?: boolean;
  /** Why it was skipped ("no design"). */
  skipReason?: string | null;
  /** A `ticket.edit`: what it was changed to ("High"), and who by. */
  note?: string | null;
  source?: string | null;
}

/** A building pod's page. */
export interface BuildingPodDetail {
  pod: Pod;
  /** The Product manager conversation, with the Engineering manager's bubbles. */
  thread: ThreadMessage[];
  /** Its tmux windows: one Agents tab each. */
  windows: string[];
  building: BuildingState;
  summary: BuildingSummary;
  /**
   * The project's building steps, in order (its workflow.json applied). One
   * switched off is marked `off`: shown only where a ticket skipped it.
   */
  steps: { id: string; label: string; off?: boolean }[];
  /** `<ticket>/<attempt>` → that test attempt's screenshots. */
  screenshots: Record<string, Screenshot[]>;
  /** `<ticket>` → its visual check rounds, oldest first. */
  visual: Record<string, VisualRoundView[]>;
  /** The computer it builds on. */
  computer: string;
  /** Added by the mothership: this pod's tickets' events, for the timeline. */
  events: TimelineEvent[];
  /**
   * Added by the mothership: Typical ticket, the median of every shipped
   * ticket in the project (worked out there, so the page isn't sent them all).
   */
  typicalMs: number | null;
}

// ── the Tickets screen ──────────────────────────────────────────────────────

/** A ticket as the Tickets screen lists it. */
export interface TicketListItem
  extends Pick<
    Ticket,
    'id' | 'title' | 'status' | 'parent' | 'labels' | 'url'
  > {
  projectId: string;
  /** `markdown`, `linear`, `jira`, or `pod` for one a pod made. */
  source: string;
  /** A pod-made ticket: the pod. */
  podId?: string;
  /** Left out by an older computer: read as none. */
  priority?: Priority;
  /** The computer it's assigned to; null or left out: unassigned. */
  assignee?: string | null;
  blockReason?: string | null;
  /** A shipped ticket's commit (short hash), when the project's git has it. */
  commit?: string | null;
  /** Added by the mothership: when anything last happened to it (epoch ms). */
  updatedAt?: number | null;
  /** The tracker's own state name, when it says more ("In review"). */
  trackerStatus?: string | null;
  /** Its project's tickets are read-only here: nothing can be changed. */
  readOnly?: boolean;
  /** The tracker's project it's in ("Lot 48"); null or left out: none. */
  project?: string | null;
}

/** GET /api/tracker-projects: each codebase's tracker projects. */
export interface TrackerProjectsResponse {
  codebases: Array<
    | { projectId: string; name: string; projects: TrackerProject[] }
    | { projectId: string; name: string; offline: string }
  >;
}

/** What a ticket's commit changed, for the Merged summary. */
export interface ShippedCommit {
  hash: string;
  files: Array<{ path: string; added: number; removed: number }>;
}

/** One message of a ticket's conversation, on its page's Activity. */
export interface TicketTalk {
  /** ISO time. */
  at: string;
  from: 'you' | 'product-manager' | 'dev';
  text: string;
  /** The pod it's in: "Open the conversation". */
  podId: string;
}

/** What a person may change on a ticket from the Tickets screen. */
export interface TicketChanges {
  title?: string;
  description?: string;
  /** Planning, Ready, Blocked or Canceled: Building and Shipped are the build's. */
  status?: TicketState;
  priority?: Priority;
  assignee?: string | null;
  /** Label keys to add. */
  labels?: string[];
  /** Label keys to take off. */
  removeLabels?: string[];
  /** The epic it sits under; null for none. */
  parent?: string | null;
  /** The tracker's project, by name; null takes it out. */
  project?: string | null;
}

/** A new ticket from the New ticket dialog. */
export interface NewTicket {
  title: string;
  description?: string;
  status?: TicketState;
  priority?: Priority;
  assignee?: string | null;
  labels?: string[];
  parent?: string;
  /** The tracker's project, by name. */
  project?: string;
}

/** The statuses only a pod sets: never chosen on the Tickets screen. */
export const BUILD_ONLY_STATES: TicketState[] = ['building', 'done'];

/** GET /api/tickets: every project's tickets, or why one isn't there. */
export interface TicketsResponse {
  projects: (
    | { projectId: string; name: string; tickets: TicketListItem[] }
    | { projectId: string; name: string; offline: string }
  )[];
  /** Every project's `group.*` events, for the shipping-together groups. */
  groupEvents: (TimelineEvent & {
    groupId: string | null;
    reason: string | null;
    held: boolean | null;
    projectId: string;
  })[];
}

export type SummaryState =
  | { state: 'ready'; name: string; today: string; after: string }
  | { state: 'writing' }
  | { state: 'none' };

/** GET /api/tickets/<project>/<ticket>: the ticket page. */
export interface TicketPage {
  projectId: string;
  ticket: TicketListItem & { description: string };
  summary: SummaryState;
  /** The planning pod it was planned in, for the link. */
  plannedIn: { podId: string; title: string } | null;
  /** Its latest check-ticket verdict, for "checked" in the journey. */
  verdict: 'COMPLETE' | 'INCOMPLETE' | null;
  /**
   * "Talk about this ticket": what was asked and what the Product manager
   * (or the planning dev) said back, oldest first. Left out by older
   * computers.
   */
  talk?: TicketTalk[];
  /** A shipped ticket's commit and the files it changed. */
  shipped?: ShippedCommit | null;
  /** Added by the mothership: this ticket's events, for "built Nm". */
  events: TimelineEvent[];
}

/** Ticket status → the All tickets group it's listed under. */
export const TICKET_GROUPS = [
  'Building',
  'Shipping together',
  'Ready',
  'Blocked',
  'Planning',
  'Inbox',
  'Shipped',
  'Canceled',
] as const;

export type TicketGroupName = (typeof TICKET_GROUPS)[number];

export const groupOfStatus = (status: TicketState): TicketGroupName => {
  switch (status) {
    case 'building':
      return 'Building';
    case 'ready':
      return 'Ready';
    case 'planning':
      return 'Planning';
    case 'inbox':
      return 'Inbox';
    case 'blocked':
      return 'Blocked';
    case 'done':
      return 'Shipped';
    default:
      return 'Canceled';
  }
};
