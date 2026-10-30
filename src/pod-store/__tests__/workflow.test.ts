import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadProcess } from '../../process/workflow-file';
import { type Pod, type Question, type StepEvent } from '../schemas';
import {
  type PodFacts,
  STANDARD_PLANNING,
  STEP_IDS,
  TRACKS,
  WORKFLOW,
  findStep,
  stagesFor,
  stepHistory,
  trackOf,
  workflowStatus,
} from '../workflow';

const pod = (overrides: Partial<Pod> = {}): Pod => ({
  id: 'pawnee-a1b2',
  slug: 'pawnee',
  createdAt: '2026-10-01T00:00:00.000Z',
  status: 'active',
  phase: 1,
  completedCheckpoints: [],
  worktreePath: '/tmp',
  ownsWorktree: true,
  managerCwd: '/tmp',
  devCwd: '/tmp',
  agentCommand: 'claude',
  sessions: { manager: 'm', dev: 'd' },
  ...overrides,
});

const checkpoint = (cp: number, status: Question['status']): Question => ({
  id: `q${cp}`,
  podId: 'pawnee-a1b2',
  kind: 'checkpoint',
  phase: 1,
  status,
  blocksCheckpoint: false,
  dependsOn: [],
  createdAt: `2026-10-0${cp}T10:00:00.000Z`,
  summary: `Checkpoint ${cp}.`,
  options: [],
  checkpoint: { cp, decisionIds: [] },
});

const at = (minute: number): string =>
  `2026-10-04T10:${String(minute).padStart(2, '0')}:00.000Z`;

const facts = (overrides: Partial<PodFacts> = {}): PodFacts => ({
  pod: pod(),
  questions: [],
  steps: [],
  files: new Set(),
  ...overrides,
});

const stateOf = (stages: ReturnType<typeof workflowStatus>) =>
  Object.fromEntries(stages.map((stage) => [stage.id, stage.state]));

describe('workflowStatus — where a pod is', () => {
  it('a new pod is shaping, everything else to come', () => {
    const states = stateOf(workflowStatus(facts()));

    expect(states.shape).toBe('now');
    expect(states.cp1).toBe('todo');
    expect(states.finish).toBe('todo');
  });

  it('a posted, open checkpoint is waiting on you', () => {
    const states = stateOf(
      workflowStatus(
        facts({
          pod: pod({ phase: 1 }),
          questions: [checkpoint(1, 'open')],
          files: new Set(['intent.md']),
        })
      )
    );

    // Posting CP1 ends Shape; from then on the pod waits on you.
    expect(states.shape).toBe('done');
    expect(states.cp1).toBe('waiting-you');
    expect(states['epic-review']).toBe('todo');
  });

  it('after CP3 the pod is in the UX review, still phase 3', () => {
    const states = stateOf(
      workflowStatus(
        facts({
          pod: pod({ phase: 3, completedCheckpoints: [1, 2, 3] }),
          steps: [{ at: at(1), step: 'ux-surfaces', event: 'start' }],
        })
      )
    );

    expect(states.research).toBe('done');
    expect(states.tickets).toBe('done');
    expect(states.cp3).toBe('done');
    expect(states['ux-review']).toBe('now');
    expect(states.cp4).toBe('todo');
  });

  it('CP4 waits on you once the UX review is posted', () => {
    const stages = workflowStatus(
      facts({
        pod: pod({ phase: 3, completedCheckpoints: [1, 2, 3] }),
        questions: [checkpoint(4, 'open')],
        steps: [
          { at: at(1), step: 'ux-surfaces', event: 'done' },
          { at: at(2), step: 'ux-cold-read', event: 'done' },
          { at: at(3), step: 'cp4-post', event: 'done' },
        ],
      })
    );

    expect(stateOf(stages)['ux-review']).toBe('done');
    expect(stateOf(stages).cp4).toBe('waiting-you');
    expect(
      stages
        .find((stage) => stage.id === 'ux-review')
        ?.steps.map((step) => step.state)
    ).toEqual(['done', 'done', 'done']);
  });

  it('fill has no checkpoint: it is over when the phase moves on', () => {
    const states = stateOf(
      workflowStatus(
        facts({ pod: pod({ phase: 5, completedCheckpoints: [1, 2, 3, 4] }) })
      )
    );

    expect(states.fill).toBe('done');
    expect(states.reconcile).toBe('now');
  });

  it('reads passes, progress and findings from the step log', () => {
    const steps: StepEvent[] = [
      { at: at(1), step: 'tickets-red-flags', event: 'start', pass: 1 },
      {
        at: at(9),
        step: 'tickets-red-flags',
        event: 'done',
        pass: 1,
        found: 4,
      },
      { at: at(10), step: 'tickets-red-flags', event: 'start', pass: 2 },
      { at: at(11), step: 'tickets-red-flags', event: 'note', progress: '3/9' },
    ];
    const tickets = workflowStatus(
      facts({ pod: pod({ phase: 3, completedCheckpoints: [1, 2, 3] }), steps })
    ).find((stage) => stage.id === 'tickets');
    const redFlags = tickets?.steps.find(
      (step) => step.id === 'tickets-red-flags'
    );

    expect(redFlags?.state).toBe('now');
    expect(redFlags?.tracked).toBe(true);
    expect(redFlags?.passes.map((run) => run.pass)).toEqual([1, 2]);
    expect(redFlags?.progress).toBe('3/9');
    expect(redFlags?.found).toBe(4);
  });

  it('infers untracked steps of finished stages as done (older pods)', () => {
    const shape = workflowStatus(
      facts({ pod: pod({ phase: 2, completedCheckpoints: [1] }) })
    ).find((stage) => stage.id === 'shape');

    expect(shape?.steps.every((step) => step.state === 'done')).toBe(true);
    expect(shape?.steps.every((step) => !step.tracked)).toBe(true);
  });
});

