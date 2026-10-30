import * as fs from 'fs';

import {
  type PodStore,
  type ThreadEntry,
  type ThreadSender,
  formatWire,
  isIdle,
  newId,
  nowIso,
  parseMsgId,
} from '../pod-store';
import { askGuardAnswer, productManagerGuardAnswer } from './askGuard';
import {
  agentWindowOf,
  callerAgent,
  callerPodId,
  openStore,
  paneTarget,
  sessionName,
} from './context';
import { ownerForAgent, ownersForAgent } from './owner';
import { capturePane, hasWindow, sendKey, sendToPane, sleep } from './tmux';

/**
 * The outbox: every message INTO an agent is first written to thread.jsonl
 * (pending), then pasted, then marked delivered; the agent's UserPromptSubmit
 * hook marks it received. Anything not received by the next boot is re-sent by
 * `lambda pod resume-all` with the same id, so agents can recognise duplicates.
 */
/** Extra Enters to try when a pasted message sits unsubmitted in the input box. */
const ENTER_RETRIES = 3;
const RECEIVED_WAIT_MS = 2_000;

const received = (store: PodStore, entry: ThreadEntry): boolean =>
  store
    .readThread(entry.podId)
    .some(
      (message) => message.id === entry.id && message.delivery === 'received'
    );

const waitForReceived = async (
  store: PodStore,
  entry: ThreadEntry,
  deadline: number
): Promise<boolean> => {
  if (received(store, entry)) {
    return true;
  }

  if (Date.now() > deadline) {
    return false;
  }

  await sleep(200);

  return waitForReceived(store, entry, deadline);
};

/**
 * Enter can arrive while the TUI is still ingesting a long paste and be
 * swallowed, leaving the message sitting in the input box. The agent's
 * UserPromptSubmit hook marks a message `received` the moment it is taken —
 * so wait for that, and press Enter again if it doesn't come. Extra Enters are
 * harmless: an empty box ignores them, and a busy agent queues the message.
 */
const confirmSubmitted = async (
  store: PodStore,
  entry: ThreadEntry,
  pane: string,
  retries: number
): Promise<void> => {
  if (await waitForReceived(store, entry, Date.now() + RECEIVED_WAIT_MS)) {
    return;
  }

  if (retries === 0) {
    return;
  }

  sendKey(pane, 'Enter');
  await confirmSubmitted(store, entry, pane, retries - 1);
};

/** What the Chat panel is talking about: the item of the owner's latest chat message. */
export const chatTopic = (store: PodStore, podId: string): string | undefined =>
  store
    .readThread(podId)
    .filter((message) => message.chat === true && message.from === 'human')
    .at(-1)?.qid;

const PASTE_RETRIES = 2;

/**
 * Paste, confirm, and — if an IDLE agent never took it (the paste landed
 * while its screen was still loading and was lost) — paste it again. A busy
 * agent queues messages without taking them, so a missing `received` there is
 * expected and never re-pasted (that would duplicate it).
 */
const pasteUntilReceived = async (
  store: PodStore,
  entry: ThreadEntry,
  pane: string,
  wire: string,
  retries: number
): Promise<void> => {
  await sendToPane(pane, wire);
  await confirmSubmitted(store, entry, pane, ENTER_RETRIES);

  const target = entry.target ?? '';
  const taken = received(store, entry);
  const turn = store.readTurn(entry.podId, target);
  const busy = (turn.startedAt ?? '') > (turn.endedAt ?? '');

  if (taken || busy || retries === 0) {
    return;
  }

  await sleep(3000);
  await pasteUntilReceived(store, entry, pane, wire, retries - 1);
};

export const deliverEntry = async (
  store: PodStore,
  entry: ThreadEntry
): Promise<void> => {
  const { wire, target } = entry;

  if (wire === undefined || target === undefined) {
    throw new Error(`Thread entry ${entry.id} has nothing to deliver.`);
  }

  if (
    !hasWindow(sessionName(entry.podId), agentWindowOf(entry.podId, target))
  ) {
    throw new Error(
      `Pod ${entry.podId} has no "${target}" window; message ${entry.id} stays pending until the pod is resumed.`
    );
  }

  const pane = paneTarget(entry.podId, target);
  // Mark the send BEFORE pasting: the agent's turn starts (UserPromptSubmit →
  // startedAt) the moment Enter lands — while we are still confirming — and a
  // sentAt written after it makes `lambda pod await` wait forever on a finished turn.
  store.patchTurn(entry.podId, target, { sentAt: nowIso() });
  await pasteUntilReceived(store, entry, pane, wire, PASTE_RETRIES);
  store.appendDelivery(entry.podId, {
    msgId: entry.id,
    status: 'delivered',
    at: nowIso(),
  });
};

