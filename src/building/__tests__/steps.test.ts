import * as fs from 'fs';
import * as path from 'path';

import { ticketTimeline } from '../../app/shared/buildTimeline';
import { stepToEvent } from '../../events/watcher';
import '../../pod/__tests__/podProject';
import { runStep } from '../../pod/steps';
import { buildingDetail } from '../../runner/podPage';
import { buildingPodStore } from './fakes';

const fail = (why: string): never => {
  throw new Error(why);
};

const withRun = () => {
  const { store, root, podId } = buildingPodStore();
  store.writeBuilding(podId, {
    runs: [
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
  fs.mkdirSync(path.join(root, '.lambda', 'building'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.lambda', 'building', 'workflow.json'),
    JSON.stringify({
      extends: 'standard',
      add: [
        {
          id: 'a11y-check',
          label: 'Accessibility check',
          run: '/a11y-check',
          after: 'test',
        },
      ],
    })
  );
  fs.writeFileSync(
    path.join(root, '.lambda', 'building', 'a11y-check.md'),
    '# Accessibility check\n'
  );
  process.env.LAMBDA_PODS_ROOT = store.root;

  return { store, root, podId };
};

afterEach(() => {
  delete process.env.LAMBDA_PODS_ROOT;
});

describe('lambda pod step on a building pod', () => {
  it('moves only the current run, never an earlier blocked run of the same ticket', () => {
    const { store, root, podId } = withRun();
    const blocked = {
      id: '3',
      title: 'Trail markers',
      step: 'test',
      attempt: 2,
      startedAt: '2026-10-01T09:00:00.000Z',
      claim: 'released' as const,
      blocked: {
        at: '2026-10-01T09:40:00.000Z',
        what: 'Ticket 3 stalled',
        problem: 'No progress on Test',
        options: '1. Set it back to Ready to retry',
        recommendation: '1',
      },
    };
    store.updateBuilding(podId, (state) => ({
      ...state,
      runs: [blocked, ...state.runs],
    }));

    runStep('build', 'start', { pod: podId }, root);

    const { runs } = store.readBuilding(podId);
    expect(runs[0]).toEqual(blocked);
    expect(runs[1]).toMatchObject({ step: 'build' });
  });

  it("accepts a step the codebase's workflow.json adds", () => {
    const { store, root, podId } = withRun();

    runStep('a11y-check', 'start', { pod: podId }, root);

    expect(store.readSteps(podId).at(-1)).toMatchObject({
      step: 'a11y-check',
      event: 'start',
      ticket: '3',
      pass: 1,
    });
    expect(store.readBuilding(podId).runs[0]?.step).toBe('a11y-check');
  });

  it('refuses a planning-only step', () => {
    const { store, root, podId } = withRun();

    expect(() => runStep('ux-sketch', 'start', { pod: podId }, root)).toThrow(
      /Unknown step "ux-sketch"/
    );
    expect(store.readSteps(podId)).toEqual([]);
  });

  it('counts a second start of a step for the same ticket as attempt 2', () => {
    const { store, root, podId } = withRun();

    runStep('test', 'start', { pod: podId }, root);
    runStep('test', 'done', { pod: podId }, root);
    runStep('test', 'start', { pod: podId }, root);

    expect(
      store.readSteps(podId).map((step) => [step.event, step.pass])
    ).toEqual([
      ['start', 1],
      ['done', 1],
      ['start', 2],
    ]);
    expect(store.readBuilding(podId).runs[0]).toMatchObject({
      step: 'test',
      attempt: 2,
    });
  });

  it('records a visual-check skip with its reason, which the events door and the rail carry', () => {
    const { store, root, podId } = withRun();

    runStep('visual-check', 'skip', { pod: podId, reason: 'no design' }, root);

    const step = store.readSteps(podId).at(-1);
    expect(step).toMatchObject({
      step: 'visual-check',
      event: 'skip',
      reason: 'no design',
      ticket: '3',
    });

    const event = stepToEvent(step ?? fail('no step was recorded'), podId);
    expect(event).toMatchObject({
      type: 'stage.end',
      name: 'visual-check',
      skipped: true,
      reason: 'no design',
      ticket: '3',
    });

    const timeline = ticketTimeline(
      [
        {
          type: event?.type ?? '',
          name: 'visual-check',
          ticket: '3',
          attempt: 1,
          pod: podId,
          result: null,
          at: Date.parse(step?.at ?? ''),
          skipped: true,
          skipReason: 'no design',
        },
      ],
      '3',
      [{ id: 'visual-check', label: 'Check against the design' }]
    );
    expect(timeline.steps[0]).toMatchObject({
      status: 'skipped',
      label: 'Visual check · skipped: no design',
    });
    // A skip moves no run onto the step.
    expect(store.readBuilding(podId).runs[0]?.step).toBe('pick-up');
  });

  it('refuses a visual-check skip with no --reason, writing nothing', () => {
    const { store, root, podId } = withRun();

    expect(() => runStep('visual-check', 'skip', { pod: podId }, root)).toThrow(
      /Skipping visual-check needs --reason/
    );
    expect(() =>
      runStep('visual-check', 'skip', { pod: podId, reason: '  ' }, root)
    ).toThrow(/Skipping visual-check needs --reason/);
    expect(store.readSteps(podId)).toEqual([]);
  });

  it('skips a switched-off visual-check as "switched off"', () => {
    const { store, root, podId } = withRun();
    fs.writeFileSync(
      path.join(root, '.lambda', 'building', 'workflow.json'),
      JSON.stringify({
        extends: 'standard',
        add: [
          {
            id: 'a11y-check',
            label: 'Accessibility check',
            run: '/a11y-check',
            after: 'test',
          },
        ],
        off: ['visual-check'],
      })
    );

    expect(() =>
      runStep('visual-check', 'start', { pod: podId }, root)
    ).toThrow(/Unknown step "visual-check"/);
    runStep(
      'visual-check',
      'skip',
      { pod: podId, reason: 'switched off' },
      root
    );

    const step = store.readSteps(podId).at(-1);
    expect(step).toMatchObject({ event: 'skip', reason: 'switched off' });

    // The rail, as the page builds it: the switched-off step is kept, marked
    // off, and gets its row from the skip the events door carries.
    const { steps } = buildingDetail({
      store,
      podId,
      projectRoot: root,
      windows: [],
      computer: "Leslie's Mac",
    });
    expect(steps.find((one) => one.id === 'visual-check')).toEqual({
      id: 'visual-check',
      label: 'Check against the design',
      off: true,
    });

    const event = stepToEvent(step ?? fail('no step was recorded'), podId);
    const timelineEvent = {
      type: event?.type ?? '',
      name: 'visual-check',
      ticket: '3',
      attempt: 1,
      pod: podId,
      result: null,
      at: Date.parse(step?.at ?? ''),
      skipped: event?.skipped,
      skipReason: event?.reason ?? null,
    };

    expect(
      ticketTimeline([timelineEvent], '3', steps).steps.find(
        (one) => one.id === 'visual-check'
      )
    ).toMatchObject({
      status: 'skipped',
      label: 'Visual check · skipped: switched off',
    });
    // A ticket that reported no skip has no row for a step that never runs.
    expect(
      ticketTimeline([], '3', steps).steps.map((one) => one.id)
    ).not.toContain('visual-check');
  });

  it('skips a ticket whose ## Design has no Scenario: line as "no scenario", recording no visual record', () => {
    const { store, root, podId } = withRun();

    runStep(
      'visual-check',
      'skip',
      { pod: podId, reason: 'no scenario' },
      root
    );

    expect(store.readSteps(podId).at(-1)).toMatchObject({
      reason: 'no scenario',
    });
    expect(
      fs.existsSync(path.join(root, '.lambda', 'verdicts', '3.visual.json'))
    ).toBe(false);
  });

  it('takes --reason with skip only', () => {
    const { root, podId } = withRun();

    expect(() =>
      runStep('build', 'start', { pod: podId, reason: 'why' }, root)
    ).toThrow('--reason goes with skip only.');
  });

  it('refuses with no ticket being built', () => {
    const { store, root, podId } = withRun();
    store.writeBuilding(podId, { runs: [], upNext: [] });

    expect(() => runStep('build', 'start', { pod: podId }, root)).toThrow(
      'No ticket is being built, so there is no step to report.'
    );
  });
});