describe('the tracks (pipeline 2)', () => {
  const ids = (pod: Pod) => stagesFor(pod).map((stage) => stage.id);

  it('an existing epic or lone ticket has no CP1 or CP2', () => {
    const existing = ids({ ...pod(), pipeline: 2, source: 'epic' });

    expect(existing).not.toContain('cp1');
    expect(existing).not.toContain('cp2');
    expect(existing).toEqual([
      'shape',
      'epic-review',
      'research',
      'cp3',
      'tickets',
      'ux-review',
      'cp4',
      'fill',
      'reconcile',
      'cp5',
      'finish',
    ]);
    expect(trackOf({ ...pod(), pipeline: 2, source: 'ticket' })).toBe(
      'existing'
    );
  });

  it('a new idea keeps CP1 and CP2, then the split proposal replaces the old split', () => {
    const idea = ids({ ...pod(), pipeline: 2, source: 'idea' });

    expect(idea.slice(0, 7)).toEqual([
      'shape',
      'cp1',
      'epic-review',
      'cp2',
      'research',
      'cp3',
      'tickets',
    ]);
    expect(idea).not.toContain('split');
  });

  it('a pod with no pipeline is on the idea track', () => {
    expect(trackOf(pod())).toBe('idea');
    expect(ids(pod())).toEqual(ids({ ...pod(), pipeline: 2, source: 'idea' }));
    expect(ids(pod())).not.toContain('split');
  });

  it('an existing epic moves from review to research with no checkpoint between', () => {
    const states = stateOf(
      workflowStatus(
        facts({
          pod: { ...pod(), pipeline: 2, source: 'epic', phase: 3 },
          steps: [{ at: at(1), step: 'research', event: 'start' }],
        })
      )
    );

    expect(states.shape).toBe('done');
    expect(states['epic-review']).toBe('done');
    expect(states.research).toBe('now');
  });

  it('skipping the split proposal skips CP3, and the tickets come next', () => {
    const states = stateOf(
      workflowStatus(
        facts({
          pod: { ...pod(), pipeline: 2, source: 'epic', phase: 3 },
          steps: [
            { at: at(0), step: 'verify-premise', event: 'done' },
            { at: at(0), step: 'research', event: 'start' },
            { at: at(1), step: 'research', event: 'done' },
            { at: at(2), step: 'duplicate-check', event: 'done' },
            {
              at: at(3),
              step: 'duplicate-check',
              event: 'note',
              note: 'Nothing in the tracker overlaps the park map.',
            },
            { at: at(4), step: 'split-proposal', event: 'skip' },
            { at: at(4), step: 'proposal-red-flags', event: 'skip' },
            { at: at(4), step: 'proposal-cold-read', event: 'skip' },
            { at: at(4), step: 'proposal-post', event: 'skip' },
          ],
        })
      )
    );

    expect(states.research).toBe('done');
    expect(states.cp3).toBe('skipped');
    expect(states.tickets).toBe('now');
  });

  it('a posted split proposal waits on the owner', () => {
    const states = stateOf(
      workflowStatus(
        facts({
          pod: {
            ...pod(),
            pipeline: 2,
            source: 'idea',
            phase: 3,
            completedCheckpoints: [1, 2],
          },
          questions: [
            checkpoint(1, 'answered'),
            checkpoint(2, 'answered'),
            checkpoint(3, 'open'),
          ],
        })
      )
    );

    expect(states.research).toBe('done');
    expect(states.cp3).toBe('waiting-you');
    expect(states.tickets).toBe('todo');
  });

  it('a lone ticket with nothing visible skips the UX review and CP4', () => {
    const states = stateOf(
      workflowStatus(
        facts({
          pod: { ...pod(), pipeline: 2, source: 'ticket', phase: 4 },
          steps: [
            { at: at(1), step: 'ux-surfaces', event: 'skip' },
            { at: at(1), step: 'ux-cold-read', event: 'skip' },
            { at: at(1), step: 'cp4-post', event: 'skip' },
          ],
        })
      )
    );

    expect(states['ux-review']).toBe('done');
    expect(states.cp4).toBe('skipped');
    expect(states.fill).toBe('now');
  });

  it('the tickets stage is over once the UX review has begun (both are phase 3)', () => {
    const states = stateOf(
      workflowStatus(
        facts({
          pod: { ...pod(), pipeline: 2, source: 'epic', phase: 3 },
          steps: [
            { at: at(1), step: 'split-proposal', event: 'skip' },
            { at: at(2), step: 'write-tickets', event: 'done' },
            { at: at(3), step: 'ux-surfaces', event: 'start' },
          ],
        })
      )
    );

    expect(states.tickets).toBe('done');
    expect(states['ux-review']).toBe('now');
  });
});

