import type {
  AutonomousDecision,
  Fork,
  HumanDecision,
  Pod,
  Question,
  RenderMode,
  StageStatus,
  StepHistory,
  ThreadMessage,
  WorkRequest,
  WorkflowStage,
} from '../../pod-store';
import type { BuildingSummary } from './building';

/**
 * Every pod is either NEEDS YOU (something in the inbox) or WORKING (an agent
 * turn in progress, or idle while the watchdog nudges it). STALLED is what the
 * watchdog could not get moving — itself surfaced to the inbox.
 */
export type PodStatus =
  | 'needs-you'
  | 'working'
  | 'stalled'
  | 'waiting-step0'
  | 'paused'
  | 'done';

/** What GET /api/state returns. Type-only imports: the client never bundles the store. */
export interface PodSummary {
  pod: Pod;
  running: boolean;
  status: PodStatus;
  /** Inbox items for this pod. */
  needsYou: number;
  liveForks: string[];
  /**
   * The dev is mid-turn (its turn state, not `status` — a pod with an item
   * waiting reads "Needs you" even while its dev works). Absent from an
   * older server.
   */
  devBusy?: boolean;
  /** A work request queued or running: the pod's items step aside meanwhile. */
  request?: WorkRequest;
  /** ⌘⏎ in the Chat panel: its items step aside until the chat replies. */
  chatHold: boolean;
  /** Their latest Chat-panel message, and the chat's latest answer (ISO). */
  chatSentAt?: string;
  chatRepliedAt?: string;
  /** A building pod (`pod.kind === 'building'`): the sidebar's Building row. */
  building?: BuildingSummary;
}

/**
 * - reply: the dev/manager said something to the owner in conversation and they haven't answered ("Your turn")
 * - question / checkpoint: an open question or checkpoint item
 * - stalled: nobody is working and nothing waits on the owner
 */
export type InboxKind =
  | 'reply'
  | 'question'
  | 'checkpoint'
  | 'stalled'
  /** A freeform pod's dev proposes the structured flow (Pod.structureProposal). */
  | 'structure';

/**
 * One section's ElevenLabs clip. `none` = not rendered or requested yet (it is
 * rendered the moment the player needs it); `pending` = settling or rendering;
 * `unavailable` = no key, over budget, or failed — that section has no audio
 * (the player says so; there is no browser-voice fallback).
 */
export type ClipStatus =
  | { status: 'ready'; url: string; duration: number }
  | { status: 'pending' }
  | { status: 'none' }
  | { status: 'unavailable'; reason: string };

/** An item's audio: one clip per spoken section, by section key. */
export interface AudioMeta {
  clips: Record<string, ClipStatus>;
}

export interface InboxEntry {
  podId: string;
  kind: InboxKind;
  /** Stable identity: changes when the item meaningfully changes (e.g. a newer reply). */
  key: string;
  qid?: string;
  messageId?: string;
  /** Stalled items: what the watchdog tried, or what a human must do. */
  reason?: string;
  audio?: AudioMeta;
  /**
   * A building pod's item: which ticket, and whether it's a build blocker
   * (a computer waits on it: always first in Auto) or a review.
   */
  ticketId?: string;
  tag?: 'blocked' | 'review';
}

export interface TtsStatus {
  /** The audio queue, for the sidebar line. */
  queue: {
    /** The section rendering now, when it is an inbox item's. */
    current?: { podId: string; label: string };
    queued: number;
    /** How many pods the queued clips belong to. */
    pods: number;
  };
  enabled: boolean;
  overBudget: boolean;
  usd: number;
  capUsd: number;
  /**
   * Rendered on this machine (Kokoro): roughly how many characters it renders
   * per second, so the player waits that long instead of switching voices.
   * Null for ElevenLabs (about a second whatever the length).
   */
  renderCharsPerSecond: number | null;
}

/** Active planning time (see server/timeLog.ts), as of the last report. */
export interface TimeSummary {
  day: string;
  todayMs: number;
  /** Every day with active time, "YYYY-MM-DD" → ms. */
  days: Record<string, number>;
  pods: Record<string, PodTime>;
}

export interface PodTime {
  totalMs: number;
  /** Per item (qid). */
  items: Record<string, number>;
  /** Per version of a card: qid → version → ms (only while the Plan rail showed it). */
  versions?: Record<string, Record<string, number>>;
  /**
   * Per card inside a checkpoint (a screen, a proposed ticket — see
   * cardHistory.ts): qid → card key → checkpoint version → ms.
   */
  cards?: Record<string, Record<string, Record<string, number>>>;
}

