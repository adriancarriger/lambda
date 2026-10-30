import type { Pod, Question, StepEvent } from './schemas';

/**
 * Lambda's standard planning process, as data: every stage and step a pod
 * goes through, who runs it, what happens and what "done" means. The inbox
 * app's workflow panel renders it and `lambda pod step` validates step ids
 * against it. A project changes it from `.lambda/planning/workflow.json`
 * (`src/process/workflow-file.ts`), never by copying it.
 *
 * Three tracks share most steps:
 *   - `idea`: a new idea — CP1 (the plan) and CP2 (the reviewed epic), then
 *     research and the split proposal (CP3), the tickets, the UX review (CP4),
 *     Fill, Reconcile and the final check (CP5).
 *   - `existing`: an existing epic or a lone ticket — no CP1/CP2 (the epic is
 *     already the owner's); the split proposal only when an epic has no children.
 *   - `batch`: several tickets planned together, usually unrelated bugs —
 *     the `existing` flow per ticket, after a triage (CP2) that sorts out the
 *     duplicates, the already-fixed and the too-big first, plus one
 *     cross-ticket pass. One CP4 and one CP5 for the whole batch.
 *
 * A pod with no `pipeline` reads as `idea`. A `freeform` pod (`pod.mode`) has
 * no stages until the owner switches it to the structured flow. Stages the
 * owner skips (`pod.skipped`) show as skipped.
 *
 * Flags are data on each step: `locked` steps (Lambda's quality steps) can't
 * be dropped, moved, switched off or replaced; `optional` ones can be
 * switched off; `command` names the slash command a step runs, so one
 * replacement file covers every step that runs it.
 */

export type Who = 'dev' | 'manager' | 'qa' | 'you' | 'app';
export type Track = 'idea' | 'existing' | 'batch';

export const TRACKS: Track[] = ['idea', 'existing', 'batch'];

export interface WorkflowStep {
  id: string;
  label: string;
  who: Who;
  /** What happens, in plain words (the tooltip). */
  tip: string;
  doneWhen: string;
  /** Repeated up to this many times; stops early when a pass finds nothing. */
  maxPasses?: number;
  /** The slash command this step runs (its instructions' file name). */
  command?: string;
  /** One of Lambda's quality steps: can't be dropped, moved, off or replaced. */
  locked?: boolean;
  /**
   * Can't be dropped, moved or switched off, and nothing goes between it and
   * the step after it; unlike a locked step, its instructions can be replaced.
   */
  required?: boolean;
  /** Can be switched off. */
  optional?: boolean;
  /**
   * An optional step that starts off: a project switches it on (its
   * workflow.json `on`).
   */
  offByDefault?: boolean;
  /** Switched off for this project (only in a resolved process). */
  off?: boolean;
}

export interface WorkflowStage {
  id: string;
  label: string;
  kind: 'phase' | 'checkpoint' | 'finish';
  /** The pod phase this stage runs in (`pod.phase`). */
  phase: number;
  /** For checkpoint stages: which checkpoint. */
  checkpoint?: number;
  who: Who;
  tip: string;
  steps: WorkflowStep[];
  tracks: Track[];
  /** A checkpoint stage: the owner's approval can't be dropped. */
  locked?: boolean;
}

const ALL: Track[] = TRACKS;
/** Tracks that plan tickets which already exist. */
const EXISTING: Track[] = ['existing', 'batch'];

// ── steps (each defined once; stages share them) ───────────────────────────

const postCheckpoint = (cp: number, what: string): WorkflowStep => ({
  id: `cp${cp}-post`,
  label: `Post CP${cp}`,
  who: 'dev',
  tip: `The dev posts checkpoint ${cp} to your inbox: ${what}. Only once none of this stage's questions are still open.`,
  doneWhen: `Checkpoint ${cp} is in your inbox.`,
  locked: true,
});

