import type { PodSummary } from './types';

/** Pods in the owner's drag order; unlisted pods after, oldest first. */
export const orderPods = (
  pods: PodSummary[],
  priority: string[]
): PodSummary[] => {
  const rank = (summary: PodSummary): number => {
    const index = priority.indexOf(summary.pod.id);

    return index === -1 ? priority.length : index;
  };

  return [...pods]
    .filter((summary) => summary.pod.status !== 'done')
    .sort(
      (a, b) =>
        rank(a) - rank(b) || a.pod.createdAt.localeCompare(b.pod.createdAt)
    );
};

/** The pod's place in the sidebar, from 1 — how the audio introduces it. */
export const podNumber = (
  pods: PodSummary[],
  priority: string[],
  podId: string
): number | undefined => {
  const index = orderPods(pods, priority).findIndex(
    (summary) => summary.pod.id === podId
  );

  return index === -1 ? undefined : index + 1;
};
