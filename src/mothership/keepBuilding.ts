import type { PodSnapshot } from '../app/shared/snapshot';
import { podKindOf } from '../pod-store/schemas';

/**
 * Every connected computer with a project it's on, and no building pod, gets
 * one, made paused: building is off until someone resumes it (a pod ended
 * mid-run is not replaced by one that takes the next ticket). Paused is a
 * building pod too, so a paused computer stays paused.
 */

/** How long after a start (or a failed one) the same computer is left alone. */
export const KEEP_BUILDING_RETRY_MS = 5 * 60_000;

export interface BuildingCandidate {
  runnerId: string;
  /** The project it's on; null when it's on none. */
  currentProjectId: string | null;
  /** Mid idle switch: on neither project yet. */
  switching: boolean;
  /** Does it have that project's folder? */
  hasFolder: boolean;
  /** Its pods, on any project. */
  snapshots: PodSnapshot[];
}

/** A building pod that isn't done: active or paused. */
export const hasBuildingPod = (snapshots: PodSnapshot[]): boolean =>
  snapshots.some(
    ({ summary: { pod } }) =>
      podKindOf(pod) === 'building' &&
      pod.status !== 'done' &&
      pod.talk === undefined
  );

/** The computers to start building on now, each on its current project. */
export const buildingStarts = (
  candidates: BuildingCandidate[],
  lastTried: ReadonlyMap<string, number>,
  now: number
): Array<{ runnerId: string; projectId: string }> =>
  candidates.flatMap((candidate) => {
    const tried = lastTried.get(candidate.runnerId);

    if (
      candidate.currentProjectId === null ||
      candidate.switching ||
      !candidate.hasFolder ||
      hasBuildingPod(candidate.snapshots) ||
      (tried !== undefined && now - tried < KEEP_BUILDING_RETRY_MS)
    ) {
      return [];
    }

    return [
      { runnerId: candidate.runnerId, projectId: candidate.currentProjectId },
    ];
  });