const STEPS = {
  intent: {
    id: 'intent',
    label: 'Write intent.md',
    who: 'dev',
    tip: "Your words verbatim first (or the epic's Intent, quoted), then the principles the dev derives from them. Every later step is checked against this.",
    doneWhen: 'intent.md exists in the pod directory.',
  },
  epic: {
    id: 'epic',
    label: 'Create or read the epic',
    who: 'dev',
    tip: 'A new idea gets an epic ticket opening with your Intent; an existing epic (with its children) or a lone ticket is read and recorded on the pod.',
    doneWhen: 'The pod has its epic or ticket id (lambda pod status shows it).',
  },
  cp1Post: postCheckpoint(
    1,
    'the plan as one paragraph, plus one line per child ticket'
  ),
  epicRedFlags: {
    id: 'epic-red-flags',
    label: 'Red flags on the epic',
    who: 'dev',
    tip: '/red-flags on the epic (or the lone ticket), fresh each pass. Engineering findings are fixed and logged as decisions; judgement calls become questions for you.',
    doneWhen: 'A pass finds nothing, or 2 passes have run.',
    maxPasses: 2,
    command: 'red-flags',
  },
  cp2Post: postCheckpoint(2, 'what the review changed and decided'),
  triage: {
    id: 'triage',
    label: 'Triage each ticket',
    who: 'dev',
    tip: 'Each ticket is read against the code (nothing is run) and gets a proposal: plan it, looks already fixed (with the evidence), a duplicate to merge, or too big (its own pod or an epic). Nothing is closed or deleted until you accept its row.',
    doneWhen: 'Every ticket has a proposal.',
  },
  cp2PostTriage: {
    id: 'cp2-post-triage',
    label: 'Post CP2',
    who: 'dev',
    tip: 'The dev posts the triage to your inbox: one row per ticket with its proposal and why.',
    doneWhen: 'Checkpoint 2 is in your inbox.',
    locked: true,
  },
  applyTriage: {
    id: 'apply-triage',
    label: 'Apply the triage',
    who: 'dev',
    tip: 'What you accepted is done: duplicates merged (the merged-away ticket deleted, with the reason on the survivor) and tickets pulled out of the batch. "Already fixed" tickets are left for you to close yourself.',
    doneWhen: 'The pod lists only the tickets still being planned.',
  },
  crossTicket: {
    id: 'cross-ticket',
    label: 'Across the batch',
    who: 'dev',
    tip: 'One pass across every ticket: causes they share (fixed once, the others point to it), files several touch (a suggested build order and conflict notes), and E2E specs they can share.',
    doneWhen: 'Every ticket names what it shares with the others, or nothing.',
  },
  // On no track, but kept as a standard step (`split-tickets` → `/split-ticket`).
  splitTickets: {
    id: 'split-tickets',
    label: 'Split into tickets',
    who: 'dev',
    tip: '/split-ticket: numbered child tickets in build order ("1 - …"), each sized for one dev session. Skipped when the epic already has children.',
    doneWhen: 'Every child exists, numbered, in planning.',
    command: 'split-ticket',
  },
  uxSketch: {
    id: 'ux-sketch',
    label: 'UX sketch per ticket',
    who: 'dev',
    tip: '/ux-sketch: every ticket gets a ## UX section at the top — what the people using the product see.',
    doneWhen: 'Every ticket has a ## UX section.',
    command: 'ux-sketch',
    optional: true,
  },
  ticketsRedFlags: {
    id: 'tickets-red-flags',
    label: 'Red flags across tickets',
    who: 'dev',
    tip: '/red-flags across ALL tickets at once, so contradictions between them count. Same rules as the epic review.',
    doneWhen: 'A pass finds nothing in any ticket, or 3 passes have run.',
    maxPasses: 3,
    command: 'red-flags',
  },
  verifyPremise: {
    id: 'verify-premise',
    label: 'Check it still holds',
    who: 'dev',
    tip: "Before anything else, the ticket's claims are checked against today's code — by reading only, never running tests. A ticket can be stale or already fixed; then you get one question: close it, or rescope it?",
    doneWhen:
      'Every claim the ticket makes is confirmed, corrected, or raised with you.',
  },
  research: {
    id: 'research',
    label: 'Deep research',
    who: 'dev',
    tip: 'Subagents map the code the work touches — files, existing patterns, the E2E specs that cover it — so every proposed ticket is grounded in the codebase, not guessed.',
    doneWhen: 'Every area the work touches is mapped, with file references.',
    optional: true,
  },
  duplicateCheck: {
    id: 'duplicate-check',
    label: 'Duplicate check',
    who: 'dev',
    tip: 'The tracker (open bugs, open epics, planned work) is searched for anything this overlaps or should fold in.',
    doneWhen: 'Every overlap is listed (or none found).',
    optional: true,
  },
  splitProposal: {
    id: 'split-proposal',
    label: 'Draft the split proposal',
    who: 'dev',
    tip: 'Numbered tickets in build order, each with what changes, the files it touches and its E2E impact (new spec file, new tests, assertions only). A lone ticket gets one too: you accept the split (it becomes an epic) or keep it one ticket. Skipped when the epic already has children, or a lone ticket has nothing to split.',
    doneWhen: 'Every proposed ticket is written up.',
  },
  proposalRedFlags: {
    id: 'proposal-red-flags',
    label: 'Red flags on the proposal',
    who: 'dev',
    tip: '/red-flags on the proposal itself — cheap, since nothing is written yet. Fixes go into the proposal; judgement calls become questions.',
    doneWhen: 'A pass finds nothing, or 2 passes have run.',
    maxPasses: 2,
    command: 'red-flags',
  },
  proposalColdRead: {
    id: 'proposal-cold-read',
    label: 'Cold read',
    who: 'dev',
    tip: 'A fresh subagent reads each ticket\'s title and "what" alone and says what it will change; anything unclear is rewritten.',
    doneWhen: 'Every ticket reads clearly cold.',
    locked: true,
  },
  cp3Post: {
    ...postCheckpoint(
      3,
      'the split proposal — tickets, E2E structure and how many new spec files'
    ),
    id: 'proposal-post',
    label: 'Post the split proposal',
  },
  writeTickets: {
    id: 'write-tickets',
    label: 'Write the tickets',
    who: 'dev',
    tip: "The approved proposal becomes numbered tickets (an existing epic's children are adopted and brought up to the template instead; a lone ticket you kept whole is brought up to it). Each carries its E2E line.",
    doneWhen:
      'Every ticket exists, numbered, in planning, matching the proposal.',
  },
  uxSurfaces: {
    id: 'ux-surfaces',
    label: 'List every surface',
    who: 'dev',
    tip: 'One entry per screen, dialog, email or message the tickets change, with what exists today (checked in the code), the change, and the journey through it.',
    doneWhen: 'Every changed surface is written up, grouped into flows.',
  },
  uxColdRead: {
    id: 'ux-cold-read',
    label: 'Cold read',
    who: 'dev',
    tip: 'A fresh subagent reads each screen with no context and says what the people using it would notice; anything unclear is rewritten.',
    doneWhen: 'Every screen has a clean cold read.',
    locked: true,
  },
  cp4Post: postCheckpoint(
    4,
    'every screen, before and after, by flow — opening with what the dev understood and what changed since the split'
  ),
  e2ePlans: {
    id: 'e2e-plans',
    label: 'E2E plans',
    who: 'dev',
    tip: 'A test plan per ticket, following the E2E structure you approved in the split proposal. Only a NEW spec file beyond that structure is a question to you.',
    doneWhen: 'Every ticket has an E2E plan.',
  },
  reviewTickets: {
    id: 'review-tickets',
    label: 'Review each ticket (fix)',
    who: 'dev',
    tip: '/review-ticket --fix on each ticket: it applies its own suggestions and never splits.',
    doneWhen: 'Every ticket has been reviewed.',
    command: 'review-ticket',
  },
  fillAnswered: {
    id: 'fill-answered',
    label: 'Tell the manager',
    who: 'dev',
    tip: 'Once the phase-4 questions are answered, the dev tells the manager, which starts Reconcile.',
    doneWhen: 'The manager has the "[dev] phase 4 questions answered" message.',
  },
  reconcileTickets: {
    id: 'reconcile-tickets',
    label: 'Reconcile tickets',
    who: 'dev',
    tip: '/reconcile-tickets: fresh-context consistency loop over every ticket.',
    doneWhen: 'A pass finds nothing, or 3 passes have run.',
    maxPasses: 3,
    command: 'reconcile-tickets',
  },
  readyCheck: {
    id: 'ready-check',
    label: 'Ready to build',
    who: 'dev',
    tip: 'Each ticket is checked the way the build will check it — /review-ticket grading (it must reach an A), and every acceptance criterion testable — and fixed until it passes. A ticket that would fail the build costs a whole dev cycle; here it costs minutes.',
    doneWhen: 'Every ticket grades A.',
  },
  cp5Post: postCheckpoint(
    5,
    'the final tickets, opening with what changed since the UX review'
  ),
  finishReady: {
    id: 'finish-ready',
    label: 'Tickets to ready',
    who: 'dev',
    tip: 'Every ticket and the epic move to ready (`lambda tickets update <id> --status ready`), so the build picks them up in their numbered order.',
    doneWhen: 'Every ticket and the epic are ready.',
  },
  finishLinks: {
    id: 'finish-links',
    label: 'Write the dependency links',
    who: 'dev',
    tip: 'Every link you saw at the final check (links.md) is written with `lambda tickets block`, and every stale one is removed — gated on that checkpoint, so nothing goes in before you closed it. The build then never picks up a ticket before the work it needs.',
    doneWhen: 'Every line of links.md is written to the tracker.',
  },
} satisfies Record<string, WorkflowStep>;

