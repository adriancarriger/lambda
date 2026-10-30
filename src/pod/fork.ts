import {
  type Fork,
  buildChatHandoff,
  buildResolution,
  newId,
  nowIso,
  sessionOf,
} from '../pod-store';
import {
  callerAgent,
  callerPodId,
  openStore,
  paneTarget,
  sessionName,
} from './context';
import { launchAgent } from './launch';
import { deliverEntry, sendMessage } from './messaging';
import { ownerName } from './owner';
import { hasWindow, killWindow, sleep } from './tmux';

/**
 * Conversation mode. Cmd+Enter talks to a FORK of the dev
 * (`claude --resume <dev> --fork-session`) so the dev keeps working and only
 * ever receives the conclusion. Forks are read-only (fork-settings.json) and
 * never resumed after a reboot — a fork that disappears without resolving goes
 * through `recover`, which hands the dev what was recorded, marked UNCONFIRMED.
 */

export const forkWindow = (qid: string): string => `fork-${qid}`;

const LIVE_STATES: Fork['state'][] = ['warming', 'active', 'parked', 'closing'];

const isLive = (fork: Fork | null): fork is Fork =>
  fork !== null &&
  LIVE_STATES.includes(fork.state) &&
  hasWindow(sessionName(fork.podId), fork.window);

/** Spawn (or reuse) the fork for a question and warm it with /human-standby. */
export const runForkStart = async (
  podId: string,
  qid: string
): Promise<void> => {
  const store = openStore();
  const existing = store.readFork(podId, qid);

  if (isLive(existing)) {
    console.log(`Fork for ${qid} already running (${existing.state}).`);

    return;
  }

  const pod = store.requirePod(podId);
  const window = forkWindow(qid);
  store.writeFork({
    qid,
    podId,
    window,
    state: 'warming',
    startedAt: nowIso(),
    lastActivityAt: nowIso(),
  });

  // cwd MUST be the dev's: --resume finds sessions under the launch directory.
  await launchAgent({
    pod,
    store,
    agent: window,
    cwd: pod.devCwd,
    mode: { kind: 'fork', fromSessionId: sessionOf(pod, 'dev') },
  });

  const msgId = newId('m');
  const entry = store.appendThread({
    id: msgId,
    podId,
    qid,
    from: 'system',
    mode: 'note',
    text: '(warm-up)',
    wire:
      qid === CHAT_QID
        ? `/human-standby chat [m:${msgId}]`
        : `/human-standby ${qid} [m:${msgId}]`,
    target: window,
    createdAt: nowIso(),
  });
  await deliverEntry(store, entry);
  console.log(`Fork ${window} warming.`);
};

export const runForkSend = async (
  podId: string,
  qid: string,
  text: string
): Promise<void> => {
  const store = openStore();

  if (!isLive(store.readFork(podId, qid))) {
    await runForkStart(podId, qid);
  }

  const fork = store.readFork(podId, qid);

  if (fork === null) {
    throw new Error(`Fork for ${qid} could not be started.`);
  }

  store.writeFork({ ...fork, state: 'active', lastActivityAt: nowIso() });
  const entry = await sendMessage(store, {
    podId,
    target: fork.window,
    command: '/human',
    qid,
    text,
    mode: 'sync',
    from: 'human',
  });
  console.log(`Sent ${entry.id} to ${fork.window}.`);
};

/** Enter inside a conversation: the last message (if any) plus "close". */
export const runForkClose = async (
  podId: string,
  qid: string,
  text: string | undefined
): Promise<void> => {
  const store = openStore();
  const fork = store.readFork(podId, qid);

  if (!isLive(fork)) {
    console.log(`No live fork for ${qid}; nothing to close.`);

    return;
  }

  store.writeFork({ ...fork, state: 'closing', lastActivityAt: nowIso() });
  await sendMessage(store, {
    podId,
    target: fork.window,
    command: '/human-close',
    qid,
    text: text ?? '',
    mode: 'sync',
    from: 'human',
  });
  console.log(`Closing ${fork.window}.`);
};

export const runForkPark = (podId: string, qid: string): void => {
  const store = openStore();
  const fork = store.readFork(podId, qid);

  if (fork !== null) {
    store.writeFork({ ...fork, state: 'parked', lastActivityAt: nowIso() });
  }

  console.log(`Parked ${qid}.`);
};

/** Typed a key (fork warmed) but then answered with plain Enter: throw it away. */
export const runForkDiscard = (podId: string, qid: string): void => {
  const store = openStore();
  const fork = store.readFork(podId, qid);

  if (fork === null) {
    return;
  }

  killWindow(paneTarget(podId, fork.window));
  store.writeFork({ ...fork, state: 'resolved', resolvedAt: nowIso() });
  console.log(`Discarded warm fork for ${qid}.`);
};

const conversationFor = (podId: string, qid: string) =>
  openStore()
    .readThread(podId)
    .filter(
      (message) =>
        message.qid === qid &&
        (message.from === 'human' || message.from === 'fork') &&
        message.mode === 'sync'
    );

