import { type WorkflowStage, type WorkflowStep } from '../pod-store/workflow';

/**
 * Lambda's standard building process, as data: what happens to one ticket
 * from pick-up to ship. A project changes it from
 * `.lambda/building/workflow.json`, like planning. `check-ticket` and `ship`
 * are quality steps (locked); `visual-check` is optional (Settings → Process
 * switches it). `design-check` has no switch, but a project may replace its
 * instructions with `.lambda/building/design-check.md`, so it isn't locked.
 * Later steps add their own flags here, as data.
 */
export const BUILDING_STEPS: WorkflowStep[] = [
  {
    id: 'pick-up',
    label: 'Pick up the next ticket',
    who: 'app',
    tip: 'The runner takes the next Ready ticket the owner reported, claims it so no other computer builds it, and moves it to building; then it tells the Engineering manager, who hands it to the dev.',
    doneWhen: 'The ticket is claimed and building.',
  },
  {
    id: 'build',
    label: 'Build it',
    who: 'dev',
    tip: 'The dev reads the ticket, plans the work and builds it test-first, running every test it writes.',
    doneWhen: 'Every acceptance criterion is built and its tests pass.',
    command: 'start',
  },
  {
    id: 'self-review',
    label: 'Review the change',
    who: 'dev',
    tip: "/code-review on the ticket's own diff; what it finds in that diff is fixed.",
    doneWhen: 'The review finds nothing left to fix.',
    command: 'code-review',
  },
  {
    id: 'check-ticket',
    label: 'Check against the ticket',
    who: 'qa',
    tip: '/check-ticket: every acceptance criterion is checked against what was built, and the verdict is recorded.',
    doneWhen: 'A COMPLETE verdict is recorded.',
    command: 'check-ticket',
    locked: true,
  },
  {
    id: 'visual-check',
    label: 'Check against the design',
    who: 'qa',
    tip: "/visual-check, only for a ticket with a ## Design section: each round photographs the ticket's scenarios, grades every picture against its design, and the dev fixes what differs until the stop rule ends the loop.",
    doneWhen:
      'The visual record is MATCH or SHIPPED_WITH_MISSES (BLOCKED blocks the ticket).',
    command: 'visual-check',
    optional: true,
  },
  {
    id: 'test',
    label: 'Test it',
    who: 'qa',
    tip: '/qa: the tests the ticket names run, and anything they find goes back to the dev.',
    doneWhen: 'Every test the ticket names passes.',
    command: 'qa',
  },
  {
    id: 'review',
    label: 'Your review (QA)',
    who: 'manager',
    tip: 'Off unless the project has a manual QA step (Settings → Process). The ticket waits in the owner\'s Needs you as "ready to review": approve and it ships; send it back and the note is the dev\'s next instruction.',
    doneWhen: 'The owner approved it.',
    optional: true,
    offByDefault: true,
  },
  {
    id: 'design-check',
    label: 'Keep the design system in step',
    who: 'dev',
    tip: "/design-check, in every ticket of a project with a design system: the source map names which of the ticket's files change the design system, and the dev updates its copies in this same ticket, so they ship with the change. It never publishes and never commits.",
    doneWhen: 'The dev reports DESIGN: NO CHANGE or DESIGN: UPDATED.',
    command: 'design-check',
    required: true,
  },
  {
    id: 'ship',
    label: 'Ship it',
    who: 'manager',
    tip: 'The change ships behind its verdict gate, and the ticket moves to done.',
    doneWhen: 'The change is shipped and the ticket is done.',
    command: 'ship',
    locked: true,
  },
];

/** The one track building has. */
export const BUILDING_TRACK = 'standard';

export const BUILDING_STAGES: WorkflowStage[] = [
  {
    id: 'building',
    label: 'Building',
    kind: 'phase',
    phase: 1,
    who: 'dev',
    tip: 'One ticket, from pick-up to ship.',
    steps: BUILDING_STEPS,
    tracks: [],
  },
];
