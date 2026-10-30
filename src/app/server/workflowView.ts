import * as fs from 'fs';

import {
  type PodStore,
  type Question,
  type RenderMachine,
  type StageStatus,
  type StepEvent,
  type Turn,
  WRITES_TICKETS,
  type WorkflowStage,
  isIdle,
  podRenderMode,
  stagesFor,
  stepHistory,
  workflowStatus,
} from '../../pod-store';
import type {
  AgentState,
  TicketCell,
  TicketRow,
  TimeSummary,
  WorkflowView,
} from '../shared/types';

/**
 * The sidebar's workflow panel for one pod: every stage and step with where
 * the pod is (pod-store's workflowStatus), each step's history across ALL
 * pods (does it earn its place?), the owner's own time per stage, what each agent
 * is doing, and what the watchdog did.
 */

const agentState = (turn: Turn): AgentState =>
  isIdle(turn)
    ? { working: false, since: turn.endedAt }
    : { working: true, since: turn.startedAt };

/** The items the owner spends their time on in a stage. */
const stageQuestions = (
  stage: WorkflowStage,
  questions: Question[]
): Question[] =>
  questions.filter((question) =>
    stage.kind === 'checkpoint'
      ? question.kind === 'checkpoint' &&
        question.checkpoint?.cp === stage.checkpoint
      : question.kind !== 'checkpoint' &&
        question.phase === stage.phase &&
        // The UX review runs in phase 3 after CP3; its questions are split's.
        stage.id !== 'ux-review'
  );

/** One ticket's state in one stage, from the steps reported for it. */
const ticketCell = (stage: WorkflowStage, events: StepEvent[]): TicketCell => {
  const ids = new Set(stage.steps.map((step) => step.id));
  const mine = events.filter(
    (event) => ids.has(event.step) && event.event !== 'note'
  );
  const last = mine.at(-1);

  if (last === undefined) {
    return 'todo';
  }

  return last.event === 'start' ? 'now' : 'done';
};

/** The batch grid: a row per ticket, a cell per stage that has steps. */
const ticketRows = (
  tickets: string[],
  stages: WorkflowStage[],
  steps: StepEvent[]
): TicketRow[] =>
  tickets.map((id) => {
    const events = steps.filter((event) => event.ticket === id);

    return {
      id,
      cells: Object.fromEntries(
        stages
          .filter((stage) => stage.steps.length > 0)
          .map((stage) => [stage.id, ticketCell(stage, events)])
      ),
    };
  });

const yourMsOn = (
  time: TimeSummary,
  podId: string,
  questions: Question[]
): number =>
  questions.reduce(
    (sum, question) => sum + (time.pods[podId]?.items[question.id] ?? 0),
    0
  );

/**
 * `machine`: the `design` the pod's runner reports with its status (the
 * runner reads its own `~/.lambda/config.json`; this view never does).
 */
export const buildWorkflowView = (
  store: PodStore,
  podId: string,
  time: TimeSummary,
  machine: RenderMachine
): WorkflowView => {
  const pod = store.requirePod(podId);
  const steps = store.readSteps(podId);
  const questions = store.listQuestions(podId);
  const files = new Set(
    fs.existsSync(store.podDir(podId))
      ? fs.readdirSync(store.podDir(podId))
      : []
  );
  const statuses: StageStatus[] = workflowStatus({
    pod,
    questions,
    steps,
    files,
  });
  const allPods = store.listPodIds();
  const avgYourMs = (stage: WorkflowStage): number | undefined => {
    if (stage.kind !== 'checkpoint') {
      return undefined;
    }

    const spent = allPods
      .map((other) =>
        yourMsOn(time, other, stageQuestions(stage, store.listQuestions(other)))
      )
      .filter((ms) => ms > 0);

    return spent.length === 0
      ? undefined
      : spent.reduce((sum, ms) => sum + ms, 0) / spent.length;
  };

  return {
    stages: stagesFor(pod).map((stage, index) => ({
      stage,
      status: statuses[index] ?? { id: stage.id, state: 'todo', steps: [] },
      yourMs: yourMsOn(time, podId, stageQuestions(stage, questions)),
      avgYourMs: avgYourMs(stage),
    })),
    history: stepHistory(allPods.map((other) => store.readSteps(other))),
    agents: {
      manager: agentState(store.readTurn(podId, 'manager')),
      dev: agentState(store.readTurn(podId, 'dev')),
    },
    watchdog: steps
      .filter((event) => event.by === 'watchdog' && event.note !== undefined)
      .slice(-5)
      .map((event) => ({ at: event.at, note: event.note ?? '' })),
    requests: store.listRequests(podId),
    freeform: pod.mode === 'freeform',
    renderMode: podRenderMode(pod, machine),
    ...(machine.design === undefined
      ? {}
      : { designAvailable: machine.design.available }),
    confirmSkip: [...WRITES_TICKETS],
    ...(pod.source === 'batch'
      ? { tickets: ticketRows(pod.tickets ?? [], stagesFor(pod), steps) }
      : {}),
  };
};