/** Build /human-resolved from the files and send it to the dev. */
const sendResolution = async (
  podId: string,
  qid: string,
  unconfirmed: boolean
): Promise<void> => {
  const store = openStore();
  const decisions = store
    .readHumanDecisions(podId)
    .filter((decision) => decision.qid === qid);
  const conversation = conversationFor(podId, qid);
  const fork = store.readFork(podId, qid);

  // A fork that never had a conversation (warmed, then thrown away) has
  // nothing to hand over — an empty "UNCONFIRMED" resolution only confuses
  // the dev. Just retire it.
  const since = fork?.startedAt ?? '';
  const talked = conversation.some(
    (message) => message.from === 'human' && message.createdAt >= since
  );

  if (!talked) {
    if (fork !== null) {
      store.writeFork({ ...fork, state: 'dead', resolvedAt: nowIso() });
    }

    return;
  }

  const msgId = newId('m');
  const wire = buildResolution({
    qid,
    msgId,
    unconfirmed,
    decisions,
    conversation,
    ownerName: ownerName(),
  });
  const entry = store.appendThread({
    id: msgId,
    podId,
    qid,
    from: 'system',
    mode: 'note',
    text: unconfirmed
      ? `Conversation on ${qid} ended without resolving — sent the dev what was recorded (UNCONFIRMED).`
      : `Conversation on ${qid} resolved — sent the dev the decisions and transcript.`,
    wire,
    target: 'dev',
    createdAt: nowIso(),
  });
  await deliverEntry(store, entry);

  if (fork !== null) {
    store.writeFork({
      ...fork,
      state: unconfirmed ? 'dead' : 'resolved',
      resolvedAt: nowIso(),
    });
  }
};

/** Called BY the fork as its last action. */
export const runResolveConversation = async (
  qidArg: string | undefined,
  podArg: string | undefined
): Promise<void> => {
  const agent = callerAgent();
  const podId = podArg ?? callerPodId();
  const qid =
    qidArg ??
    (agent?.startsWith('fork-') === true
      ? agent.slice('fork-'.length)
      : undefined);

  if (podId === undefined || qid === undefined) {
    throw new Error(
      'resolve-conversation needs a pod and question (run it from the fork).'
    );
  }

  await sendResolution(podId, qid, false);
  console.log(
    `Resolved conversation on ${qid}; the dev has the decisions. You can stop now.`
  );
};

/** The fork vanished without resolving (crash, kill, reboot). */
export const runForkRecover = async (
  podId: string,
  qid: string
): Promise<void> => {
  await sendResolution(podId, qid, true);
  console.log(
    `Recovered ${qid}: sent the dev the recorded decisions, marked UNCONFIRMED.`
  );
};

// ── the sidebar chat ────────────────────────────────────────────────────────

/**
 * The app's Chat panel talks to ONE fork per pod (`fork-chat`, fork record
 * `qid: chat`): the dev's whole context, answering in seconds while the dev
 * keeps working, read-only. Each message is about the item on screen (its
 * qid) or the whole pod. Nothing ends the chat: what was said reaches the dev
 * the next time the owner answers an item in the center (`runChatHandoff`).
 */
export const CHAT_QID = 'chat';

/** Warm the pod's chat fork (the panel was opened). */
export const runChatWarm = async (podId: string): Promise<void> =>
  runForkStart(podId, CHAT_QID);

export const runChatSend = async (
  podId: string,
  about: string | undefined,
  text: string,
  hold = false
): Promise<void> => {
  const store = openStore();

  if (!isLive(store.readFork(podId, CHAT_QID))) {
    await runForkStart(podId, CHAT_QID);
  }

  // A fork still warming hasn't read /human-standby yet — which is what tells
  // it it's the Chat panel. A message pasted before then is answered by a
  // fork that thinks it's the dev. Wait for the warm-up turn.
  await waitUntilWarm(podId, CHAT_QID);
  const fork = store.readFork(podId, CHAT_QID);

  if (fork === null) {
    throw new Error('The chat could not be started.');
  }

  store.writeFork({ ...fork, state: 'active', lastActivityAt: nowIso() });
  const entry = await sendMessage(store, {
    podId,
    target: fork.window,
    command: '/human',
    qid: about,
    text,
    mode: 'sync',
    from: 'human',
    chat: true,
    hold,
  });
  console.log(`Sent ${entry.id} to the chat.`);
};

const WARM_WAIT_MS = 90_000;

/**
 * Until the fork's warm-up turn has ended (the Stop hook moves it from
 * `warming` to `active`). Gives up after WARM_WAIT_MS and sends anyway.
 */