/** Write a message to an agent into the thread and deliver it. */
export const sendMessage = async (
  store: PodStore,
  args: {
    podId: string;
    target: string;
    command: string;
    /** What the owner sees in the thread. */
    text: string;
    /** What the agent receives, when it needs more than the thread text. */
    wireText?: string;
    qid?: string;
    /** The item a chat message is about — context, not an answer on it. */
    about?: string;
    mode: ThreadEntry['mode'];
    from: ThreadSender;
    /** A sidebar-chat message (see fork.ts). */
    chat?: boolean;
    /** ⌘⏎ in the Chat panel: the pod steps aside until the chat replies. */
    hold?: boolean;
  }
): Promise<ThreadEntry> => {
  const msgId = newId('m');
  const entry = store.appendThread({
    id: msgId,
    podId: args.podId,
    qid: args.qid,
    ...(args.about === undefined ? {} : { about: args.about }),
    chat: args.chat,
    ...(args.hold === true ? { hold: true } : {}),
    from: args.from,
    mode: args.mode,
    text: args.text,
    wire: formatWire(
      args.command,
      { qid: args.qid, msgId },
      args.wireText ?? args.text
    ),
    target: args.target,
    createdAt: nowIso(),
  });
  await deliverEntry(store, entry);

  return entry;
};

// Shared with the pod store (Working vs Stalled); re-exported for callers here.
export { isIdle };

/**
 * Block until an agent's turn has ended (Stop hook), counting only turns that
 * started after the last message we sent it. Exits 2 on timeout so a caller on
 * a 10-minute Bash limit can simply call it again.
 */
export const runAwait = async (
  podId: string,
  agent: string,
  timeoutSec: number
): Promise<void> => {
  const store = openStore();
  const deadline = Date.now() + timeoutSec * 1000;

  const poll = async (): Promise<boolean> => {
    if (isIdle(store.readTurn(podId, agent))) {
      return true;
    }

    if (Date.now() > deadline) {
      return false;
    }

    await sleep(1000);

    return poll();
  };

  if (await poll()) {
    console.log(`${agent} in pod ${podId} is idle (turn ended).`);

    return;
  }

  console.log(
    `${agent} in pod ${podId} is still working after ${timeoutSec}s. Call \`lambda pod await ${podId} ${agent}\` again.`
  );
  process.exitCode = 2;
};

export const runSend = async (
  podId: string,
  agent: string,
  text: string
): Promise<void> => {
  const store = openStore();
  const from = callerAgent() === 'manager' ? 'manager' : 'system';
  const msgId = newId('m');

  // A slash command must stay first on the line or the agent's TUI treats it
  // as plain text ("[m:…]: /pod-phase 1" never runs), so the id marker goes
  // AFTER its arguments: "/pod-phase 1 [m:…]".
  const wire = text.startsWith('/')
    ? `${text} [m:${msgId}]`
    : formatWire('', { msgId }, text);
  const entry = store.appendThread({
    id: msgId,
    podId,
    from,
    mode: 'note',
    text,
    wire,
    target: agent,
    createdAt: nowIso(),
  });
  await deliverEntry(store, entry);
  console.log(`Sent ${entry.id} to ${agent} in pod ${podId}.`);
};

export const runCapture = (
  podId: string,
  agent: string,
  lines: number
): void => {
  process.stdout.write(capturePane(paneTarget(podId, agent), lines));
};

const senderFor = (agent: string): ThreadSender => {
  if (
    agent === 'manager' ||
    agent === 'dev' ||
    agent === 'engineering-manager' ||
    agent === 'qa' ||
    agent === 'product-manager'
  ) {
    return agent;
  }

  // A one-shot Product manager (Talk about this ticket) speaks as one.
  if (agent.startsWith('pm-')) {
    return 'product-manager';
  }

  if (agent.startsWith('fork-')) {
    return 'fork';
  }

  throw new Error(`Unknown agent "${agent}".`);
};

