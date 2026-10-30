import { type ThreadMessage } from './schemas';

/**
 * Messages an agent never took in, that are worth sending again.
 *
 * "Delivered" only means typed into the pane: a message pasted while the agent
 * is mid-turn queues in its input box and is lost if the agent restarts before
 * submitting it, and the pod then waits on an answer the inbox thinks it has.
 *
 * Left out:
 *   - fork messages (the fork is recovered, not re-sent to);
 *   - the system's own restart notices, nudges and heartbeats, which are sent
 *     afresh whenever they still apply — replaying a stale one only confuses;
 *   - anything older than RESEND_MAX_AGE_MS, so a long-quiet pod never gets
 *     a backlog replayed into it.
 */

export const RESEND_MAX_AGE_MS = 3 * 24 * 60 * 60_000;

/** A planning pod's agents, and a building pod's. */
const RESENDABLE_TARGETS = ['manager', 'dev', 'engineering-manager', 'qa'];

const REGENERATED = /^(?:\[Watchdog\]|\[Heartbeat\])/;

export const isResendable = (message: ThreadMessage, now: number): boolean => {
  if (message.wire === undefined || message.target === undefined) {
    return false;
  }

  if (!RESENDABLE_TARGETS.includes(message.target)) {
    return false;
  }

  if (message.delivery === 'received') {
    return false;
  }

  if (
    message.from === 'system' &&
    (message.wire.startsWith('/pod-restarted') ||
      REGENERATED.test(message.text))
  ) {
    return false;
  }

  return now - Date.parse(message.createdAt) <= RESEND_MAX_AGE_MS;
};

export const pendingResends = (
  thread: ThreadMessage[],
  now: number
): ThreadMessage[] => thread.filter((message) => isResendable(message, now));
