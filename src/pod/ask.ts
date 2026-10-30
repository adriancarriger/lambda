import { randomBytes } from 'crypto';
import * as fs from 'fs';

import { type AskThread, type PodStore, nowIso, sessionOf } from '../pod-store';
import { podKindOf } from '../pod-store/schemas';
import { callerPodId, openStore, resolvePodId, sessionName } from './context';
import { launchAgent } from './launch';
import { hasWindow, killWindow, sendToPane, sleep } from './tmux';

/**
 * `lambda pod ask <engineering-manager|dev> "<q>" [--thread <id>]`: the
 * Product manager asks a read-only fork of one of them and gets its answer.
 * The fork (`claude --resume <session> --fork-session`) runs in its own
 * window with an allow list of read-only tools and no auto mode, so it can't
 * ship, write or message anyone; the real agent never sees the question.
 * The same `--thread` asks the same fork again. `--close <id>`, or 15 idle
 * minutes, spin it down. Asks on different threads run side by side.
 *
 * The caller's Bash call ends at 2 minutes, so the conversation id prints
 * before the wait, and the wait stops at ASK_WAIT_MS with exit 2: the caller
 * then runs `--thread <id> --wait`, which waits again without asking again.
 */

/** Put before every question the fork is sent. */
export const ASK_PREFIX = 'The Product manager asks:';

export const ASK_TARGETS = ['engineering-manager', 'dev'] as const;

type AskTarget = (typeof ASK_TARGETS)[number];

export const ASK_IDLE_MS = 15 * 60_000;

/** How long an answer may take, over every `--wait`. */
const ANSWER_TIMEOUT_MS = 10 * 60_000;

/** How long one `lambda pod ask` waits: under a Bash call's 2 minutes. */
export const ASK_WAIT_MS = 100_000;

const isTarget = (value: string): value is AskTarget =>
  ASK_TARGETS.some((target) => target === value);

const askWindow = (threadId: string): string => `ask-${threadId}`;

const noConversation = (id: string): Error =>
  new Error(`No conversation ${id}.`);

const liveThread = (store: PodStore, podId: string, id: string): AskThread => {
  const thread = store.readAsk(podId, id);

  if (thread === null || thread.closedAt !== undefined) {
    throw noConversation(id);
  }

  return thread;
};

const closeThread = (store: PodStore, thread: AskThread): void => {
  killWindow(`=${sessionName(thread.podId, store)}:=${thread.window}`);
  store.writeAsk({ ...thread, closedAt: nowIso() });
};

/**
 * The last thing the fork said since the question, from its session
 * transcript. A fork's transcript starts with the history --fork-session
 * copied, so anything said before `sentAt` is not its answer.
 */
const lastAnswer = (
  transcriptPath: string | undefined,
  sentAt: string
): string => {
  if (transcriptPath === undefined || !fs.existsSync(transcriptPath)) {
    return '';
  }

  const said = fs
    .readFileSync(transcriptPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line): string[] => {
      try {
        const entry: unknown = JSON.parse(line);

        if (
          typeof entry !== 'object' ||
          entry === null ||
          !('type' in entry) ||
          entry.type !== 'assistant' ||
          !('timestamp' in entry) ||
          typeof entry.timestamp !== 'string' ||
          !(Date.parse(entry.timestamp) >= Date.parse(sentAt)) ||
          !('message' in entry) ||
          typeof entry.message !== 'object' ||
          entry.message === null ||
          !('content' in entry.message) ||
          !Array.isArray(entry.message.content)
        ) {
          return [];
        }

        const text = entry.message.content
          .flatMap((part: unknown) =>
            typeof part === 'object' &&
            part !== null &&
            'type' in part &&
            part.type === 'text' &&
            'text' in part &&
            typeof part.text === 'string'
              ? [part.text]
              : []
          )
          .join('\n');

        return text === '' ? [] : [text];
      } catch {
        return [];
      }
    });

  return said.at(-1) ?? '';
};

/**
 * A question with no answer after ANSWER_TIMEOUT_MS. Its thread is closed: a
 * turn that ends later would be read as the next question's answer.
 */
class AnswerTimedOut extends Error {}

/**
 * Wait for the fork's turn to end (its Stop hook), then read the answer; null
 * when `waitUntil` comes first (the caller runs `--wait` to keep waiting).
 */
