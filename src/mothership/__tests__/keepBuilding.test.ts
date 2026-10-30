import type { PodSnapshot } from '../../app/shared/snapshot';
import {
  type BuildingCandidate,
  KEEP_BUILDING_RETRY_MS,
  buildingStarts,
} from '../keepBuilding';
import { autoOrder } from '../pods';
import { podSnapshot } from './harness';

/** Building is on by default: who gets a building pod on the next tick. */

const T0 = Date.parse('2026-10-26T10:00:00.000Z');

const buildingPod = (status: 'active' | 'paused' | 'done'): PodSnapshot => {
  const snapshot = podSnapshot('build-a1b2');

  return {
    ...snapshot,
    summary: {
      ...snapshot.summary,
      pod: { ...snapshot.summary.pod, kind: 'building', status },
    },
  };
};

const leslie = (
  overrides: Partial<BuildingCandidate> = {}
): BuildingCandidate => ({
  runnerId: 'rnr-leslie',
  currentProjectId: 'prj-parks',
  switching: false,
  hasFolder: true,
  snapshots: [],
  ...overrides,
});

describe('keeping every computer building', () => {
  it('starts building on a computer on a project with no building pod', () => {
    expect(buildingStarts([leslie()], new Map(), T0)).toEqual([
      { runnerId: 'rnr-leslie', projectId: 'prj-parks' },
    ]);
  });

  it('leaves a computer alone that is building, or paused', () => {
    expect(
      buildingStarts(
        [
          leslie({ snapshots: [buildingPod('active')] }),
          leslie({ runnerId: 'rnr-ann', snapshots: [buildingPod('paused')] }),
        ],
        new Map(),
        T0
      )
    ).toEqual([]);
  });

  it('starts again once its building pod is done', () => {
    expect(
      buildingStarts(
        [leslie({ snapshots: [buildingPod('done')] })],
        new Map(),
        T0
      )
    ).toHaveLength(1);
  });

  it('never starts on a computer on no project, mid switch, or without the folder', () => {
    expect(
      buildingStarts(
        [
          leslie({ currentProjectId: null }),
          leslie({ switching: true }),
          leslie({ hasFolder: false }),
        ],
        new Map(),
        T0
      )
    ).toEqual([]);
  });

  it('waits between tries on the same computer', () => {
    const tried = new Map([['rnr-leslie', T0]]);

    expect(buildingStarts([leslie()], tried, T0 + 60_000)).toEqual([]);
    expect(
      buildingStarts([leslie()], tried, T0 + KEEP_BUILDING_RETRY_MS)
    ).toHaveLength(1);
  });
});

describe("Auto's order", () => {
  it('puts a build blocker first and a review next, keeping the rest in order', () => {
    const entry = (key: string, tag?: 'blocked' | 'review') => ({
      podId: 'p',
      kind: 'reply' as const,
      key,
      ...(tag === undefined ? {} : { tag }),
    });

    expect(
      autoOrder([
        entry('checkpoint'),
        entry('review', 'review'),
        entry('reply'),
        entry('blocker', 'blocked'),
      ]).map((one) => one.key)
    ).toEqual(['blocker', 'review', 'checkpoint', 'reply']);
  });
});