describe('stepHistory — does a step earn its place?', () => {
  it('counts runs, average time and passes that found nothing, across pods', () => {
    const pawnee: StepEvent[] = [
      { at: at(0), step: 'epic-red-flags', event: 'start', pass: 1 },
      { at: at(10), step: 'epic-red-flags', event: 'done', pass: 1, found: 2 },
      { at: at(10), step: 'epic-red-flags', event: 'start', pass: 2 },
      { at: at(14), step: 'epic-red-flags', event: 'done', pass: 2, found: 0 },
    ];
    const eagleton: StepEvent[] = [
      { at: at(0), step: 'epic-red-flags', event: 'start', pass: 1 },
      { at: at(6), step: 'epic-red-flags', event: 'done', pass: 1, found: 0 },
    ];
    const history = stepHistory([pawnee, eagleton])['epic-red-flags'];

    expect(history).toEqual({
      runs: 3,
      pods: 2,
      avgMs: (10 + 4 + 6) * 20_000,
      avgFound: 2 / 3,
      foundNothing: 2,
      reportedFound: 3,
    });
  });
});

describe('Finish', () => {
  it.each(TRACKS)(
    'has exactly finish-ready, then finish-links, on the %s track',
    (track) => {
      const finish = STANDARD_PLANNING[track].filter(
        (stage) => stage.id === 'finish'
      );

      expect(finish.map((stage) => stage.steps.map((step) => step.id))).toEqual(
        [['finish-ready', 'finish-links']]
      );
    }
  );
});

