import { currentRun } from '../app/shared/building';
import type { PodStore } from '../pod-store';
import { resolvePodId } from '../pod/context';
import type { TicketSource } from '../tickets/source';

/**
 * `lambda pod skip-ticket <pod-id> <ticket-id>` (the Engineering manager's):
 * leave a ticket out of this pod's queue for the life of the pod. Its status
 * in the ticket source and every claim stay as they are. The manager writes
 * its pod id out (its opening message names it): its permission hook refuses
 * `$POD_ID`, a `$` outside single quotes. Called without a pod, it is the
 * caller's POD_ID.
 */
export const runSkipTicket = async (
  explicitPodId: string | undefined,
  ticketId: string,
  deps: {
    store: PodStore;
    source: TicketSource;
    /** Who is asking: their `POD_AGENT`, undefined for a person. */
    caller: string | undefined;
  }
): Promise<void> => {
  const { store } = deps;
  const podId = resolvePodId(explicitPodId);

  // The Engineering manager runs the queue: the Product manager relays the
  // owner's call to it, and nobody else skips a ticket, whatever their
  // settings allow.
  if (deps.caller !== 'engineering-manager') {
    throw new Error('Only the Engineering manager can skip a ticket.');
  }

  const current = currentRun(store.readBuilding(podId));

  if (current?.id === ticketId) {
    throw new Error(
      `${ticketId} is being built now. Use \`lambda pod blocked\` to set it aside.`
    );
  }

  const known = (await deps.source.list()).some(
    (ticket) => ticket.id === ticketId
  );

  if (!known) {
    throw new Error(`No ticket ${ticketId} in this codebase.`);
  }

  const pod = store.updatePod(podId, (current) =>
    (current.skipped ?? []).includes(ticketId)
      ? current
      : { ...current, skipped: [...(current.skipped ?? []), ticketId] }
  );
  // The rail's Up next drops it now, not at the next pick-up.
  store.updateBuilding(podId, (state) => ({
    ...state,
    upNext: state.upNext.filter((ticket) => ticket.id !== ticketId),
  }));
  console.log(
    `${ticketId} is skipped for this pod (${
      (pod.skipped ?? []).length
    } skipped).`
  );
};
