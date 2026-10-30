import {
  type Pod,
  type Question,
  type StepEvent,
  type ThreadMessage,
  type Turn,
  isIdle,
  pendingResends,
} from '../../pod-store';
import { chatHold } from '../shared/conversation';

/**
 * The watchdog: keeps a pod from sitting still with nobody noticing.
 *
 * Stalled = active pod, nothing in the inbox, every agent's turn has ended,
 * and the last turn ended STALL_GRACE_MS ago (the manager picks the dev's
 * turn up within seconds, so 90 s is no handoff). It nudges the manager, at
 * most MAX_NUDGES times per stall, NUDGE_GAP_MS apart; only when that fails
 * does the pod go to the owner's inbox — with what was tried.
 *
 * A stall is one "episode" until the pod makes PROGRESS — a non-system
 * message, a reported step, a question, a phase or checkpoint — not merely a
 * turn: a nudge always causes a turn, and a turn that only says "nothing to
 * do" must not reset the count (or it would nudge forever).
 *
 * A message an agent never took in — pasted while it was busy, then lost
 * (a restart, a wedged input box) — is re-sent once, by id, after the agent
 * has sat idle for LOST_MS. If it still isn't taken, it goes to the inbox:
 * otherwise the agent waits on an answer the inbox thinks it already has.
 *
 * Some things a nudge can't fix, so they go to the inbox at once:
 *   - an agent on a permission prompt (it is waiting on a human),
 *   - an agent stopped by the Claude usage limit, and
 *   - an agent mid-turn whose session has written nothing for HANG_MS.
 */

export const STALL_GRACE_MS = 90_000;
export const NUDGE_GAP_MS = 2 * 60_000;
export const MAX_NUDGES = 2;
export const HANG_MS = 15 * 60_000;
export const LOST_MS = 3 * 60_000;

const AGENTS = ['manager', 'dev'] as const;
export type Agent = (typeof AGENTS)[number];

export interface PodSignals {
  pod: Pod;
  running: boolean;
  hasInboxItems: boolean;
  turns: Record<Agent, Turn>;
  thread: ThreadMessage[];
  questions: Question[];
  steps: StepEvent[];
  /** Last write to each agent's session transcript (ms), when known. */
  transcriptAt: Partial<Record<Agent, number>>;
  /** Each agent's visible pane, for permission prompts. */
  screens: Partial<Record<Agent, string>>;
}

export interface Episode {
  /** Progress fingerprint when the stall began. */
  progress: string;
  nudges: number;
  lastNudgeAt?: number;
  /** Lost messages already re-sent once in this episode. */
  resent?: string[];
}

export type Verdict =
  | { kind: 'ok' }
  | { kind: 'waiting' } // stalled, within the grace period or between nudges
  | { kind: 'nudge'; attempt: number }
  | { kind: 'resend'; msgIds: string[] }
  | { kind: 'escalate'; reason: string };

const latest = (values: (string | undefined)[]): string =>
  values.reduce<string>(
    (max, value) => (value !== undefined && value > max ? value : max),
    ''
  );

/** Changes only when the pod actually moves forward. */
export const progressOf = (signals: PodSignals): string =>
  [
    signals.pod.phase,
    signals.pod.completedCheckpoints.join(','),
    signals.questions.length,
    latest(signals.questions.map((q) => q.answeredAt ?? q.createdAt)),
    latest(
      signals.thread
        .filter((message) => message.from !== 'system')
        .map((message) => message.createdAt)
    ),
    latest(
      signals.steps
        .filter((event) => event.by !== 'watchdog')
        .map((event) => event.at)
    ),
  ].join('|');

const PERMISSION =
  /Do you want to (?:proceed|make this edit|create|allow)|❯ 1\. Yes|Allow this|permission to use/i;

const USAGE_LIMIT =
  /Usage limit reached|You've hit your (?:weekly |session )?limit/;

const minutes = (ms: number): number => Math.round(ms / 60_000);

