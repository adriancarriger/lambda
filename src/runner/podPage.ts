import * as fs from 'fs';

import {
  type BuildingPodDetail,
  buildingStateOf,
} from '../app/shared/building';
import { readVisualRounds } from '../building/visualPictures';
import { allBuildingSteps } from '../building/workflow';
import { type PodStore, type Screenshot } from '../pod-store';

/**
 * A building pod's page, as its runner reads it: everything but the
 * project's events, which the mothership adds (it has every runner's).
 */

/**
 * The project's building steps, in order, each once. A step switched off is
 * kept, marked `off`: it never runs, but its skip ("switched off") still has
 * a row on the rail.
 */
const pageSteps = (
  projectRoot: string
): { id: string; label: string; off?: boolean }[] =>
  Array.from(
    new Map(
      allBuildingSteps(projectRoot).map(
        (step) =>
          [
            step.id,
            {
              id: step.id,
              label: step.label,
              ...(step.off === true ? { off: true } : {}),
            },
          ] as const
      )
    ).values()
  );

/** Every test attempt's screenshots, by `<ticket>/<attempt>`. */
const screenshotsOf = (
  store: PodStore,
  podId: string
): Record<string, Screenshot[]> => {
  const dir = store.file(podId, 'screenshots');

  if (!fs.existsSync(dir)) {
    return {};
  }

  // Real folders only: a link (dangling or not) isn't an attempt Lambda wrote.
  return Object.fromEntries(
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const ticketId = entry.name;

      if (!/^[A-Za-z0-9_-]+$/.test(ticketId) || !entry.isDirectory()) {
        return [];
      }

      return fs
        .readdirSync(store.file(podId, 'screenshots', ticketId))
        .filter((attempt) => /^[1-9]\d*$/.test(attempt))
        .map((attempt) => [
          `${ticketId}/${attempt}`,
          store.readScreenshots(podId, ticketId, Number(attempt)),
        ]);
    })
  );
};

export const buildingDetail = (input: {
  store: PodStore;
  podId: string;
  projectRoot: string;
  windows: string[];
  computer: string;
}): Omit<BuildingPodDetail, 'events' | 'typicalMs'> => {
  const { store, podId } = input;
  const pod = store.requirePod(podId);
  const building = store.readBuilding(podId);

  return {
    pod,
    thread: store.readThread(podId),
    windows: input.windows,
    building,
    summary: buildingStateOf(pod, building),
    steps: pageSteps(input.projectRoot),
    screenshots: screenshotsOf(store, podId),
    visual: readVisualRounds(store, podId),
    computer: input.computer,
  };
};