// ── stages ──────────────────────────────────────────────────────────────────

const checkpointStage = (args: {
  cp: number;
  phase: number;
  label: string;
  tip: string;
  tracks: Track[];
}): WorkflowStage => ({
  id: `cp${args.cp}`,
  label: `CP${args.cp} · ${args.label}`,
  kind: 'checkpoint',
  phase: args.phase,
  checkpoint: args.cp,
  who: 'you',
  tip: `${args.tip} The pod waits here until you close it ("checkpoint complete"); then the manager starts the next stage.`,
  steps: [],
  tracks: args.tracks,
  locked: true,
});

const SHAPE_TIP =
  'The dev turns your idea (or an existing epic or ticket) into intent.md and, for an idea, an epic ticket. It asks you only what the code, the knowledge base and your words cannot settle.';
const REVIEW_TIP =
  'The dev looks for problems in the epic (or the lone ticket) before anything else: wrong premises, missing migrations, tests that cannot fail.';
const RECONCILE_TIP =
  'A fresh-context pass that makes the tickets agree with each other after all the edits.';

export const WORKFLOW: WorkflowStage[] = [
  {
    id: 'shape',
    label: '1 Shape',
    kind: 'phase',
    phase: 1,
    who: 'dev',
    tip: SHAPE_TIP,
    steps: [STEPS.intent, STEPS.epic, STEPS.cp1Post],
    tracks: ['idea'],
  },
  {
    id: 'shape',
    label: '1 Shape',
    kind: 'phase',
    phase: 1,
    who: 'dev',
    tip: `${SHAPE_TIP} The epic is already yours, so there is no checkpoint here — what the dev understood opens the UX review instead.`,
    steps: [STEPS.intent, STEPS.epic],
    tracks: EXISTING,
  },
  checkpointStage({
    cp: 1,
    phase: 1,
    label: 'the plan',
    tip: 'You check the dev understood what you want before anything is reviewed or split.',
    tracks: ['idea'],
  }),
  {
    id: 'epic-review',
    label: '2 Epic review',
    kind: 'phase',
    phase: 2,
    who: 'dev',
    tip: REVIEW_TIP,
    steps: [STEPS.epicRedFlags, STEPS.cp2Post],
    tracks: ['idea'],
  },
  {
    id: 'epic-review',
    label: '2 Review',
    kind: 'phase',
    phase: 2,
    who: 'dev',
    tip: `${REVIEW_TIP} No checkpoint: what it decides shows at the UX review; judgement calls still come to you as questions.`,
    steps: [STEPS.epicRedFlags],
    tracks: ['existing'],
  },
  {
    id: 'triage',
    label: '2 Triage',
    kind: 'phase',
    phase: 2,
    who: 'dev',
    tip: 'Before any ticket is planned: is each one still real, a duplicate, already fixed, or too big? Then a red-flags pass on each survivor.',
    steps: [STEPS.triage, STEPS.cp2PostTriage],
    tracks: ['batch'],
  },
  checkpointStage({
    cp: 2,
    phase: 2,
    label: 'triage',
    tip: 'One row per ticket: plan it, already fixed, merge, or pull out. You accept or change each row; nothing is closed or deleted without you.',
    tracks: ['batch'],
  }),
  {
    id: 'apply-triage',
    label: 'Apply triage',
    kind: 'phase',
    phase: 2,
    who: 'dev',
    tip: 'Your triage is carried out, then the survivors get a red-flags review each.',
    steps: [STEPS.applyTriage, STEPS.epicRedFlags],
    tracks: ['batch'],
  },
  checkpointStage({
    cp: 2,
    phase: 2,
    label: 'the reviewed epic',
    tip: 'You check the review: what it fixed, what it decided for you.',
    tracks: ['idea'],
  }),
  {
    id: 'research',
    label: '3 Research',
    kind: 'phase',
    phase: 3,
    who: 'dev',
    tip: 'Deep research grounds the work in the codebase, then — when there is something to split — a proposed split you approve before any ticket is written.',
    steps: [
      STEPS.verifyPremise,
      STEPS.research,
      STEPS.duplicateCheck,
      STEPS.splitProposal,
      STEPS.proposalRedFlags,
      STEPS.proposalColdRead,
      STEPS.cp3Post,
    ],
    tracks: ALL,
  },
  checkpointStage({
    cp: 3,
    phase: 3,
    label: 'split proposal',
    tip: 'You review the proposed tickets before they exist: what each changes, where in the code, and the E2E structure — how many new spec files, which tickets only add tests or assertions. Skipped when there is nothing to split.',
    tracks: ALL,
  }),
  {
    id: 'tickets',
    label: 'Tickets',
    kind: 'phase',
    phase: 3,
    who: 'dev',
    tip: 'The tickets are written (or adopted), each gets a UX sketch, and all are checked together for problems. No checkpoint: you see the result at the UX review.',
    steps: [STEPS.writeTickets, STEPS.uxSketch, STEPS.ticketsRedFlags],
    tracks: ['idea', 'existing'],
  },
  {
    id: 'tickets',
    label: 'Tickets',
    kind: 'phase',
    phase: 3,
    who: 'dev',
    tip: 'Each ticket is brought up to the template, gets a UX sketch, and then one pass across the whole batch finds shared causes, shared files and shared specs.',
    steps: [
      STEPS.writeTickets,
      STEPS.uxSketch,
      STEPS.crossTicket,
      STEPS.ticketsRedFlags,
    ],
    tracks: ['batch'],
  },
  {
    id: 'ux-review',
    label: 'UX review',
    kind: 'phase',
    phase: 3,
    who: 'dev',
    tip: 'Every screen, email and message the tickets change, before and after, grouped into flows — so you see the product, not the tickets. Skipped (with CP4) when nothing anyone sees changes. The pod stays in phase 3.',
    steps: [STEPS.uxSurfaces, STEPS.uxColdRead, STEPS.cp4Post],
    tracks: ALL,
  },
  checkpointStage({
    cp: 4,
    phase: 3,
    label: 'UX review',
    tip: 'You check what people will actually see. Changes you ask for go back into the tickets.',
    tracks: ALL,
  }),
  {
    id: 'fill',
    label: '4 Fill',
    kind: 'phase',
    phase: 4,
    who: 'dev',
    tip: 'Each ticket gets its test plan and a fixing review. No checkpoint: when its questions are answered, the pod moves on by itself.',
    steps: [STEPS.e2ePlans, STEPS.reviewTickets, STEPS.fillAnswered],
    tracks: ALL,
  },
  {
    id: 'reconcile',
    label: '5 Reconcile',
    kind: 'phase',
    phase: 5,
    who: 'dev',
    tip: `${RECONCILE_TIP} Last, every ticket is checked the way the build will check it.`,
    steps: [STEPS.reconcileTickets, STEPS.readyCheck, STEPS.cp5Post],
    tracks: ALL,
  },
  checkpointStage({
    cp: 5,
    phase: 5,
    label: 'final check',
    tip: 'Your last look before the tickets move to ready. It opens with what changed since the UX review, when there was one.',
    tracks: ALL,
  }),
  {
    id: 'finish',
    label: 'Finish',
    kind: 'finish',
    phase: 5,
    who: 'dev',
    tip: 'Every ticket and the epic move to ready, and the dependency links you approved are written. The build picks them up in their numbered order.',
    steps: [STEPS.finishReady, STEPS.finishLinks],
    tracks: ALL,
  },
];

