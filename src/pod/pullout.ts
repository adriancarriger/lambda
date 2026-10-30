import { execFileSync } from 'child_process';

import type { Pod, Question, ThreadMessage } from '../pod-store';
import { callerPodId, currentProject, openStore, podsRoot } from './context';
import { ticketIds } from './intake';
import { ownerForAgent, ownersForAgent } from './owner';

/**
 * A pod starting a pod, only with the owner's say-so: a ticket the owner
 * agreed to pull out of a batch, at a checkpoint the owner closed, or work the
 * owner agreed in the chat should be its own Lambda (`--spinoff <message>`).
 * Either way it is created exactly as a person would create it — from the
 * main checkout, with this pod's identity stripped — so its worktree isn't
 * nested in this one and its agents don't think they belong here.
 */

const isPullOut = (
  row: NonNullable<NonNullable<Question['checkpoint']>['planTickets']>[number]
): boolean =>
  row.proposal === 'pull-out' ||
  // Checkpoints posted before rows carried `proposal`.
  (row.proposal === undefined &&
    /\bpull(?:ed)?[\s-]*(?:it\s+)?out\b/i.test(row.name ?? ''));

export const pullOutRefusal = (
  pod: Pod,
  checkpoint: Question | undefined,
  ticketId: string
): string | null => {
  const owner = ownerForAgent();

  if (checkpoint === undefined || checkpoint.kind !== 'checkpoint') {
    return `Name the checkpoint where ${owner} approved the pull-out: --from-checkpoint <qid>.`;
  }

  const cp = checkpoint.checkpoint?.cp;

  if (
    checkpoint.status !== 'answered' ||
    cp === undefined ||
    !pod.completedCheckpoints.includes(cp)
  ) {
    return `${checkpoint.id} isn't closed yet — a pod is started only after ${owner} approves the checkpoint that proposes it.`;
  }

  const row = (checkpoint.checkpoint?.planTickets ?? []).find(
    (candidate) => candidate.id === ticketId
  );

  if (row === undefined || !isPullOut(row)) {
    return `${ticketId} isn't a pull-out on ${checkpoint.id} — only a ticket ${owner} agreed to move into its own pod gets one.`;
  }

  return null;
};

/** A spin-off needs the owner's own message in this pod's chat agreeing to it. */
export const spinoffRefusal = (
  thread: ThreadMessage[],
  messageId: string,
  text: string | undefined
): string | null => {
  const owner = ownerForAgent();
  const owners = ownersForAgent();

  if (text === undefined || text.trim() === '') {
    return `Say what the new Lambda is about: --text "<${owners} ask, and where this chat left it>".`;
  }

  const message = thread.find((candidate) => candidate.id === messageId);

  if (message === undefined) {
    return `No message ${messageId} in this Lambda's chat — pass the [m:…] id of ${owners} message agreeing to a new Lambda.`;
  }

  if (message.from !== 'human') {
    return `${messageId} isn't ${owners} — only ${owner} agrees to a new Lambda; pass the id of ${owners} message.`;
  }

  return null;
};

/**
 * Re-run `lambda pod new` as a person would: the running `lambda`, from the
 * project's main checkout, as nobody's pod.
 */
export const newAsPerson = (
  args: string[],
  runningBinary: string | undefined = process.argv[1]
): void => {
  if (runningBinary === undefined) {
    throw new Error("Can't tell which lambda is running.");
  }

  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key !== 'POD_ID' && key !== 'POD_AGENT'
    )
  );

  execFileSync(process.execPath, [runningBinary, 'pod', 'new', ...args], {
    cwd: currentProject().root,
    env: { ...env, LAMBDA_PODS_ROOT: podsRoot() },
    stdio: 'inherit',
  });
};

/** `lambda pod new` run by a pod agent: check, then run it as a person would. */
export const runNewFromPod = (
  slug: string,
  options: {
    text?: string;
    fromCheckpoint?: string;
    spinoff?: string;
    launch?: boolean;
  }
): void => {
  const podId = callerPodId();

  if (podId === undefined) {
    throw new Error('runNewFromPod is for pod agents.');
  }

  if (options.spinoff !== undefined) {
    const store = openStore();
    const refusal = spinoffRefusal(
      store.readThread(podId),
      options.spinoff,
      options.text
    );

    if (refusal !== null) {
      throw new Error(refusal);
    }

    // A conversation to start: freeform, whatever this pod is.
    newAsPerson([
      slug,
      '--text',
      options.text ?? '',
      '--single',
      '--freeform',
      ...(options.launch === false ? ['--no-launch'] : []),
      '--from-pod',
      podId,
      '--from-message',
      options.spinoff,
    ]);

    return;
  }

  const [ticketId] = ticketIds(options.text ?? '');

  if (ticketId === undefined) {
    throw new Error(
      'A pod starts a pod only for a pulled-out ticket: --text "<ticket id> <why it left the batch>".'
    );
  }

  const store = openStore();
  const pod = store.requirePod(podId);
  const checkpoint = store
    .listQuestions(podId)
    .find((question) => question.id === options.fromCheckpoint);
  const refusal = pullOutRefusal(pod, checkpoint, ticketId);

  if (refusal !== null || checkpoint === undefined) {
    throw new Error(refusal ?? 'No checkpoint.');
  }

  newAsPerson([
    slug,
    '--text',
    options.text ?? ticketId,
    '--single',
    ...(pod.mode === 'freeform' ? ['--freeform'] : []),
    ...(options.launch === false ? ['--no-launch'] : []),
    '--from-pod',
    podId,
    '--from-qid',
    checkpoint.id,
  ]);
};