const awaitAnswer = async (input: {
  store: PodStore;
  podId: string;
  window: string;
  sentAt: string;
  waitUntil: number;
  now: () => number;
}): Promise<string | null> => {
  const { store, podId, window, sentAt, now } = input;
  const turn = store.readTurn(podId, window);

  if ((turn.endedAt ?? '') > sentAt) {
    return lastAnswer(turn.transcriptPath, sentAt);
  }

  if (now() > Date.parse(sentAt) + ANSWER_TIMEOUT_MS) {
    throw new AnswerTimedOut(
      `The ${window} fork didn't answer in time, so its conversation is closed. Ask again without --thread.`
    );
  }

  if (now() >= input.waitUntil) {
    return null;
  }

  await sleep(1000);

  return awaitAnswer(input);
};

const startThread = async (
  store: PodStore,
  podId: string,
  target: AskTarget
): Promise<AskThread> => {
  const pod = store.requirePod(podId);

  // The fork resumes the target's session: one that never started has none.
  if (store.readTurn(podId, target).startedAt === undefined) {
    throw new Error(
      `The ${target} hasn't started yet, so there's nothing to ask.`
    );
  }

  const id = `a${randomBytes(3).toString('hex')}`;
  const window = askWindow(id);
  const at = nowIso();
  const thread: AskThread = {
    id,
    podId,
    target,
    window,
    sessionId: sessionOf(pod, target),
    startedAt: at,
    lastUsedAt: at,
  };
  store.writeAsk(thread);
  // cwd is the target's: --resume finds sessions under the launch folder. A
  // launch that throws closes the thread too, or it stays open with no window.
  const ready = await launchAgent({
    pod,
    store,
    agent: window,
    cwd: target === 'engineering-manager' ? pod.managerCwd : pod.devCwd,
    mode: { kind: 'fork', fromSessionId: thread.sessionId },
  }).catch((error: unknown) => {
    closeThread(store, thread);

    throw error;
  });

  // A question pasted into a pane that never came up is lost, and the thread
  // would stay open on it.
  if (!ready) {
    closeThread(store, thread);

    throw new Error(
      `The ${target}'s fork didn't start, so the question wasn't sent. Ask again.`
    );
  }

  return thread;
};

/** Mark a thread used, over its latest record (a close made meanwhile stays). */
const touchThread = (store: PodStore, thread: AskThread, at: string): void => {
  store.writeAsk({
    ...(store.readAsk(thread.podId, thread.id) ?? thread),
    lastUsedAt: at,
  });
};

/** Wait for a thread's answer, print it, or say how to keep waiting. */
const printAnswer = async (input: {
  store: PodStore;
  thread: AskThread;
  sentAt: string;
  started: number;
  capMs: number;
  now: () => number;
  print: (line: string) => void;
}): Promise<void> => {
  const { store, thread, print } = input;
  const answer = await awaitAnswer({
    store,
    podId: thread.podId,
    window: thread.window,
    sentAt: input.sentAt,
    waitUntil: input.started + input.capMs,
    now: input.now,
  }).catch((error: unknown) => {
    if (error instanceof AnswerTimedOut) {
      closeThread(store, thread);
    }

    throw error;
  });

  if (answer === null) {
    print(
      `The ${thread.target}'s fork is still answering after ${Math.round(
        input.capMs / 1000
      )}s. Run \`lambda pod ask --thread ${thread.id} --wait\` to keep waiting.`
    );
    process.exitCode = 2;

    return;
  }

  touchThread(store, thread, nowIso());
  print(answer === '' ? '(no answer)' : answer);
};

const conversationLine = (thread: AskThread): string =>
  `[conversation ${thread.id} with a read-only fork of the ${thread.target}]`;

/**
 * Answers the conversation id; prints it, then the fork's answer. Exit 2
 * when the answer outlasts `capMs`: `--thread <id> --wait` picks it up.
 */