/** What, if anything, a human must do now (no nudge can fix it). */
const blockedOnHuman = (signals: PodSignals, now: number): string | undefined =>
  AGENTS.flatMap((agent): string[] => {
    if (isIdle(signals.turns[agent])) {
      return [];
    }

    const screen = signals.screens[agent] ?? '';

    // Looks mid-turn (no Stop hook fires), but no nudge can help: it goes to
    // the inbox at once.
    if (USAGE_LIMIT.test(screen)) {
      const resets = /resets ([^\n·(]+)/.exec(screen)?.[1]?.trim();

      return [
        `The ${agent} hit the Claude usage limit${
          resets === undefined ? '' : ` (resets ${resets})`
        }. Log in to another account and restart the pod, or wait`,
      ];
    }

    if (PERMISSION.test(screen)) {
      const line =
        screen
          .split('\n')
          .find((candidate) => PERMISSION.test(candidate))
          ?.trim() ?? '';

      return [
        `The ${agent} is waiting for a permission answer in its pane: "${line}"`,
      ];
    }

    const wrote = signals.transcriptAt[agent];

    if (wrote !== undefined && now - wrote > HANG_MS) {
      return [
        `The ${agent} has been mid-turn for ${minutes(
          now - wrote
        )} minutes without writing anything — it looks hung`,
      ];
    }

    return [];
  })[0];

/** Messages an agent has been idle on for LOST_MS without taking in. */
const lostMessages = (signals: PodSignals, now: number) =>
  pendingResends(signals.thread, now).filter((message) => {
    const turn =
      message.target === 'manager' ? signals.turns.manager : signals.turns.dev;
    const idleSince = Date.parse(turn.endedAt ?? '');
    // Not isIdle: that counts a sent-but-never-taken message as the agent
    // being busy — exactly the case this looks for.
    const midTurn = (turn.startedAt ?? '') > (turn.endedAt ?? '');

    return (
      !midTurn &&
      now - Date.parse(message.createdAt) >= LOST_MS &&
      (Number.isNaN(idleSince) || now - idleSince >= LOST_MS)
    );
  });

const describeLost = (message: ThreadMessage): string =>
  `${message.from === 'human' ? 'Your' : 'A'} message to the ${
    message.target ?? 'agent'
  }${message.qid === undefined ? '' : ` (${message.qid})`}`;

const isStalledNow = (signals: PodSignals, now: number): boolean => {
  const { pod } = signals;

  // A freeform pod is a conversation: quiet means it's the owner's turn. A pod
  // held by ⌘⏎ is waiting on its chat, and its items are only hidden.
  if (
    pod.status !== 'active' ||
    pod.mode === 'freeform' ||
    pod.waitingOnHuman !== undefined ||
    signals.hasInboxItems ||
    chatHold(signals.thread, now)
  ) {
    return false;
  }

  if (!signals.running) {
    return true;
  }

  if (!AGENTS.every((agent) => isIdle(signals.turns[agent]))) {
    return false;
  }

  // The grace runs from the last turn's end OR the last message sent to an
  // agent: one that has just been handed something (a work request, a
  // checkpoint closing) is about to start, not stalled.
  const lastActivity = latest(
    AGENTS.flatMap((agent) => [
      signals.turns[agent].endedAt,
      signals.turns[agent].sentAt,
    ])
  );

  return (
    lastActivity === '' || now - Date.parse(lastActivity) >= STALL_GRACE_MS
  );
};

/** One tick for one pod: what to do, and the episode to remember. */
export const judge = (
  signals: PodSignals,
  episode: Episode | undefined,
  now: number
): { verdict: Verdict; episode: Episode | undefined } => {
  if (signals.pod.status !== 'active') {
    return { verdict: { kind: 'ok' }, episode: undefined };
  }

  const human = blockedOnHuman(signals, now);

  if (human !== undefined) {
    return { verdict: { kind: 'escalate', reason: human }, episode };
  }

  if (signals.running) {
    const lost = lostMessages(signals, now);
    const resent = episode?.resent ?? [];
    const fresh = lost.filter((message) => !resent.includes(message.id));

    if (fresh.length > 0) {
      return {
        verdict: { kind: 'resend', msgIds: fresh.map((message) => message.id) },
        episode: {
          progress: episode?.progress ?? progressOf(signals),
          nudges: episode?.nudges ?? 0,
          lastNudgeAt: episode?.lastNudgeAt,
          resent: [...resent, ...fresh.map((message) => message.id)],
        },
      };
    }

    const [stillLost] = lost;

    if (stillLost !== undefined) {
      return {
        verdict: {
          kind: 'escalate',
          reason: `${describeLost(
            stillLost
          )} never reached it, even after re-sending it. Send it again from the thread, or restart the pod`,
        },
        episode,
      };
    }
  }

  const progress = progressOf(signals);

  if (!isStalledNow(signals, now)) {
    // Working (e.g. the turn a nudge caused) is not progress: the episode
    // survives until something actually moves.
    return {
      verdict: { kind: 'ok' },
      episode:
        episode?.progress === progress
          ? episode
          : episode?.resent === undefined
          ? undefined
          : { progress, nudges: 0, resent: episode.resent },
    };
  }

  // Progress since the last nudge: a fresh stall, start counting again.
  const current: Episode =
    episode === undefined || episode.progress !== progress
      ? { progress, nudges: 0, resent: episode?.resent }
      : episode;

  if (
    current.lastNudgeAt !== undefined &&
    now - current.lastNudgeAt < NUDGE_GAP_MS
  ) {
    return { verdict: { kind: 'waiting' }, episode: current };
  }

  if (current.nudges < MAX_NUDGES) {
    const attempt = current.nudges + 1;

    return {
      verdict: { kind: 'nudge', attempt },
      episode: { ...current, nudges: attempt, lastNudgeAt: now },
    };
  }

  return {
    verdict: {
      kind: 'escalate',
      reason: signals.running
        ? `Nothing is running and nothing is waiting on you. I nudged the manager ${MAX_NUDGES} times and it made no progress`
        : 'Its tmux session is gone and resuming it did not bring it back',
    },
    episode: current,
  };
};
