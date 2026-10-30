import { type Pod, type Question } from './schemas';

export interface InboxItem {
  pod: Pod;
  question: Question;
}

/**
 * The order the owner sees open questions in:
 *   1. pods in the owner's drag order (`_inbox.json`); unlisted pods after, oldest first
 *   2. within a pod, checkpoint items and checkpoint-blocking questions first
 *   3. then oldest committed first
 */
export const orderInbox = (
  pods: Pod[],
  questions: Question[],
  priority: string[]
): InboxItem[] => {
  const podRank = (pod: Pod): number => {
    const index = priority.indexOf(pod.id);

    return index === -1 ? priority.length : index;
  };

  const rankedPods = [...pods]
    .filter((pod) => pod.status === 'active')
    .sort(
      (a, b) =>
        podRank(a) - podRank(b) || a.createdAt.localeCompare(b.createdAt)
    );

  const urgency = (question: Question): number =>
    question.kind === 'checkpoint' || question.blocksCheckpoint ? 0 : 1;

  return rankedPods.flatMap((pod) =>
    questions
      .filter(
        (question) => question.podId === pod.id && question.status === 'open'
      )
      .sort(
        (a, b) =>
          urgency(a) - urgency(b) ||
          (a.committedAt ?? a.createdAt).localeCompare(
            b.committedAt ?? b.createdAt
          )
      )
      .map((question) => ({ pod, question }))
  );
};