/** Each track's stages, in order: the standard planning process. */
export const STANDARD_PLANNING: Record<Track, WorkflowStage[]> = {
  idea: WORKFLOW.filter((stage) => stage.tracks.includes('idea')),
  existing: WORKFLOW.filter((stage) => stage.tracks.includes('existing')),
  batch: WORKFLOW.filter((stage) => stage.tracks.includes('batch')),
};

/** Which track a pod is on (see the top of this file). */
export const trackOf = (pod: Pod): Track =>
  pod.pipeline === undefined
    ? 'idea'
    : pod.source === 'batch'
    ? 'batch'
    : pod.source === 'epic' || pod.source === 'ticket'
    ? 'existing'
    : 'idea';

/**
 * The stages this pod goes through, in order (none while it is freeform),
 * from a project's resolved process (default: the standard one). A step the
 * project switched off isn't one of them: nothing waits for it.
 */
export const stagesFor = (
  pod: Pod,
  process: Partial<Record<Track, WorkflowStage[]>> = STANDARD_PLANNING
): WorkflowStage[] =>
  pod.mode === 'freeform'
    ? []
    : (process[trackOf(pod)] ?? []).map((stage) => ({
        ...stage,
        steps: stage.steps.filter((step) => step.off !== true),
      }));

/**
 * Stages that write tickets for real: skipping one is allowed, but the inbox
 * asks the owner to confirm first.
 */