const waitUntilWarm = async (
  podId: string,
  qid: string,
  deadline: number = Date.now() + WARM_WAIT_MS
): Promise<void> => {
  if (openStore().readFork(podId, qid)?.state !== 'warming') {
    return;
  }

  if (Date.now() > deadline) {
    console.log('The chat is still warming up; sending anyway.');

    return;
  }

  await sleep(500);
  await waitUntilWarm(podId, qid, deadline);
};

/** The chat's talk the dev hasn't been given yet. */
const pendingChat = (podId: string) => {
  const store = openStore();
  const thread = store.readThread(podId);
  // The last hand-off: the fork's record, or the note it left in the thread.
  // The record alone forgot it whenever the fork was re-created, and every
  // later hand-off re-sent the whole chat.
  const noted =
    thread
      .filter(
        (message) =>
          message.from === 'system' &&
          message.text.startsWith('Sent the dev what you said in the chat')
      )
      .at(-1)?.createdAt ?? '';
  const recorded = store.readFork(podId, CHAT_QID)?.handedOffAt ?? '';
  const since = noted > recorded ? noted : recorded;

  return thread.filter(
    (message) => message.chat === true && message.createdAt > since
  );
};

/**
 * Give the dev everything said in the chat since the last hand-off — called
 * when the owner answers an item in the center (before that answer, so the dev
 * reads them in order), or closes a checkpoint, and when the pod finishes.
 */
export const runChatHandoff = async (podId: string): Promise<void> => {
  const store = openStore();
  const messages = pendingChat(podId);

  if (messages.length === 0) {
    return;
  }

  const fork = store.readFork(podId, CHAT_QID);
  const since = fork?.handedOffAt ?? '';
  const questions = store.listQuestions(podId);
  const msgId = newId('m');
  const wire = buildChatHandoff({
    msgId,
    messages,
    decisions: store
      .readHumanDecisions(podId)
      .filter((decision) => decision.createdAt > since),
    topicLabel: (qid) => {
      const question = questions.find((candidate) => candidate.id === qid);

      if (question === undefined) {
        return 'the whole pod';
      }

      return question.kind === 'checkpoint' && question.checkpoint !== undefined
        ? `${question.id} (Checkpoint ${question.checkpoint.cp})`
        : `${question.id}: ${question.summary ?? ''}`;
    },
    ownerName: ownerName(),
  });
  const now = nowIso();
  const entry = store.appendThread({
    id: msgId,
    podId,
    from: 'system',
    mode: 'note',
    text: `Sent the dev what you said in the chat (${messages.length} messages).`,
    wire,
    target: 'dev',
    createdAt: now,
  });

  if (fork !== null) {
    store.writeFork({ ...fork, handedOffAt: now });
  }

  await deliverEntry(store, entry);
  console.log(`Handed the chat to the dev (${messages.length} messages).`);
};

const PARK_IDLE_MS = 10 * 60_000;
const CLOSING_TIMEOUT_MS = 5 * 60_000;
/** A chat fork with nothing pending is re-forked once quiet this long. */
const CHAT_REFRESH_IDLE_MS = 60_000;

/**
 * Run every ~30s (`lambda pod fork watchdog`). Recovers dead forks, closes
 * idle ones, and kills the windows of resolved ones.
 */
export const runForkWatchdog = async (): Promise<void> => {
  const store = openStore();
  const now = Date.now();
  const forks = store.listPodIds().flatMap((podId) => store.listForks(podId));

  await forks.reduce(async (previous, fork) => {
    await previous;
    const alive = hasWindow(sessionName(fork.podId), fork.window);
    const idleMs = now - Date.parse(fork.lastActivityAt);

    // The chat fork never "closes": its talk is handed off in the center.
    // Once everything is handed off and the dev has moved on since it was
    // forked, retire it — the next message re-forks from the dev's latest
    // context, so the chat never answers from a stale copy.
    if (fork.qid === CHAT_QID) {
      const devEnded = store.readTurn(fork.podId, 'dev').endedAt ?? '';

      if (
        alive &&
        pendingChat(fork.podId).length === 0 &&
        devEnded > fork.startedAt &&
        idleMs > CHAT_REFRESH_IDLE_MS
      ) {
        killWindow(paneTarget(fork.podId, fork.window));
        store.writeFork({ ...fork, state: 'resolved', resolvedAt: nowIso() });
      }

      return;
    }

    if (fork.state === 'resolved' || fork.state === 'dead') {
      if (alive) {
        killWindow(paneTarget(fork.podId, fork.window));
      }

      return;
    }

    if (!alive) {
      await runForkRecover(fork.podId, fork.qid);

      return;
    }

    if (fork.state === 'closing' && idleMs > CLOSING_TIMEOUT_MS) {
      killWindow(paneTarget(fork.podId, fork.window));
      await runForkRecover(fork.podId, fork.qid);

      return;
    }

    if (
      (fork.state === 'parked' || fork.state === 'active') &&
      idleMs > PARK_IDLE_MS
    ) {
      await runForkClose(fork.podId, fork.qid, undefined);
    }
  }, Promise.resolve());
};
