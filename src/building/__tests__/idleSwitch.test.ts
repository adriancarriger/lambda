import { podActivity } from '../../runner/podHost';
import { buildingPodStore } from './fakes';

/**
 * The idle project switch moves a computer to another project only when its
 * pods are idle: a building pod with nothing Ready is; one on a ticket
 * isn't, even between its agents' turns.
 */
describe('a building pod and the idle project switch', () => {
  it('is idle with nothing to build', () => {
    const { store, podId } = buildingPodStore();

    expect(podActivity(store, podId).midTurn).toBe(false);
  });

  it('is busy while it has a ticket, between turns too', () => {
    const { store, podId } = buildingPodStore();
    store.writeBuilding(podId, {
      runs: [
        {
          id: '3',
          title: 'Trail markers',
          step: 'build',
          attempt: 1,
          startedAt: '2026-10-23T10:00:00.000Z',
          claim: 'claimed',
        },
      ],
      upNext: [],
    });

    expect(podActivity(store, podId).midTurn).toBe(true);
  });
});
