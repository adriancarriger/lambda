import {
  type Pod,
  type PodStore,
  type Question,
  type RenderMachine,
  type ThreadMessage,
  isIdle,
  orderInbox,
  podKindOf,
} from '../../pod-store';
import {
  buildingReplyItems,
  buildingStateOf,
  withAlsoHeld,
} from '../shared/building';
import { chatHold, chatTimes, pendingReply } from '../shared/conversation';
import { awaitingAgent, waitingOnSpawned } from '../shared/items';
import type {
  AppState,
  InboxEntry,
  PodDetail,
  PodStatus,
  PodSummary,
  TimeSummary,
} from '../shared/types';
import { buildWorkflowView } from './workflowView';

/**
 * A question the owner has already answered stays `open` until the dev resolves
 * it — answers are async — so it must not come back to them meanwhile: an item
 * whose latest chat message is THEIRS is hidden until Claude replies (progress
 * notes don't count). Shared with the card, in ../shared/items.
 */
export { awaitingAgent } from '../shared/items';

/** Out of the inbox: Claude owes a reply, or decisions it spawned are still open. */
const stepsAside = (
  question: Question,
  questions: Question[],
  thread: ThreadMessage[]
): boolean =>
  awaitingAgent(question, thread) ||
  waitingOnSpawned(question, questions, thread);

const statusOf = (pod: Pod, needsYou: number, stalled: boolean): PodStatus => {
  if (pod.status === 'done' || pod.status === 'paused') {
    return pod.status;
  }

  if (needsYou > 0) {
    return 'needs-you';
  }

  if (pod.waitingOnHuman !== undefined) {
    return 'waiting-step0';
  }

  return stalled ? 'stalled' : 'working';
};

/**
 * `escalated`: pods the watchdog (./watchdog.ts) could not get moving, with
 * why — they are the only "Stalled" items. A pod that is merely idle is the
 * watchdog's to nudge first, not the owner's.
 */
