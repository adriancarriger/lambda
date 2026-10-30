import type { BuildTicketRun, BuildingState, PodStore } from '../pod-store';

/**
 * The breaker: a building pod stops taking tickets when its blocks say the
 * trouble isn't the tickets' (Adrian, 2026-10-29): a problem with the
 * checkout itself would otherwise block every ticket that follows.
 *
 * - Two tickets blocked in a row since the last Resume: paused.
 * - `lambda pod blocked --pause`: the Engineering manager says the problem
 *   isn't the ticket's, so the next one would stop the same way. Paused.
 * - A ticket blocked before it left Pick up, right after a block: the same
 *   problem held it. Its block is folded into that block's item, it goes
 *   back to Ready, and the pod is paused (building/blocked.ts).
 * - The project's pick-up command failed: paused (building/driver.ts).
 *
 * Resume is the owner's, as for any pause.
 */

/** The run blocked just before the current one, since the last Resume. */
export const blockedJustBefore = (
  state: Pick<BuildingState, 'runs' | 'resumedAt'>
): BuildTicketRun | null => {
  const before = state.runs.at(-2);

  return before?.blocked !== undefined &&
    before.blocked.at > (state.resumedAt ?? '')
    ? before
    : null;
};

/** Pauses the pod: its windows and agents are left as they are. */
export const pauseBuilding = (
  store: PodStore,
  podId: string,
  reason: string,
  at: string
): void => {
  store.updatePod(podId, (pod) => ({ ...pod, status: 'paused' }));
  store.updateBuilding(podId, (state) => ({
    ...state,
    pause: state.pause ?? { at, interrupted: [], reason },
  }));
};

export const twoInARowText = (first: string, second: string): string =>
  `Lambda paused this builder: ${first} and ${second} were blocked one after the other, so the trouble may not be the tickets'. Resume it once that's sorted out.`;

export const pausedByManagerText =
  "Lambda paused this builder: the Engineering manager says this problem isn't the ticket's, so the next ticket would stop the same way. Resume it once that's sorted out.";

export const foldedText = (
  run: Pick<BuildTicketRun, 'id' | 'title'>,
  into: Pick<BuildTicketRun, 'id'>,
  problem: string
): string =>
  `${run.id} ${run.title} was held by the same problem as ${into.id}, before any work on it: it's back in Ready, not Blocked, and listed on ${into.id}'s item. Lambda paused this builder; resume it once that's sorted out.\n\n${problem}`;