export const WRITES_TICKETS = new Set(['tickets', 'apply-triage', 'finish']);

const ALL_STEPS: WorkflowStep[] = Object.values(STEPS);

export const STEP_IDS: string[] = ALL_STEPS.map((step) => step.id);

export const findStep = (id: string): WorkflowStep | undefined =>
  ALL_STEPS.find((step) => step.id === id);

// ── where a pod is ──────────────────────────────────────────────────────────

export type StepState = 'done' | 'skipped' | 'now' | 'todo';
export type StageState = 'done' | 'skipped' | 'now' | 'waiting-you' | 'todo';

export interface PassRun {
  pass: number;
  startedAt?: string;
  endedAt?: string;
  found?: number;
}

export interface StepStatus {
  id: string;
  state: StepState;
  /** False when nothing was reported and the state is inferred. */
  tracked: boolean;
  startedAt?: string;
  endedAt?: string;
  passes: PassRun[];
  progress?: string;
  found?: number;
  note?: string;
}

export interface StageStatus {
  id: string;
  state: StageState;
  startedAt?: string;
  endedAt?: string;
  steps: StepStatus[];
}

/** Facts about a pod the workflow can't see in its step log. */
export interface PodFacts {
  pod: Pod;
  questions: Question[];
  steps: StepEvent[];
  /** Files present in the pod directory (intent.md, ux-review.json…). */
  files: Set<string>;
  /** The project's resolved planning process (default: the standard one). */
  process?: Partial<Record<Track, WorkflowStage[]>>;
}

