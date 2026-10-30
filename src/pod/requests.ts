import { newId, nowIso, stagesFor } from '../pod-store';
import {
  agentWindowOf,
  callerAgent,
  openStore,
  paneTarget,
  resolvePodId,
  sessionName,
} from './context';
import { sendMessage } from './messaging';
import { ownersForAgent } from './owner';
import { hasWindow, sendKey } from './tmux';

/**
 * Work requests: anything the owner asks a pod to DO, at any time. Queued here
 * (by the Chat panel's fork, the app, or by hand); the manager runs it at once
 * — interrupting the dev's turn — then re-runs whatever it made stale. While
 * one is queued or running, all of the pod's inbox items step aside (the app
 * reads `activeRequest`), so the owner never answers something being reworked.
 */

export const runRequestAdd = async (
  summary: string,
  options: { pod?: string; quote?: string; qid?: string }
): Promise<void> => {
  const podId = resolvePodId(options.pod);
  const store = openStore();
  const quote = options.quote?.trim() ?? '';

  const owners = ownersForAgent();

  if (summary.trim() === '' || quote === '') {
    throw new Error(
      `A request needs a one-line summary and --quote "<${owners} exact words>".`
    );
  }

  const id = store.nextRequestId(podId);
  store.writeRequest({
    id,
    podId,
    summary: summary.trim(),
    quote,
    qid: options.qid,
    status: 'queued',
    createdAt: nowIso(),
  });
  await sendMessage(store, {
    podId,
    target: 'manager',
    command: '/pod-request-queued',
    text: `Work request ${id}: ${summary.trim()}`,
    wireText: `${id}: ${summary.trim()} — ${owners} words: "${quote}". Run it now (see "Work requests" in your CLAUDE.md).`,
    mode: 'note',
    from: 'system',
  });
  console.log(`Queued ${id}; the manager will run it now.`);
};

/** (manager) Start a request: mark it working and hand it to the dev. */
export const runRequestStart = async (
  rid: string,
  options: { pod?: string }
): Promise<void> => {
  const podId = resolvePodId(options.pod);
  const store = openStore();
  const request = store.readRequest(podId, rid);

  if (request === null) {
    throw new Error(`No request ${rid}.`);
  }

  if (request.status === 'done') {
    throw new Error(`${rid} is already done.`);
  }

  store.writeRequest({ ...request, status: 'working', startedAt: nowIso() });
  await sendMessage(store, {
    podId,
    target: 'dev',
    command: '/pod-request',
    text: `Work request ${rid}: ${request.summary}`,
    wireText: `${rid}: ${request.summary} — ${ownersForAgent()} words: "${
      request.quote
    }"${request.qid === undefined ? '' : ` (asked while on ${request.qid})`}`,
    mode: 'note',
    from: 'system',
  });
  console.log(`${rid} is with the dev.`);
};

/**
 * (dev) The request is done. `invalidates`: the workflow stages it made stale
 * — an open checkpoint of theirs is withdrawn now (it comes back when the
 * manager re-runs the stage), so the stale one never returns to the inbox.
 */
export const runRequestDone = async (
  rid: string,
  options: { pod?: string; result?: string; invalidates?: string }
): Promise<void> => {
  const podId = resolvePodId(options.pod);
  const store = openStore();
  const request = store.readRequest(podId, rid);
  const result = options.result?.trim() ?? '';

  if (request === null) {
    throw new Error(`No request ${rid}.`);
  }

  if (result === '') {
    throw new Error(
      'Say what it did: --result "<one plain line: what changed, decisions logged, questions asked>".'
    );
  }

  const pod = store.requirePod(podId);
  const stages = stagesFor(pod);
  const invalidates = (options.invalidates ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '' && id !== 'none');
  const unknown = invalidates.filter(
    (id) => !stages.some((stage) => stage.id === id)
  );

  if (unknown.length > 0) {
    throw new Error(
      `Unknown stage ${unknown.join(', ')}. This pod's stages: ${stages
        .map((stage) => stage.id)
        .join(', ')} (or none).`
    );
  }

  // A stale stage's checkpoint: the checkpoint stage itself, or the one that
  // closes a phase stage. Withdraw it while open; the redo re-posts it.
  const checkpoints = invalidates.flatMap((id) => {
    const index = stages.findIndex((stage) => stage.id === id);
    const stage = stages[index];
    const next = stages[index + 1];

    return stage?.checkpoint !== undefined
      ? [stage.checkpoint]
      : next?.checkpoint !== undefined
      ? [next.checkpoint]
      : [];
  });
  const withdrawn = store
    .listQuestions(podId)
    .filter(
      (question) =>
        question.kind === 'checkpoint' &&
        question.status === 'open' &&
        checkpoints.includes(question.checkpoint?.cp ?? 0)
    );
  withdrawn.forEach((question) =>
    store.writeQuestion({
      ...question,
      status: 'withdrawn',
      withdrawnAt: nowIso(),
      withdrawReason: `Made stale by work request ${rid} — it is redone and re-posted.`,
    })
  );

  store.writeRequest({
    ...request,
    status: 'done',
    doneAt: nowIso(),
    result,
    invalidates,
  });
  // The owner sees the outcome in the Chat panel.
  store.appendThread({
    id: newId('m'),
    podId,
    qid: request.qid,
    from: 'dev',
    mode: 'note',
    text: `Done: ${request.summary}. ${result}${
      invalidates.length === 0
        ? ''
        : ` Redoing ${invalidates.join(', ')} on top of it.`
    }`,
    chat: true,
    createdAt: nowIso(),
  });
  await sendMessage(store, {
    podId,
    target: 'manager',
    command: '/pod-request-done',
    text: `Work request ${rid} done: ${result}`,
    wireText: `${rid} done: ${result}. Invalidated: ${
      invalidates.length === 0 ? 'none' : invalidates.join(', ')
    }${
      withdrawn.length === 0
        ? ''
        : ` (withdrew ${withdrawn.map((question) => question.id).join(', ')})`
    }. Re-run the invalidated stages, then continue (see "Work requests" in your CLAUDE.md).`,
    mode: 'note',
    from: 'system',
  });
  console.log(
    `${rid} done.${
      withdrawn.length === 0
        ? ''
        : ` Withdrew ${withdrawn.map((question) => question.id).join(', ')}.`
    }`
  );
};

export const runRequestList = (options: { pod?: string }): void => {
  const podId = resolvePodId(options.pod);
  const requests = openStore().listRequests(podId);

  if (requests.length === 0) {
    console.log('No requests.');

    return;
  }

  requests.forEach((request) =>
    console.log(
      `${request.id}  ${request.status.padEnd(7)}  ${request.summary}${
        request.result === undefined ? '' : `\n      → ${request.result}`
      }`
    )
  );
};

/**
 * (manager) Stop an agent's turn now — Escape, as at the keyboard — so a work
 * request doesn't wait behind stale work. Safe: every stage re-pulls tickets
 * and is re-run from the top afterwards.
 */
export const runInterrupt = (podId: string, agent: string): void => {
  if (callerAgent() !== undefined && callerAgent() !== 'manager') {
    throw new Error('Only the manager (or a person) interrupts an agent.');
  }

  if (!hasWindow(sessionName(podId), agentWindowOf(podId, agent))) {
    throw new Error(`Pod ${podId} has no "${agent}" window.`);
  }

  sendKey(paneTarget(podId, agent), 'Escape');
  console.log(`Interrupted ${agent}'s turn.`);
};