export const buildState = (
  store: PodStore,
  windowsFor: (podId: string) => string[],
  escalated: ReadonlyMap<string, string> = new Map(),
  now: number = Date.now()
): AppState => {
  const pods = store.listPodIds().map((podId) => store.requirePod(podId));
  const questions = Object.fromEntries(
    pods.map((pod) => [pod.id, store.listQuestions(pod.id)])
  );
  // Read once per build: its Blocked items and its summary both need it.
  const buildings = new Map(
    pods
      .filter((pod) => podKindOf(pod) === 'building' && pod.talk === undefined)
      .map((pod) => [pod.id, store.readBuilding(pod.id)])
  );
  const threads = Object.fromEntries(
    pods.map((pod) => [
      pod.id,
      withAlsoHeld(store.readThread(pod.id), buildings.get(pod.id) ?? null),
    ])
  );
  const { priority } = store.readInbox();
  const active = pods.filter((pod) => pod.status === 'active');
  const rank = (podId: string): number => {
    const index = priority.indexOf(podId);

    return index === -1 ? priority.length : index;
  };
  // A pod running a work request is being reworked: its items step aside
  // until the dev has re-checked them (see lambda pod request).
  const requests = Object.fromEntries(
    pods.map((pod) => [pod.id, store.activeRequest(pod.id)])
  );
  // ⌘⏎ in the Chat panel: the pod waits for the chat's answer out of the way.
  const holding = new Set(
    pods
      .filter((pod) => chatHold(threads[pod.id] ?? [], now))
      .map((pod) => pod.id)
  );
  const reworking = (podId: string): boolean =>
    requests[podId] !== undefined || holding.has(podId);
  const byPriority = [...active].sort(
    (a, b) => rank(a.id) - rank(b.id) || a.createdAt.localeCompare(b.createdAt)
  );

  // 1. "Your turn" — an exchange the owner is already in comes first.
  const replies = byPriority.flatMap((pod): InboxEntry[] => {
    const thread = threads[pod.id] ?? [];

    // A building pod's asks are Blocked items: each its own, in order, until
    // its ticket is back in the queue.
    if (podKindOf(pod) === 'building') {
      return holding.has(pod.id)
        ? []
        : buildingReplyItems(thread, buildings.get(pod.id) ?? null).map(
            (message): InboxEntry => {
              const blockedRun = (buildings.get(pod.id)?.runs ?? []).find(
                (run) => run.blocked?.messageId === message.id
              );
              const ticketId =
                blockedRun?.id ?? message.review?.ticketId ?? undefined;

              return {
                podId: pod.id,
                kind: 'reply',
                key: `${pod.id}/reply/${message.id}`,
                messageId: message.id,
                ...(ticketId === undefined ? {} : { ticketId }),
                ...(blockedRun !== undefined
                  ? { tag: 'blocked' as const }
                  : message.review !== undefined
                  ? { tag: 'review' as const }
                  : {}),
              };
            }
          );
    }

    // The pitch to start structured planning is their turn — the dev's message
    // offering it is not a second item. Starting it answers that message, and
    // so does closing a checkpoint ("Anything else before you close it?" →
    // they closed it).
    const answeredAt = thread
      .filter(
        (message) =>
          message.wire?.startsWith('/pod-structured') === true ||
          message.wire?.startsWith('/checkpoint-complete') === true
      )
      .at(-1)?.createdAt;
    // A freeform chat: whatever its dev said last is their turn — once the
    // turn is over, so a "checking…" note mid-turn doesn't pull them in.
    const asked = pendingReply(
      thread,
      pod.mode === 'freeform' && isIdle(store.readTurn(pod.id, 'dev'))
    );
    const pending =
      pod.structureProposal !== undefined ||
      (asked !== null &&
        answeredAt !== undefined &&
        asked.createdAt < answeredAt)
        ? null
        : asked;
    const request = requests[pod.id];
    // A request hides the pod's items while it reworks them — but not a
    // question the request itself asks them (asked after it started): hiding
    // that would leave the pod waiting on them with nothing in their inbox.
    const reply = holding.has(pod.id)
      ? null
      : request === undefined
      ? pending
      : pending !== null && pending.createdAt > request.createdAt
      ? pending
      : null;

    return reply === null
      ? []
      : [
          {
            podId: pod.id,
            kind: 'reply',
            key: `${pod.id}/reply/${reply.id}`,
            messageId: reply.id,
          },
        ];
  });

  // 2. Decisions and checkpoints.
  const answerable = active
    .filter((pod) => !reworking(pod.id))
    .flatMap((pod) =>
      (questions[pod.id] ?? []).filter(
        (question) =>
          !stepsAside(question, questions[pod.id] ?? [], threads[pod.id] ?? [])
      )
    );
  const questionItems = orderInbox(active, answerable, priority).map(
    ({ pod, question }): InboxEntry => ({
      podId: pod.id,
      kind: question.kind === 'checkpoint' ? 'checkpoint' : 'question',
      key: `${pod.id}/q/${question.id}`,
      qid: question.id,
    })
  );

  // A freeform pod's dev proposes the structured flow: theirs to start.
  const structureItems = byPriority.flatMap((pod): InboxEntry[] =>
    pod.mode === 'freeform' &&
    pod.structureProposal !== undefined &&
    !holding.has(pod.id)
      ? [
          {
            podId: pod.id,
            kind: 'structure',
            key: `${pod.id}/structure/${pod.structureProposal.at}`,
          },
        ]
      : []
  );

  const running = Object.fromEntries(
    pods.map((pod) => [pod.id, windowsFor(pod.id)])
  );
  // 3. Stalled pods — the watchdog tried and could not get them moving.
  const stalledIds = new Set(
    byPriority.filter((pod) => escalated.has(pod.id)).map((pod) => pod.id)
  );
  const stalledItems = byPriority
    .filter((pod) => stalledIds.has(pod.id))
    .map(
      (pod): InboxEntry => ({
        podId: pod.id,
        kind: 'stalled',
        key: `${pod.id}/stalled`,
        reason: escalated.get(pod.id),
      })
    );

  // The sidebar order decides: pod by pod, each pod's "Your turn" before its
  // questions, so a lower pod's "Your turn" never jumps the questions of
  // the pods above it. Stalled nudges come last.
  const inbox = [
    ...byPriority.flatMap((pod) => [
      ...replies.filter((item) => item.podId === pod.id),
      ...questionItems.filter((item) => item.podId === pod.id),
      ...structureItems.filter((item) => item.podId === pod.id),
    ]),
    ...stalledItems,
  ];

  const summaries: PodSummary[] = pods.map((pod) => {
    const windows = running[pod.id] ?? [];
    const chat = chatTimes(threads[pod.id] ?? []);
    const needsYou = inbox.filter(
      (item) => item.podId === pod.id && item.kind !== 'stalled'
    ).length;

    return {
      pod,
      running: windows.length > 0,
      status: statusOf(pod, needsYou, stalledIds.has(pod.id)),
      // Mid-turn, whatever the status says ("Needs you" wins while an item
      // waits — the dev can be working on what they asked all the same).
      devBusy:
        windows.includes('dev') && !isIdle(store.readTurn(pod.id, 'dev')),
      needsYou,
      liveForks: windows.filter((window) => window.startsWith('fork-')),
      request: requests[pod.id],
      chatHold: holding.has(pod.id),
      ...(chat.sentAt === undefined ? {} : { chatSentAt: chat.sentAt }),
      ...(chat.repliedAt === undefined
        ? {}
        : { chatRepliedAt: chat.repliedAt }),
      ...(() => {
        const building = buildings.get(pod.id);

        return building === undefined
          ? {}
          : { building: buildingStateOf(pod, building) };
      })(),
    };
  });

  return { pods: summaries, inbox, questions, priority };
};

export const buildPodDetail = (
  store: PodStore,
  podId: string,
  windows: string[],
  time: TimeSummary,
  machine: RenderMachine
): PodDetail => ({
  pod: store.requirePod(podId),
  questions: store.listQuestions(podId),
  thread: withAlsoHeld(
    store.readThread(podId),
    podKindOf(store.requirePod(podId)) === 'building'
      ? store.readBuilding(podId)
      : null
  ),
  autonomous: store.readAutonomousDecisions(podId),
  human: store.readHumanDecisions(podId),
  forks: store.listForks(podId),
  windows,
  workflow: buildWorkflowView(store, podId, time, machine),
});