const checkpointQuestion = (
  questions: Question[],
  cp: number
): Question | undefined =>
  questions
    .filter(
      (question) =>
        question.kind === 'checkpoint' &&
        question.checkpoint?.cp === cp &&
        question.status !== 'withdrawn'
    )
    .at(-1);

const reported = (facts: PodFacts, stepId: string): StepEvent | undefined =>
  facts.steps
    .filter((event) => event.step === stepId && event.event !== 'note')
    .at(-1);

/**
 * The owner skipped it (`lambda pod skip`). Stage ids repeat across tracks (shape,
 * tickets…) but a pod is on one track, so the id is enough; a checkpoint is
 * skipped as `cp<N>`.
 */
const ownerSkipped = (stage: WorkflowStage, facts: PodFacts): boolean => {
  const { pod } = facts;

  if ((pod.skipped ?? []).includes(stage.id)) {
    return true;
  }

  // The checkpoint after a stage the owner skipped has nothing to show the owner.
  if (stage.kind !== 'checkpoint') {
    return false;
  }

  // By id: stagesFor returns new stages each call.
  const stages = stagesFor(pod, facts.process);
  const before =
    stages[stages.findIndex((candidate) => candidate.id === stage.id) - 1];

  return before !== undefined && (pod.skipped ?? []).includes(before.id);
};

/**
 * The split-proposal checkpoint (pipeline 2) is skipped when there is nothing
 * to split — an epic that already has children, or a lone ticket with no seam — which the
 * dev reports by skipping the proposal step.
 */
const stageSkipped = (stage: WorkflowStage, facts: PodFacts): boolean => {
  if (ownerSkipped(stage, facts)) {
    return true;
  }

  if (stage.kind !== 'checkpoint') {
    return false;
  }

  // CP3: nothing to split. CP4: nothing anyone sees changes (a
  // backend fix, a test fixture), so there are no screens to review.
  return stage.checkpoint === 3
    ? reported(facts, STEPS.splitProposal.id)?.event === 'skip'
    : stage.checkpoint === 4 &&
        reported(facts, STEPS.uxSurfaces.id)?.event === 'skip';
};