export const runAsk = async (
  target: string,
  question: string,
  options: { pod?: string; thread?: string; close?: string; wait?: boolean },
  print: (line: string) => void = (line) => console.log(line),
  clock: { now?: () => number; capMs?: number } = {}
): Promise<string> => {
  const now = clock.now ?? Date.now;
  const capMs = clock.capMs ?? ASK_WAIT_MS;
  const started = now();
  const podId = resolvePodId(options.pod ?? callerPodId());
  const store = openStore();
  const pod = store.requirePod(podId);

  // Only a building pod's forks run read-only (ask-settings.json, no auto
  // mode); a planning pod's would get its writable fork settings.
  if (podKindOf(pod) !== 'building') {
    throw new Error(
      `lambda pod ask works in a building pod only; ${podId} is a ${podKindOf(
        pod
      )} pod.`
    );
  }

  if (options.close !== undefined) {
    closeThread(store, liveThread(store, podId, options.close));
    print(`Closed conversation ${options.close}.`);

    return options.close;
  }

  if (options.wait === true) {
    return waitAgain(store, podId, target, question, options.thread, {
      started,
      capMs,
      now,
      print,
    });
  }

  if (!isTarget(target)) {
    throw new Error('You can ask the engineering-manager or the dev.');
  }

  if (question.trim() === '') {
    throw new Error('Give the question to ask.');
  }

  const existing =
    options.thread === undefined
      ? null
      : liveThread(store, podId, options.thread);

  if (existing !== null && existing.target !== target) {
    throw new Error(
      `Conversation ${existing.id} is with the ${existing.target}, not the ${target}.`
    );
  }

  // Its window died (killed by hand, or the machine restarted): closed, so
  // the idle watch and the next --thread don't find it open.
  if (
    existing !== null &&
    !hasWindow(sessionName(podId, store), existing.window)
  ) {
    store.writeAsk({ ...existing, closedAt: nowIso() });

    throw new Error(
      `Conversation ${existing.id} has ended: its fork's window is gone. Ask without --thread to start a new one.`
    );
  }

  // A second question queued behind a turn still running would be answered
  // with that turn's answer.
  const last =
    existing === null ? null : store.readTurn(podId, existing.window);

  if (
    existing !== null &&
    last?.sentAt !== undefined &&
    (last.endedAt ?? '') <= last.sentAt
  ) {
    if (now() <= Date.parse(last.sentAt) + ANSWER_TIMEOUT_MS) {
      throw new Error(
        `Conversation ${existing.id} is still answering the last question. Run \`lambda pod ask --thread ${existing.id} --wait\` for that answer, then ask again.`
      );
    }

    // Past the timeout the old turn can still end, and its answer would be
    // read as this question's: the conversation is closed instead.
    closeThread(store, existing);

    throw new Error(
      `Conversation ${existing.id} never answered its last question, so it's closed. Ask without --thread to start a new one.`
    );
  }

  const thread = existing ?? (await startThread(store, podId, target));
  const sentAt = nowIso();
  // In use from the moment it's asked: the 15-minute watch must not spin it
  // down while it answers.
  touchThread(store, thread, sentAt);
  store.patchTurn(podId, thread.window, { sentAt });
  // Never the question first: a leading `/`, `!` or `#` is a command to
  // Claude Code's input box, not words for the fork.
  await sendToPane(
    `${sessionName(podId, store)}:${thread.window}`,
    `${ASK_PREFIX} ${question}`
  );
  // Before the wait: a caller cut off mid-wait still has the id to go on.
  print(conversationLine(thread));
  await printAnswer({ store, thread, sentAt, started, capMs, now, print });

  return thread.id;
};

/** `--thread <id> --wait`: wait again for the last question's answer. */
const waitAgain = async (
  store: PodStore,
  podId: string,
  target: string,
  question: string,
  threadId: string | undefined,
  wait: {
    started: number;
    capMs: number;
    now: () => number;
    print: (line: string) => void;
  }
): Promise<string> => {
  if (threadId === undefined) {
    throw new Error('--wait needs --thread <id>.');
  }

  if (question.trim() !== '') {
    throw new Error('--wait sends no question: drop the question.');
  }

  const thread = liveThread(store, podId, threadId);

  if (target !== '' && target !== thread.target) {
    throw new Error(
      `Conversation ${thread.id} is with the ${thread.target}, not the ${target}.`
    );
  }

  const { sentAt } = store.readTurn(podId, thread.window);

  if (sentAt === undefined) {
    throw new Error(`Nothing has been asked on conversation ${thread.id}.`);
  }

  wait.print(conversationLine(thread));
  await printAnswer({ store, thread, sentAt, ...wait });

  return thread.id;
};

/** Spin down every conversation idle for 15 minutes (the runner's watch). */
export const closeIdleAsks = (
  store: PodStore,
  podId: string,
  now: number = Date.now()
): string[] =>
  store
    .listAsks(podId)
    .filter(
      (thread) =>
        thread.closedAt === undefined &&
        now - Date.parse(thread.lastUsedAt) >= ASK_IDLE_MS
    )
    .map((thread) => {
      closeThread(store, thread);

      return thread.id;
    });
