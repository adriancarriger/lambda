/**
 * What `POST /api/pods/new` answers when the pod's computer is busy on another
 * project: not a pod id yet, but the waiting pod's, with this prefix. The
 * app reads it to show the pod waiting in the sidebar instead of opening it.
 */
export const WAITING_PREFIX = 'waiting:';

export const waitingPodId = (id: string): string => `${WAITING_PREFIX}${id}`;

export const isWaitingPodId = (id: string): boolean =>
  id.startsWith(WAITING_PREFIX);