/** Anything at all has happened in this stage. */
const stageStarted = (stage: WorkflowStage, facts: PodFacts): boolean =>
  stage.steps.some((step) => reported(facts, step.id) !== undefined) ||
  (stage.checkpoint !== undefined &&
    (facts.pod.completedCheckpoints.includes(stage.checkpoint) ||
      checkpointQuestion(facts.questions, stage.checkpoint) !== undefined));

/** Has this stage finished, from the pod's state and the step log? */
const stageFinished = (
  stages: WorkflowStage[],
  index: number,
  facts: PodFacts
): boolean => {
  const { pod } = facts;
  const stage = stages[index];
  const closed = (cp: number): boolean => pod.completedCheckpoints.includes(cp);

  if (stage === undefined) {
    return false;
  }

  if (pod.status === 'done' || stageSkipped(stage, facts)) {
    return true;
  }

  // The pod has moved past this stage's phase: it's behind us, whatever was
  // (or wasn't) reported in it.
  if (stage.kind !== 'finish' && pod.phase > stage.phase) {
    return true;
  }

  if (stage.kind === 'checkpoint') {
    return stage.checkpoint !== undefined && closed(stage.checkpoint);
  }

  if (stage.kind === 'finish') {
    return false;
  }

  // A phase is over once the checkpoint after it is POSTED — from then on it
  // waits on you.
  const next = stages[index + 1];

  if (
    next?.kind === 'checkpoint' &&
    next.checkpoint !== undefined &&
    !stageSkipped(next, facts)
  ) {
    return (
      closed(next.checkpoint) ||
      checkpointQuestion(facts.questions, next.checkpoint) !== undefined
    );
  }

  // No checkpoint after it (fill; the stages sharing phase 3): over when the
  // phase moves on, when every step reported done, or when a later stage began.
  return (
    pod.phase > stage.phase ||
    (stage.steps.length > 0 &&
      stage.steps.every((step) => {
        const last = reported(facts, step.id);

        return last?.event === 'done' || last?.event === 'skip';
      })) ||
    stages.slice(index + 1).some((later) => stageStarted(later, facts))
  );
};

/** For pods from before step tracking: what the files and the pod show. */
const inferredDone = (stepId: string, facts: PodFacts): boolean => {
  const cp = /^cp(\d)-post$/.exec(stepId);

  if (cp !== null) {
    return checkpointQuestion(facts.questions, Number(cp[1])) !== undefined;
  }

  if (stepId === 'proposal-post') {
    return checkpointQuestion(facts.questions, 3) !== undefined;
  }

  switch (stepId) {
    case 'intent':
      return facts.files.has('intent.md');
    case 'epic':
      return facts.pod.epicId !== undefined;
    case 'ux-surfaces':
    case 'ux-cold-read':
      return facts.files.has('ux-review.json');
    default:
      return false;
  }
};

const stepStatus = (
  step: WorkflowStep,
  facts: PodFacts,
  stageDone: boolean
): StepStatus => {
  const events = facts.steps.filter((event) => event.step === step.id);
  const passes = events.reduce<PassRun[]>((runs, event) => {
    const pass = event.pass ?? 1;
    const run = runs.find((candidate) => candidate.pass === pass) ?? { pass };
    const rest = runs.filter((candidate) => candidate.pass !== pass);
    const updated: PassRun =
      event.event === 'start'
        ? { pass, startedAt: run.startedAt ?? event.at }
        : event.event === 'done' || event.event === 'skip'
        ? {
            ...run,
            endedAt: event.at,
            found: event.found ?? run.found,
          }
        : run;

    return [...rest, updated].sort((a, b) => a.pass - b.pass);
  }, []);
  const last = events.filter((event) => event.event !== 'note').at(-1);
  const latestProgress = events
    .filter((event) => event.progress !== undefined)
    .at(-1)?.progress;
  const noted = events.filter((event) => event.note !== undefined).at(-1)?.note;
  const base = {
    id: step.id,
    passes,
    startedAt: passes[0]?.startedAt,
    endedAt: passes.at(-1)?.endedAt,
    progress: latestProgress,
    found: passes.reduce<number | undefined>(
      (sum, run) => (run.found === undefined ? sum : (sum ?? 0) + run.found),
      undefined
    ),
    note: noted,
  };

  if (last !== undefined) {
    return {
      ...base,
      tracked: true,
      state:
        last.event === 'start'
          ? 'now'
          : last.event === 'skip'
          ? 'skipped'
          : 'done',
    };
  }

  return {
    ...base,
    tracked: false,
    state: stageDone || inferredDone(step.id, facts) ? 'done' : 'todo',
  };
};

