import { currentRun } from '../app/shared/building';
import { allBuildingSteps, buildingSteps } from '../building/workflow';
import {
  type PodStore,
  STANDARD_PLANNING,
  STEP_IDS,
  nowIso,
  podKindOf,
} from '../pod-store';
import { type ResolvedStep, loadProcess } from '../process/workflow-file';
import { instructionsProject } from './base';
import { callerAgent, openStore, resolvePodId } from './context';

/**
 * `lambda pod step <id> start|done|skip|note` — the dev reports where it is in
 * the workflow, so the workflow panel can show the exact step ("tickets red
 * flags, pass 2, 3/9") and each step's history (time, what it found).
 *
 * Step ids come from the project's own planning process (the standard one,
 * patched by `.lambda/planning/workflow.json`): a step it adds is accepted,
 * and one it drops is refused.
 */

const EVENTS = ['start', 'done', 'skip', 'note'] as const;
type StepEventName = (typeof EVENTS)[number];

const isEventName = (value: string): value is StepEventName =>
  EVENTS.some((event) => event === value);

const positiveInt = (value: string | undefined, flag: string) => {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a whole number (got "${value}").`);
  }

  return parsed;
};

/**
 * Every step the project's planning process has, in order, each once: the
 * resolved tracks' steps, then the standard steps no track places (no
 * workflow.json can drop those).
 */
export const projectSteps = (projectRoot: string): ResolvedStep[] => {
  const steps = Object.values(loadProcess(projectRoot, 'planning').tracks)
    .flat()
    .flatMap((stage) => stage.steps);
  const placed = new Set(
    Object.values(STANDARD_PLANNING)
      .flat()
      .flatMap((stage) => stage.steps.map((step) => step.id))
  );
  const unplaced = STEP_IDS.filter((id) => !placed.has(id)).map(
    (id): ResolvedStep => ({ id, label: id, who: 'dev', tip: '', doneWhen: '' })
  );

  return Array.from(
    new Map(
      [...steps, ...unplaced].map((step) => [step.id, step] as const)
    ).values()
  );
};

/** Steps a building pod can't skip without saying why (the rail shows it). */
const SKIP_NEEDS_REASON = ['visual-check', 'design-check'];

/**
 * A building pod's step, from the Engineering manager: checked against the
 * project's building process, tagged with the ticket being built, and with
 * its attempt — the nth `start` of a step in this run of the ticket is
 * attempt n. A step switched off can still be reported skipped ("switched
 * off"), so the rail says why it never ran.
 * The runner turns these lines into `stage.start`/`stage.end` events, a skip
 * into a `stage.end` with `skipped` and its reason.
 */
const runBuildingStep = (
  store: PodStore,
  podId: string,
  stepId: string,
  eventName: string,
  options: { note?: string; reason?: string },
  projectRoot: string
): void => {
  const steps =
    eventName === 'skip'
      ? allBuildingSteps(projectRoot)
      : buildingSteps(projectRoot);

  if (!steps.some((step) => step.id === stepId)) {
    throw new Error(
      `Unknown step "${stepId}". Steps: ${steps
        .map((step) => step.id)
        .join(', ')}.`
    );
  }

  if (!isEventName(eventName)) {
    throw new Error(
      `Unknown event "${eventName}" — use one of: ${EVENTS.join(', ')}.`
    );
  }

  const reason = options.reason?.trim();

  if (reason !== undefined && eventName !== 'skip') {
    throw new Error('--reason goes with skip only.');
  }

  if (
    eventName === 'skip' &&
    SKIP_NEEDS_REASON.includes(stepId) &&
    (reason === undefined || reason === '')
  ) {
    throw new Error(
      `Skipping ${stepId} needs --reason "<why>" (no design, no photo hook, switched off or no scenario).`
    );
  }

  const run = currentRun(store.readBuilding(podId));

  if (run === null) {
    throw new Error('No ticket is being built, so there is no step to report.');
  }

  // Only this run's starts: a ticket blocked and set back to Ready keeps its
  // id, and its new run gets a fresh retry budget.
  const runStart = Date.parse(run.startedAt);
  const starts = store
    .readSteps(podId)
    .filter(
      (step) =>
        step.ticket === run.id &&
        step.step === stepId &&
        step.event === 'start' &&
        Date.parse(step.at) >= runStart
    ).length;
  const attempt = eventName === 'start' ? starts + 1 : Math.max(starts, 1);

  store.appendStep(podId, {
    at: nowIso(),
    step: stepId,
    event: eventName,
    by: callerAgent(),
    pass: attempt,
    note: options.note,
    ticket: run.id,
    ...(reason === undefined || reason === '' ? {} : { reason }),
  });

  if (eventName === 'start') {
    // Only the run counted above, matched by its start: a ticket blocked and
    // set back to Ready has an earlier run with the same id, which keeps
    // where it stalled, and the runner may pick up the next one meanwhile.
    store.updateBuilding(podId, (state) => ({
      ...state,
      runs: state.runs.map((one) =>
        one.id === run.id && one.startedAt === run.startedAt
          ? { ...one, step: stepId, attempt }
          : one
      ),
    }));
  }

  console.log(
    `${stepId} ${eventName} for ${run.id}${
      attempt > 1 ? ` (attempt ${attempt})` : ''
    }${reason === undefined || reason === '' ? '' : `: ${reason}`}.`
  );
};

export const runStep = (
  stepId: string,
  eventName: string,
  options: {
    pod?: string;
    pass?: string;
    progress?: string;
    found?: string;
    note?: string;
    ticket?: string;
    reason?: string;
  },
  /** Default: where the pod's own commands come from, so the two agree. */
  projectRoot?: string
): void => {
  const podId = resolvePodId(options.pod);
  const store = openStore();
  const pod = store.requirePod(podId);

  if (podKindOf(pod) === 'building') {
    runBuildingStep(
      store,
      podId,
      stepId,
      eventName,
      options,
      projectRoot ?? pod.devCwd
    );

    return;
  }

  const steps = projectSteps(
    projectRoot ?? instructionsProject(store.requirePod(podId))
  );
  const step = steps.find((candidate) => candidate.id === stepId);

  if (step === undefined) {
    throw new Error(
      `Unknown step "${stepId}". Steps: ${steps
        .map((candidate) => candidate.id)
        .join(', ')}.`
    );
  }

  if (!isEventName(eventName)) {
    throw new Error(
      `Unknown event "${eventName}" — use one of: ${EVENTS.join(', ')}.`
    );
  }

  if (options.reason !== undefined) {
    throw new Error("--reason goes with a building pod's skip only.");
  }

  const pass = positiveInt(options.pass, '--pass');

  if (pass === 0) {
    throw new Error('--pass starts at 1.');
  }

  if (pass !== undefined && step.maxPasses === undefined) {
    throw new Error(`${stepId} is not a repeated step; drop --pass.`);
  }

  if (
    pass !== undefined &&
    step.maxPasses !== undefined &&
    pass > step.maxPasses
  ) {
    throw new Error(
      `${stepId} runs at most ${step.maxPasses} passes (got --pass ${pass}).`
    );
  }

  if (options.progress !== undefined && !/^\d+\/\d+$/.test(options.progress)) {
    throw new Error('--progress looks like 7/11 (done/total).');
  }

  const found = positiveInt(options.found, '--found');

  // A pass that ends must say what it found: "found nothing" is how a step
  // shows it no longer earns its place.
  if (
    eventName === 'done' &&
    step.maxPasses !== undefined &&
    found === undefined
  ) {
    throw new Error(
      `${stepId} is a repeated step: pass --found <n> (fixes plus questions this pass produced; 0 if none).`
    );
  }

  // A post step is done once its checkpoint is posted: `done` after a refused
  // post must not record a checkpoint as posted when nothing was.
  const posts = /^cp(\d)-post$/.exec(stepId)?.[1];

  if (
    eventName === 'done' &&
    posts !== undefined &&
    !store
      .listQuestions(podId)
      .some((question) => question.checkpoint?.cp === Number(posts))
  ) {
    throw new Error(
      `Checkpoint ${posts} isn't posted yet: post it with \`lambda pod checkpoint post --cp ${posts}\`, then mark ${stepId} done.`
    );
  }

  store.appendStep(podId, {
    at: nowIso(),
    step: stepId,
    event: eventName,
    by: callerAgent(),
    pass,
    progress: options.progress,
    found,
    note: options.note,
    ticket: options.ticket?.trim(),
  });
  console.log(
    `${stepId} ${eventName}${pass === undefined ? '' : ` (pass ${pass})`}.`
  );
};