describe('the workflow step ids', () => {
  it('step ids are unique', () => {
    expect(new Set(STEP_IDS).size).toBe(STEP_IDS.length);
  });

  it('stage ids are unique within a track', () => {
    (['idea', 'existing', 'batch'] as const).forEach((track) => {
      const ids = STANDARD_PLANNING[track].map((stage) => stage.id);

      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  it('no step runs twice on one track', () => {
    (['idea', 'existing', 'batch'] as const).forEach((track) => {
      const ids = STANDARD_PLANNING[track].flatMap((stage) =>
        stage.steps.map((step) => step.id)
      );

      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  it('only the listed steps run a command', () => {
    expect(
      Object.fromEntries(
        STEP_IDS.flatMap((id) => {
          const command = findStep(id)?.command;

          return command === undefined ? [] : [[id, command]];
        })
      )
    ).toEqual({
      'epic-red-flags': 'red-flags',
      'proposal-red-flags': 'red-flags',
      'tickets-red-flags': 'red-flags',
      'split-tickets': 'split-ticket',
      'ux-sketch': 'ux-sketch',
      'review-tickets': 'review-ticket',
      'reconcile-tickets': 'reconcile-tickets',
    });
  });

  it('locks the cold reads, every checkpoint post and every checkpoint', () => {
    expect(STEP_IDS.filter((id) => findStep(id)?.locked === true)).toEqual([
      'cp1-post',
      'cp2-post',
      'cp2-post-triage',
      'proposal-cold-read',
      'proposal-post',
      'ux-cold-read',
      'cp4-post',
      'cp5-post',
    ]);
    expect(
      WORKFLOW.filter((stage) => stage.kind === 'checkpoint').every(
        (stage) => stage.locked === true
      )
    ).toBe(true);
  });
});

describe('the workflow and the instructions agree', () => {
  const podPhase = fs.readFileSync(
    path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'instructions',
      'planning',
      'pod-phase.md'
    ),
    'utf8'
  );

  it('every dev step is reported by pod-phase with `lambda pod step <id>`', () => {
    const devSteps = WORKFLOW.flatMap((stage) => stage.steps).filter(
      (step) => step.who === 'dev'
    );
    const missing = devSteps
      .map((step) => step.id)
      .filter((id) => !podPhase.includes(`lambda pod step ${id} `));

    expect(missing).toEqual([]);
  });

  it('pod-phase reports no step the workflow does not know', () => {
    const reported = Array.from(
      podPhase.matchAll(/lambda pod step ([a-z0-9-]+) /g),
      (match) => match[1]
    );

    expect(reported.filter((id) => !STEP_IDS.includes(id ?? ''))).toEqual([]);
  });
});

describe('batches, freeform pods and the stages the owner skips', () => {
  const batch = (overrides: Partial<Pod> = {}): Pod =>
    pod({
      pipeline: 2,
      source: 'batch',
      tickets: ['PAWNEE-84', 'PAWNEE-83'],
      ...overrides,
    });

  it('a batch triages at CP2 and has no CP1, epic review or split proposal', () => {
    const ids = stagesFor(batch()).map((stage) => stage.id);

    expect(trackOf(batch())).toBe('batch');
    expect(ids).toEqual([
      'shape',
      'triage',
      'cp2',
      'apply-triage',
      'research',
      'cp3',
      'tickets',
      'ux-review',
      'cp4',
      'fill',
      'reconcile',
      'cp5',
      'finish',
    ]);
    expect(
      stagesFor(batch())
        .find((stage) => stage.id === 'tickets')
        ?.steps.map((step) => step.id)
    ).toContain('cross-ticket');
  });

  it('the batch skips CP3 the way a lone ticket does — the dev skips the split proposal', () => {
    const state = stateOf(
      workflowStatus(
        facts({
          pod: batch({ phase: 3, completedCheckpoints: [2] }),
          steps: [{ at: at(1), step: 'split-proposal', event: 'skip' }],
        })
      )
    );

    expect(state.cp3).toBe('skipped');
  });

  it('a freeform pod has no stages until the owner switches it', () => {
    expect(stagesFor(pod({ pipeline: 2, mode: 'freeform' }))).toEqual([]);
    expect(
      stagesFor(pod({ pipeline: 2, mode: 'structured' })).length
    ).toBeGreaterThan(0);
  });

  it('a stage the owner skipped shows as skipped, and a skipped checkpoint lets the pod past it', () => {
    const state = stateOf(
      workflowStatus(
        facts({
          pod: batch({ phase: 2, skipped: ['triage', 'cp2'] }),
          steps: [
            { at: at(1), step: 'intent', event: 'done' },
            { at: at(2), step: 'epic', event: 'done' },
          ],
        })
      )
    );

    expect(state.triage).toBe('skipped');
    expect(
      stateOf(
        workflowStatus(
          facts({ pod: pod({ pipeline: 2, phase: 3, skipped: ['research'] }) })
        )
      ).cp3
    ).toBe('skipped');
    expect(state.cp2).toBe('skipped');
    expect(state['apply-triage']).toBe('now');
  });
});

describe("a project's own process", () => {
  /** The idea track of a project that adds a11y-check at the end of fill. */
  const resolved = (off: string[] = []) => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-pod-process-'))
    );
    const dir = path.join(root, '.lambda', 'planning');

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a11y-check.md'), 'Check it.\n');
    fs.writeFileSync(
      path.join(dir, 'workflow.json'),
      JSON.stringify({
        extends: 'standard',
        add: [
          {
            id: 'a11y-check',
            label: 'Accessibility check',
            run: '/a11y-check {tickets}',
            after: 'fill-answered',
            switch: true,
          },
        ],
        off,
      })
    );

    return loadProcess(root, 'planning').tracks;
  };
  const fillReported: StepEvent[] = [
    'e2e-plans',
    'review-tickets',
    'fill-answered',
  ].map((step, index) => ({ at: at(index + 1), step, event: 'done' }));
  const inFill = pod({ phase: 4, completedCheckpoints: [1, 2, 3, 4] });

  it("an added step is one of its stage's steps, and fill waits for it", () => {
    const stages = workflowStatus(
      facts({ pod: inFill, steps: fillReported, process: resolved() })
    );
    const fill = stages.find((stage) => stage.id === 'fill');

    expect(stagesFor(inFill, resolved()).map((stage) => stage.id)).toContain(
      'fill'
    );
    expect(fill?.steps.map((step) => step.id)).toEqual([
      'e2e-plans',
      'review-tickets',
      'fill-answered',
      'a11y-check',
    ]);
    expect(fill?.state).toBe('now');
  });

  it('a switched-off step is left out, and fill is over without it', () => {
    const stages = workflowStatus(
      facts({
        pod: inFill,
        steps: fillReported,
        process: resolved(['a11y-check']),
      })
    );
    const states = stateOf(stages);

    expect(
      stages.find((stage) => stage.id === 'fill')?.steps.map((step) => step.id)
    ).toEqual(['e2e-plans', 'review-tickets', 'fill-answered']);
    expect(states.fill).toBe('done');
    expect(states.reconcile).toBe('now');
  });

  it('the checkpoint after a skipped stage is skipped there too', () => {
    const states = stateOf(
      workflowStatus(
        facts({
          pod: pod({
            phase: 3,
            completedCheckpoints: [1, 2, 3],
            skipped: ['ux-review'],
          }),
          process: resolved(['a11y-check']),
        })
      )
    );

    expect(states['ux-review']).toBe('skipped');
    expect(states.cp4).toBe('skipped');
  });
});