/** Every stage and step of this pod's track, with where the pod is in it. */
export const workflowStatus = (facts: PodFacts): StageStatus[] => {
  const stages = stagesFor(facts.pod, facts.process);
  const finished = stages.map((_stage, index) =>
    stageFinished(stages, index, facts)
  );
  const current = finished.indexOf(false);

  return stages.map((stage, index): StageStatus => {
    const done = finished[index] === true;
    const skipped = stageSkipped(stage, facts);
    const steps = stage.steps.map((step) => stepStatus(step, facts, done));
    const posted =
      stage.checkpoint === undefined
        ? undefined
        : checkpointQuestion(facts.questions, stage.checkpoint);
    const state: StageState = skipped
      ? 'skipped'
      : done
      ? 'done'
      : index !== current
      ? 'todo'
      : stage.kind === 'checkpoint'
      ? posted !== undefined && posted.status === 'open'
        ? 'waiting-you'
        : 'todo'
      : 'now';
    const [started] = steps
      .map((step) => step.startedAt)
      .filter((at): at is string => at !== undefined)
      .sort();
    const ended = steps
      .map((step) => step.endedAt)
      .filter((at): at is string => at !== undefined)
      .sort()
      .at(-1);

    return {
      id: stage.id,
      state,
      startedAt: posted?.createdAt ?? started,
      endedAt: posted?.answeredAt ?? (done ? ended : undefined),
      steps,
    };
  });
};

// ── history: does each step earn its place? ────────────────────────────────

export interface StepHistory {
  /** Finished runs across all pods (each pass counts once). */
  runs: number;
  /** Pods it ran in. */
  pods: number;
  avgMs?: number;
  avgFound?: number;
  /** Runs that reported `found: 0` — candidates for waste. */
  foundNothing: number;
  /** Runs that reported `found` at all. */
  reportedFound: number;
}

const runsOf = (steps: StepEvent[], stepId: string): PassRun[] =>
  steps
    .filter((event) => event.step === stepId)
    .reduce<PassRun[]>((runs, event) => {
      const pass = event.pass ?? 1;
      const open = runs.find(
        (run) => run.pass === pass && run.endedAt === undefined
      );

      if (event.event === 'start') {
        return [...runs, { pass, startedAt: event.at }];
      }

      if (event.event !== 'done') {
        return runs;
      }

      const ended: PassRun = {
        pass,
        startedAt: open?.startedAt,
        endedAt: event.at,
        found: event.found,
      };

      return open === undefined
        ? [...runs, ended]
        : runs.map((run) => (run === open ? ended : run));
    }, [])
    .filter((run) => run.endedAt !== undefined);

/** Per step, across every pod's log. */
export const stepHistory = (logs: StepEvent[][]): Record<string, StepHistory> =>
  Object.fromEntries(
    STEP_IDS.map((stepId): [string, StepHistory] => {
      const perPod = logs.map((log) => runsOf(log, stepId));
      const runs = perPod.flat();
      const timed = runs.filter(
        (run) => run.startedAt !== undefined && run.endedAt !== undefined
      );
      const counted = runs.filter((run) => run.found !== undefined);
      const avg = (values: number[]): number | undefined =>
        values.length === 0
          ? undefined
          : values.reduce((sum, value) => sum + value, 0) / values.length;

      return [
        stepId,
        {
          runs: runs.length,
          pods: perPod.filter((podRuns) => podRuns.length > 0).length,
          avgMs: avg(
            timed.map(
              (run) =>
                Date.parse(run.endedAt ?? '') - Date.parse(run.startedAt ?? '')
            )
          ),
          avgFound: avg(counted.map((run) => run.found ?? 0)),
          foundNothing: counted.filter((run) => run.found === 0).length,
          reportedFound: counted.length,
        },
      ];
    })
  );
