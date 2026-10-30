import { buildingPodStore } from '../../building/__tests__/fakes';
import * as context from '../context';
import { runStep } from '../steps';
import './podProject';

afterEach(() => {
  delete process.env.LAMBDA_PODS_ROOT;
  jest.restoreAllMocks();
});

describe('lambda pod step attempts on a building pod', () => {
  it("counts only the current run's starts: a ticket set back to Ready starts again at attempt 1", () => {
    const { store, root, podId } = buildingPodStore();
    process.env.LAMBDA_PODS_ROOT = store.root;
    store.writeBuilding(podId, {
      runs: [
        {
          id: '3',
          title: 'Trail markers',
          step: 'test',
          attempt: 4,
          startedAt: '2026-10-01T09:00:00.000Z',
          claim: 'released',
          blocked: {
            at: '2026-10-01T09:40:00.000Z',
            what: 'Ticket 3 stalled',
            problem: 'No progress on Test',
            options: '1. Set it back to Ready to retry',
            recommendation: '1',
          },
        },
        {
          id: '3',
          title: 'Trail markers',
          step: 'pick-up',
          attempt: 1,
          startedAt: '2026-10-01T10:00:00.000Z',
          claim: 'claimed',
        },
      ],
      upNext: [],
    });
    [1, 2, 3, 4].forEach((pass) =>
      store.appendStep(podId, {
        at: `2026-10-01T09:0${pass}:00.000Z`,
        step: 'test',
        event: 'start',
        by: 'dev',
        pass,
        ticket: '3',
      })
    );

    runStep('test', 'start', { pod: podId }, root);

    expect(store.readSteps(podId).at(-1)).toMatchObject({
      step: 'test',
      event: 'start',
      pass: 1,
    });
    expect(store.readBuilding(podId).runs[1]).toMatchObject({
      step: 'test',
      attempt: 1,
    });
  });

  it('stamps the run it counted, even when the next ticket is picked up meanwhile', () => {
    const { store, root, podId } = buildingPodStore();
    process.env.LAMBDA_PODS_ROOT = store.root;
    store.writeBuilding(podId, {
      runs: [
        {
          id: '3',
          title: 'Trail markers',
          step: 'build',
          attempt: 1,
          startedAt: '2026-10-01T10:00:00.000Z',
          claim: 'claimed',
        },
      ],
      upNext: [],
    });
    // The runner blocks 3 and picks up 4 between the step's read and its write.
    jest.spyOn(context, 'openStore').mockReturnValue({
      ...store,
      appendStep: (id, step) => {
        const appended = store.appendStep(id, step);
        store.updateBuilding(id, (state) => ({
          ...state,
          runs: [
            ...state.runs.map((one) => ({
              ...one,
              blocked: {
                at: '2026-10-01T10:30:00.000Z',
                what: 'Ticket 3',
                problem: 'Stalled',
                options: '1. Retry',
                recommendation: '1',
              },
            })),
            {
              id: '4',
              title: 'Rink hours',
              step: 'pick-up',
              attempt: 1,
              startedAt: '2026-10-01T10:31:00.000Z',
              claim: 'claimed',
            },
          ],
        }));

        return appended;
      },
    });

    runStep('test', 'start', { pod: podId }, root);

    expect(
      store.readBuilding(podId).runs.map(({ id, step }) => ({ id, step }))
    ).toEqual([
      { id: '3', step: 'test' },
      { id: '4', step: 'pick-up' },
    ]);
  });
});