export interface AppState {
  pods: PodSummary[];
  /** Everything waiting on the owner, in the order they should see it. */
  inbox: InboxEntry[];
  questions: Record<string, Question[]>;
  priority: string[];
  tts?: TtsStatus;
  time?: TimeSummary;
  /** The mothership's own: who you are, your projects, pods waiting for a computer. */
  lambda?: LambdaInfo;
}

export interface ProjectInfo {
  id: string;
  name: string;
  /** `lambda.json` `tickets.prefix`; null hides the ticket shortcut. */
  ticketPrefix: string | null;
}

/** A pod asked for while its project's computer is busy on another project. */
export interface WaitingPod {
  id: string;
  projectId: string;
  /** What was typed, shortened: the sidebar row's name. */
  title: string;
  /** "Waiting: Leslie's MacBook is busy on Pawnee Parks site". */
  label: string;
  createdAt: string;
  /** Its last start failed: why, and when Lambda tries again (ISO). */
  failure?: { error: string; retryAt: string };
}

export interface LambdaInfo {
  owner: { name: string; initials: string };
  projects: ProjectInfo[];
  /** Where a new idea goes unless the menu changes it. */
  lastProjectId: string | null;
  /** Pod id → its project id. */
  podProjects: Record<string, string>;
  /** Pod id → the name of the computer it runs on. */
  podComputers?: Record<string, string>;
  waiting: WaitingPod[];
  /** Every computer: who a ticket can be assigned to, and who is offline. */
  computers?: ComputerInfo[];
}

export interface ComputerInfo {
  name: string;
  connected: boolean;
  /** Epoch ms. */
  lastSeenAt: number;
  /** The projects it has, by id. */
  projectIds: string[];
  /**
   * The trackers it knows its own user in ("linear", "jira"): it can be
   * assigned a ticket there. Left out by an older Lambda.
   */
  trackers?: string[];
}

/**
 * A tmux window the Agents panel can show besides the pod's own agents, by
 * its tmux id (`@12`): the project's session (its servers, a scratch shell)
 * or Lambda's own (the mothership and the runner). Read-only.
 */
export interface OtherWindow {
  id: string;
  name: string;
  group: 'project' | 'lambda';
  /** Takes typing: only the project's scratchPad. */
  typable: boolean;
}

/** What GET /api/panes/:podId returns. */
export interface Panes {
  others: OtherWindow[];
  /** The pod's agent windows mid-turn. */
  working: string[];
}

/** What GET /api/pod/:id returns. */
export interface PodDetail {
  pod: Pod;
  questions: Question[];
  thread: ThreadMessage[];
  autonomous: AutonomousDecision[];
  human: HumanDecision[];
  forks: Fork[];
  windows: string[];
  /** The sidebar's workflow panel (server/workflowView.ts). */
  workflow: WorkflowView;
}

export interface AgentState {
  working: boolean;
  /** When the current turn started, or the last one ended. */
  since?: string;
}

/** One stage of the workflow panel: the definition plus where this pod is. */
export interface WorkflowStageView {
  stage: WorkflowStage;
  status: StageStatus;
  /** The owner's active time on this stage's items (ms). */
  yourMs: number;
  /** Across all pods: their average time on this stage (checkpoints). */
  avgYourMs?: number;
}

export interface WorkflowView {
  stages: WorkflowStageView[];
  history: Record<string, StepHistory>;
  agents: { manager: AgentState; dev: AgentState };
  /** The watchdog's latest notes, newest last. */
  watchdog: { at: string; note: string }[];
  /** Work requests, oldest first. */
  requests: WorkRequest[];
  /** A conversation, no stages yet: the panel offers "Switch to structured". */
  freeform: boolean;
  /** How the UX review is drawn: the header's Render Full | ASCII switch. */
  renderMode: RenderMode;
  /**
   * Whether the pod's runner reports Claude Design available. `false`
   * greys out Full; absent means the runner hasn't checked yet.
   */
  designAvailable?: boolean;
  /** Stages whose Skip asks the owner to confirm (they write to the tickets). */
  confirmSkip: string[];
  /** Batch pods: where each ticket is, stage by stage (from `--ticket` steps). */
  tickets?: TicketRow[];
}

export type TicketCell = 'done' | 'now' | 'todo';

export interface TicketRow {
  id: string;
  /** Stage id → this ticket's state in it. */
  cells: Record<string, TicketCell>;
}

/**
 * Really working. A freeform chat between turns is waiting on the owner, not
 * working: its status still reads WORKING (nothing is in their inbox), so only
 * its dev's turn counts. An older server that doesn't say goes by status.
 */
export const isWorking = (summary: PodSummary): boolean =>
  summary.status === 'working' &&
  (summary.pod.mode !== 'freeform' || summary.devBusy !== false);