/**
 * An agent writes to the owner. Forks' replies are spoken by the app as they land.
 *
 * The dev and manager must say which kind of message it is: `--ask` puts it in
 * the owner's inbox as "Your turn"; `--fyi` (acknowledgements, status) only goes
 * in the thread. Forced, because a pod must surface only when it truly needs
 * the owner — an "Understood, carrying on" must never pull them back in.
 */
const squash = (value: string): string => value.replace(/\s+/g, ' ').trim();

/**
 * `--parts-file`: [{"quote": "<verbatim part of the owner's message>", "answer": "…"}]
 * — the reply to a message with several parts, one pair per part.
 */
const readParts = (
  store: ReturnType<typeof openStore>,
  podId: string,
  replyTo: string | undefined,
  file: string
): { replyTo: string; parts: { quote: string; answer: string }[] } => {
  const message = store
    .readThread(podId)
    .find((entry) => entry.id === replyTo && entry.from === 'human');

  const owners = ownersForAgent();

  if (replyTo === undefined || message === undefined) {
    throw new Error(
      `--parts-file needs --reply-to <m-id>: the [m:…] id of ${owners} message you are answering.`
    );
  }

  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  const parts = Array.isArray(raw)
    ? raw.flatMap((item: unknown) =>
        typeof item === 'object' &&
        item !== null &&
        'quote' in item &&
        typeof item.quote === 'string' &&
        'answer' in item &&
        typeof item.answer === 'string'
          ? [{ quote: squash(item.quote), answer: item.answer.trim() }]
          : []
      )
    : [];

  if (parts.length < 2) {
    throw new Error(
      `--parts-file must be a JSON list of at least 2 {"quote", "answer"} — one per part of ${owners} message (a one-part message needs no parts).`
    );
  }

  const full = squash(message.text);
  const missing = parts.filter((part) => !full.includes(part.quote));

  if (missing.length > 0) {
    throw new Error(
      `Each "quote" must be ${owners} words exactly (spacing aside). Not found in ${owners} message: ${missing
        .map((part) => `"${part.quote.slice(0, 60)}"`)
        .join(', ')}`
    );
  }

  if (parts.some((part) => part.answer === '')) {
    throw new Error('Every part needs an "answer".');
  }

  return { replyTo, parts };
};

export const runReply = (
  textArgs: string,
  options: {
    qid?: string;
    ask?: boolean;
    fyi?: boolean;
    progress?: boolean;
    replyTo?: string;
    partsFile?: string;
    /** A ticket ready for the owner's review: the Review rail's item. */
    review?: string;
  }
): void => {
  const podId = callerPodId();
  const agent = callerAgent();

  if (podId === undefined || agent === undefined) {
    throw new Error(
      '`lambda pod reply` is for pod agents (POD_ID / POD_AGENT unset).'
    );
  }

  const from = senderFor(agent);
  const split =
    options.partsFile === undefined
      ? undefined
      : readParts(openStore(), podId, options.replyTo, options.partsFile);
  // A split reply's text is its answers in order (older readers, search).
  const text =
    split === undefined
      ? textArgs
      : split.parts
          .map((part, index) => `${index + 1}: ${part.answer}`)
          .join('\n');

  if (text.trim() === '') {
    throw new Error('Give the reply text (or --parts-file).');
  }

  if (options.progress === true) {
    if (options.qid === undefined || options.ask === true) {
      throw new Error(
        '--progress is a note on an item while you work: it needs --qid, and is never an --ask.'
      );
    }
  } else if (from !== 'fork' && options.ask === options.fyi) {
    throw new Error(
      `Say what kind of message this is: --ask if ${ownerForAgent()} needs to answer it (it goes to ${ownersForAgent()} inbox), --fyi if not (acknowledgements and status stay in the thread).`
    );
  }

  if (options.review !== undefined && options.ask !== true) {
    throw new Error(
      "--review asks for the owner's review: pass it with --ask."
    );
  }

  const store = openStore();
  const entry = store.appendThread({
    id: newId('m'),
    podId,
    // A question's fork is about its own question. The chat fork's reply is
    // about what it's answering — the latest thing the owner said in the chat —
    // unless it says otherwise (--qid).
    qid:
      options.qid ??
      (from !== 'fork'
        ? undefined
        : agent === 'fork-chat'
        ? chatTopic(openStore(), podId)
        : agent.slice('fork-'.length)),
    chat: agent === 'fork-chat' ? true : undefined,
    from,
    mode: from === 'fork' ? 'sync' : 'note',
    text,
    expectsReply: from === 'fork' ? undefined : options.ask === true,
    progress: options.progress === true ? true : undefined,
    replyTo: split?.replyTo,
    parts: split?.parts,
    review:
      options.review === undefined ? undefined : { ticketId: options.review },
    createdAt: nowIso(),
  });

  if (from === 'fork') {
    const fork = store.readFork(podId, agent.slice('fork-'.length));

    if (fork !== null) {
      store.writeFork({ ...fork, lastActivityAt: nowIso() });
    }
  }

  // A Product manager that replies is busy, not idle (it sleeps after 30
  // quiet minutes).
  if (from === 'product-manager' && store.readPod(podId)?.kind === 'building') {
    store.updateBuilding(podId, (state) => ({
      ...state,
      productManager: { awake: true, lastActivityAt: entry.createdAt },
    }));
  }

  console.log(`Posted ${entry.id} to ${ownerForAgent()}.`);
};

