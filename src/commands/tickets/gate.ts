/**
 * The block gate. Inside a pod (`POD_ID` set), an agent may add or remove a
 * dependency only after the owner said so: it names the question the owner
 * answered (`--qid`), or the checkpoint the owner closed after seeing the
 * link listed (`--checkpoint`). Outside a pod there's no gate.
 * `update --status blocked` is a state change, not a dependency, and isn't
 * gated.
 */
import { type Pod, type Question } from '../../pod-store/schemas';

/** The two reads the gate needs from the pod store. */
export interface GateStore {
  listQuestions(podId: string): Question[];
  readPod(podId: string): Pod | null;
}

export interface GateInput {
  /** `POD_ID`; undefined outside a pod. */
  podId: string | undefined;
  qid?: string;
  checkpoint?: string;
  /** `owner.name` (or `Owner`), in place of the owner's name and pronoun. */
  owner: string;
  /** Opened only when needed (inside a pod). */
  store: () => GateStore;
}

const noApproval = (owner: string): string =>
  `A pod changes a dependency only after ${owner} says so: pass --qid <the question ${owner} answered> or --checkpoint <a checkpoint ${owner} closed>.`;

/** May a pod change a dependency on question `qid`? */
export const blockRefusal = (
  store: GateStore,
  podId: string,
  qid: string | undefined,
  owner: string
): string | null => {
  if (qid === undefined) {
    return noApproval(owner);
  }

  const question = store
    .listQuestions(podId)
    .find((candidate) => candidate.id === qid);

  if (question === undefined) {
    return `No question ${qid} in this pod.`;
  }

  // An answered checkpoint isn't closed until the pod records it, so a
  // checkpoint always goes through --checkpoint and checkpointRefusal.
  if (question.kind === 'checkpoint') {
    return `${qid} is a checkpoint, not a question — use --checkpoint.`;
  }

  return question.status === 'answered'
    ? null
    : `${qid} is ${question.status} — ${owner} hasn't answered it yet.`;
};

/** Or on checkpoint `qid`, once the owner has closed it. */
export const checkpointRefusal = (
  store: GateStore,
  podId: string,
  qid: string,
  owner: string
): string | null => {
  const question = store
    .listQuestions(podId)
    .find((candidate) => candidate.id === qid);

  if (question === undefined) {
    return `No checkpoint ${qid} in this pod.`;
  }

  if (question.kind !== 'checkpoint') {
    return `${qid} is a question, not a checkpoint — use --qid.`;
  }

  const cp = question.checkpoint?.cp;
  const closed =
    question.status === 'answered' &&
    cp !== undefined &&
    (store.readPod(podId)?.completedCheckpoints ?? []).includes(cp);

  return closed
    ? null
    : `${qid} (CP${cp ?? '?'}) is ${
        question.status
      } — ${owner} hasn't closed it yet.`;
};

/** Throws the refusal, or returns when the change may go ahead. */
export const checkBlockGate = (input: GateInput): void => {
  if (input.podId === undefined || input.podId === '') {
    return;
  }

  if (input.qid !== undefined && input.checkpoint !== undefined) {
    throw new Error('Pass --qid or --checkpoint, not both.');
  }

  if (input.qid === undefined && input.checkpoint === undefined) {
    throw new Error(noApproval(input.owner));
  }

  const refusal =
    input.checkpoint === undefined
      ? blockRefusal(input.store(), input.podId, input.qid, input.owner)
      : checkpointRefusal(
          input.store(),
          input.podId,
          input.checkpoint,
          input.owner
        );

  if (refusal !== null) {
    throw new Error(refusal);
  }
};