/** Re-deliver one pending message (same id). */
export const runDeliver = async (
  podId: string,
  msgId: string
): Promise<void> => {
  const store = openStore();
  const entry = store.readThread(podId).find((message) => message.id === msgId);

  if (entry === undefined) {
    throw new Error(`No message ${msgId} in pod ${podId}.`);
  }

  await deliverEntry(store, entry);
  console.log(`Delivered ${msgId}.`);
};

const readStdin = (): string => {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
};

/**
 * Agent hooks (wired in the pod's settings.json). They must never break the
 * agent's turn, so every failure is swallowed — a missed mark only means a
 * message is re-sent at the next resume, which agents de-duplicate by id.
 */
export const runHook = (event: string, rawInput?: string): void => {
  // An ask fork's and the Product manager's guards answer every tool call,
  // and are never swallowed. A failure here does NOT block the tool (Claude
  // Code blocks only on exit code 2): their settings' deny lists are the floor.
  if (event === 'ask-guard') {
    process.stdout.write(askGuardAnswer(rawInput ?? readStdin()));

    return;
  }

  if (event === 'pm-guard') {
    process.stdout.write(productManagerGuardAnswer(rawInput ?? readStdin()));

    return;
  }

  try {
    const podId = callerPodId();
    const agent = callerAgent();

    if (podId === undefined || agent === undefined) {
      return;
    }

    const store = openStore();
    const raw = rawInput ?? readStdin();
    const input: unknown = raw.trim() === '' ? {} : JSON.parse(raw);
    const transcriptPath =
      typeof input === 'object' &&
      input !== null &&
      'transcript_path' in input &&
      typeof input.transcript_path === 'string'
        ? input.transcript_path
        : undefined;

    if (transcriptPath !== undefined) {
      store.patchTurn(podId, agent, { transcriptPath });
    }

    if (event === 'prompt-submit') {
      store.patchTurn(podId, agent, { startedAt: nowIso() });
      const prompt =
        typeof input === 'object' && input !== null && 'prompt' in input
          ? String(input.prompt)
          : '';
      const msgId = parseMsgId(prompt);

      if (msgId !== null) {
        store.appendDelivery(podId, {
          msgId,
          status: 'received',
          at: nowIso(),
        });
      }

      return;
    }

    if (event === 'stop') {
      store.patchTurn(podId, agent, { endedAt: nowIso() });

      if (agent.startsWith('fork-')) {
        const fork = store.readFork(podId, agent.slice('fork-'.length));

        if (fork !== null && fork.state === 'warming') {
          store.writeFork({
            ...fork,
            state: 'active',
            lastActivityAt: nowIso(),
          });
        }
      }
    }
  } catch {
    // Hooks never fail the agent's turn.
  }
};
