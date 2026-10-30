import { z } from 'zod';

/**
 * A batch triage's proposal per ticket (CP2). `pull-out` is machine-read: an
 * approved one starts its own pod (`lambda pod new --from-checkpoint`).
 */
/** A ticket's build lane: its label, or none (a normal build). */
export const LANES = ['normal', 'quick-fix', 'investigation'] as const;

/** Lane ids older pods and project addenda still write, read as today's. */
const LANE_ALIASES: Record<string, (typeof LANES)[number]> = {
  'quick-update': 'quick-fix',
};

/** A lane, accepting an older id on read (`quick-update` → `quick-fix`). */
const laneSchema = z.preprocess(
  (value) => (typeof value === 'string' ? LANE_ALIASES[value] ?? value : value),
  z.enum(LANES)
);

export const TRIAGE_PROPOSALS = [
  'plan',
  'fixed',
  'merge',
  'pull-out',
  'lane',
] as const;

/**
 * Everything a planning pod persists. One directory per pod under
 * `<pods root>/<id>/`.
 */

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const id = z.string().regex(ID_PATTERN);

export const POD_STATUSES = ['active', 'paused', 'done'] as const;

export const AGENT_ROLES = [
  'manager',
  'dev',
  'engineering-manager',
  'qa',
  'product-manager',
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

/** A planning pod plans tickets; a building pod builds them, one runner each. */
export const POD_KINDS = ['planning', 'building'] as const;

export type PodKind = (typeof POD_KINDS)[number];

/** A building pod's agent windows, in the order they're started. */
export const BUILDING_ROLES = ['engineering-manager', 'dev', 'qa'] as const;

export const RENDER_MODES = ['full', 'ascii'] as const;

export type RenderMode = (typeof RENDER_MODES)[number];

export const PodSchema = z.object({
  id,
  slug: z.string(),
  /** Display name, set by renaming in the inbox. Falls back to the slug. */
  title: z.string().optional(),
  createdAt: z.string(),
  status: z.enum(POD_STATUSES),
  /** Pipeline phase 1–5 (Shape, Epic review, Split, Fill, Reconcile). */
  phase: z.number().int().min(1).max(5),
  /** Checkpoints (1–5) the owner has closed. CP4 is the UX review. */
  completedCheckpoints: z.array(z.number().int().min(1).max(5)),
  epicId: z.string().optional(),
  /**
   * Which pipeline the pod runs. Absent: the original pipeline (pods created
   * before 2026-10-07 finish on it). 2: the current one — see WORKFLOW.
   */
  pipeline: z.literal(2).optional(),
  /**
   * What the pod was started from (pipeline 2): a new `idea` (CP1 and CP2),
   * an existing `epic`, or a lone `ticket` (both go straight through to the
   * UX review). For epic/ticket, `epicId` holds the Linear id.
   */
  source: z.enum(['idea', 'epic', 'ticket', 'batch']).optional(),
  /**
   * A lone ticket's split proposal (CP3), as the owner closed it: `one-ticket`
   * keeps it one ticket; `accepted` made it an epic (`source` became `epic`)
   * whose children are the proposed tickets.
   */
  split: z.enum(['one-ticket', 'accepted']).optional(),
  /**
   * `batch`: the tickets planned together, in the owner's order. Usually
   * unrelated bugs — no epic; each ticket goes through the existing-ticket
   * flow, with a triage checkpoint (CP2) first.
   */
  tickets: z.array(z.string()).optional(),
  /**
   * `freeform`: a conversation with the dev — no pipeline, no checkpoints —
   * until the owner switches it to the structured flow (`lambda pod structure`),
   * which keeps the dev's context. Absent: structured.
   */
  mode: z.enum(['freeform', 'structured']).optional(),
  /**
   * How the UX review is drawn: `full` (screenshots, Claude Design
   * prototypes and their pictures) or `ascii` (ASCII only, so the pod plans
   * faster). Absent: `full` when the computer running the pod can use
   * Claude Design, else `ascii`. Read it through `podRenderMode`.
   */
  renderMode: z.enum(RENDER_MODES).optional(),
  /**
   * A freeform pod's dev thinks it's time for the structured flow and says
   * how (`lambda pod propose-structure`): it comes up in the owner's inbox, and the owner
   * starts it (`lambda pod structure`, which clears it) or keeps talking.
   */
  structureProposal: z
    .object({
      source: z.enum(['idea', 'epic', 'ticket', 'batch']),
      epicId: z.string().optional(),
      tickets: z.array(z.string()).optional(),
      why: z.string(),
      at: z.string(),
    })
    .optional(),
  /**
   * `owner` once the owner renamed it themselves: agents never rename it after
   * that. Any other stored value (an older pod's name for the owner) reads as
   * `owner`; an absent one stays absent.
   */
  titleBy: z.preprocess(
    (value) => (value === undefined || value === 'agent' ? value : 'owner'),
    z.enum(['owner', 'agent']).optional()
  ),
  /**
   * A planning pod: stages the owner chose to skip (`lambda pod skip`), which
   * the manager passes by. A building pod: ticket ids left out of its queue
   * for the life of the pod (`lambda pod skip-ticket`).
   */
  skipped: z.array(z.string()).optional(),
  /** Absent: a planning pod (every pod made before building pods). */
  kind: z.enum(POD_KINDS).optional(),
  /** A building pod: the runner (computer) it builds on. */
  runnerId: z.string().optional(),
  /**
   * A building pod's tmux session: lambda.json `tmux.session` when it was set
   * explicitly, else absent and the pod's own `lambda-pod-<id>`. Read it
   * through `podSessionOf`.
   */
  tmuxSession: z.string().optional(),
  /**
   * "Talk about this ticket" with no building pod on the project: a one-shot
   * Product manager conversation about this ticket, and nothing else. It
   * takes no tickets and has no other agents.
   */
  talk: z.object({ ticketId: z.string() }).optional(),
  /**
   * Started by another pod: a ticket pulled out of a batch at a checkpoint
   * the owner approved (`qid`, `lambda pod new --from-checkpoint`), or work the owner agreed
   * in its chat should be its own Lambda (`messageId`, `lambda pod new --spinoff`).
   */
  from: z
    .object({
      podId: z.string(),
      qid: z.string().optional(),
      messageId: z.string().optional(),
    })
    .optional(),
  /** The pod's git worktree (outside the repo — see README "Worktrees"). */
  worktreePath: z.string(),
  /** The mothership's project this pod belongs to (set when the app made it). */
  projectId: z.string().optional(),
  /** False when `--workdir` pointed the pod at an existing checkout; `done` never removes it. */
  ownsWorktree: z.boolean(),
  managerCwd: z.string(),
  devCwd: z.string(),
  /** The CLI agent binary. `claude` by default; swappable per pod. */
  agentCommand: z.string(),
  /** Each agent role's Claude session id (planning: manager and dev). */
  sessions: z.record(z.string(), z.string()),
  /** Set at CP4 when a `0 - …` Needs-a-human ticket gates the remaining children. */
  waitingOnHuman: z
    .object({ ticketId: z.string(), since: z.string() })
    .optional(),
  /**
   * When the pod was archived, by an older or outside writer. Lambda never
   * sets it, but keeps it: a write that dropped it would un-archive the pod
   * for that writer.
   */
  archivedAt: z.string().optional(),
});

export type Pod = z.infer<typeof PodSchema>;

export const podKindOf = (pod: Pick<Pod, 'kind'>): PodKind =>
  pod.kind ?? 'planning';

/** A role's Claude session id; refused when the pod never gave it one. */
export const sessionOf = (pod: Pick<Pod, 'id' | 'sessions'>, role: string) => {
  const session = pod.sessions[role];

  if (session === undefined) {
    throw new Error(`Pod ${pod.id} has no ${role} session.`);
  }

  return session;
};

/**
 * What a pod's computer says about Claude Design: the `design` of its
 * `~/.lambda/config.json`, as the runner reads and reports it. Pod-store
 * never reads that file itself; each caller passes what it knows.
 */
export interface RenderMachine {
  design?: { available: boolean };
}

/**
 * The only reader of `renderMode`: an explicit mode wins; absent means
 * `full` only when the computer can use Claude Design, else `ascii`.
 */
export const podRenderMode = (
  pod: Pick<Pod, 'renderMode'>,
  machine: RenderMachine
): RenderMode =>
  pod.renderMode ?? (machine.design?.available === true ? 'full' : 'ascii');

export const OptionSchema = z.object({
  id: z.string().regex(/^[A-Z]$/),
  label: z.string().min(1),
  detail: z.string().min(1),
  tradeoffs: z.string().min(1),
});

export type QuestionOption = z.infer<typeof OptionSchema>;

export const ColdReadSchema = z.object({
  restatement: z.string().min(1),
  choice: z.string().min(1),
  missing: z.array(z.string()),
});

export type ColdRead = z.infer<typeof ColdReadSchema>;

export const QUESTION_STATUSES = [
  'draft',
  'open',
  'answered',
  'withdrawn',
] as const;

export const QUESTION_SECTIONS = [
  'summary',
  'context',
  'problem',
  'options',
  'recommendation',
  'visual',
] as const;

export type QuestionSection = (typeof QUESTION_SECTIONS)[number];

export const RecommendationSchema = z.object({
  optionId: z.string(),
  why: z.string(),
});

export const VisualSchema = z.object({
  ascii: z.string(),
  notes: z.string(),
  /** What the audio player reads instead of the ASCII. */
  spoken: z.string(),
});

/**
 * How a question got into the queue — shown and read as "How we got here",
 * with links. Required by `question add` (optional here so older questions
 * still parse; checkpoints have none).
 * - message: something the owner said (on an item, or in the pod's chat)
 * - answer:  a follow-up to the owner's answer on an earlier question
 * - work:    the phase work itself turned it up
 */
export const QuestionOriginSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'),
    messageId: z.string(),
    /** The item that message was on; absent for the pod's direct chat. */
    qid: z.string().optional(),
    /**
     * The part of the owner's message this question is about — verbatim (checked
     * against the saved message). A long multi-part message is otherwise
     * shown whole on every question it spawned.
     */
    quote: z.string().optional(),
    /** Claude's answer to just that part. */
    reply: z.string().optional(),
  }),
  z.object({ kind: z.literal('answer'), qid: z.string() }),
  z.object({
    kind: z.literal('work'),
    phase: z.number().int().min(1).max(5),
    /** What the dev was doing, in plain words ("checking the trail map ticket against the code"). */
    doing: z.string(),
  }),
]);

export type QuestionOrigin = z.infer<typeof QuestionOriginSchema>;

/**
 * One situation of a screen in the UX review, as pictures: today's
 * screenshot and the design still photographed from the approved prototype,
 * with its numbered markers explained. Paths are pod-relative
 * (`designs/<slug>/…png`). The legend is shown, never read aloud.
 */
export const PictureSchema = z.object({
  /** "Trail closed" — the situation's title from the screen's brief. */
  situation: z.string(),
  /** The screenshot scenario that sets this situation up. */
  scenarioId: z.string().optional(),
  /** Today's screenshot. Absent for a new screen. */
  before: z.string().optional(),
  /** The annotated design still. Absent for a removed screen. */
  after: z.string().optional(),
  legend: z.array(z.object({ n: z.number().int(), label: z.string() })),
});

export type Picture = z.infer<typeof PictureSchema>;

/**
 * One screen in the UX review (CP4): what it looked like, what it will look
 * like, and how it behaves at its edges. The ASCII is shown, never read aloud.
 */
export const ScreenSchema = z.object({
  /** "Trail map" — plain, as the people who use it would name it. */
  name: z.string(),
  change: z.enum(['changed', 'new', 'removed']),
  /** ASCII of the screen today. Absent for a new screen. */
  before: z.string().optional(),
  /** ASCII once built. Absent for a removed screen. */
  after: z.string().optional(),
  /** What changes for the person using it, in plain sentences. Read aloud. */
  changes: z.string(),
  /**
   * Why this screen exists, from the person's side — how they get here, what
   * they do, what happens next. Shown (collapsed) on the card; never spoken.
   * Optional here so older UX reviews parse; `checkpoint post` requires it.
   */
  journey: z
    .object({
      /** Who, concretely ("Ann Perkins, a volunteer checking the trail markers"). */
      who: z.string(),
      /** How they arrive here — what they did or received just before. */
      before: z.string(),
      /** What they do on this screen. */
      here: z.string(),
      /** What happens after — for them, and for anyone else it reaches. */
      after: z.string(),
    })
    .optional(),
  /** Older UX reviews: states and edge cases (no longer asked for). */
  states: z.array(z.string()).optional(),
  /** Build numbers of the tickets that build it ("2", "14b"). */
  tickets: z.array(z.string()),
  /**
   * The checkpoint's decisions this screen already shows (autonomous decision
   * ids). The card tells each one here — its why and what was turned down —
   * instead of again in the Decisions list. Numbers stay the checkpoint's.
   */
  decisions: z.array(z.string()).optional(),
  /** Which flow it belongs to (index into the checkpoint's `flows`). */
  flow: z.number().int().min(0).optional(),
  /** Full render mode: one pair of pictures per situation. Older reviews have none. */
  pictures: z.array(PictureSchema).optional(),
  /** The clickable Claude Design prototype (`https://claude.ai/…`). */
  prototypeUrl: z.string().optional(),
  /**
   * The project has no photo hook (`commands.shot` in lambda.json), so its
   * pictures have no "before": the ux phase sets it, and the card says why.
   */
  noPhotoHook: z.literal(true).optional(),
});

export type Screen = z.infer<typeof ScreenSchema>;

/** A journey someone goes through, start to finish — the UX review's grouping. */
export const FlowSchema = z.object({
  /** "Adding a stall to the festival schedule". */
  name: z.string(),
  /** The whole journey in 1–2 plain sentences (read aloud before its first screen). */
  summary: z.string(),
});

export type Flow = z.infer<typeof FlowSchema>;

/**
 * How a proposed ticket touches the E2E suite — shown on the split proposal so
 * the owner approves the test structure before any ticket is written.
 */
export const E2E_KINDS = [
  'new-file',
  'new-tests',
  'assertions',
  'none',
] as const;

/**
 * Older proposals named the docs field `helpArticles`: read it as `docs` when
 * `docs` is absent, so stored pods and project addenda still parse.
 */
const docsAlias = (value: unknown): unknown => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }

  const rest = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'helpArticles')
  );
  const helpArticles = 'helpArticles' in value ? value.helpArticles : undefined;

  return helpArticles === undefined || 'docs' in rest
    ? rest
    : { ...rest, docs: helpArticles };
};

/** One ticket of the split proposal (CP3, pipeline 2), before the alias. */
const ProposedTicketShape = z.object({
  /** Build number: "1", "2"… ("0" only for a step-0 Needs-a-human ticket). */
  number: z.string().regex(/^\d+$/),
  /** Plain title, as it will appear after the number. */
  title: z.string().min(1),
  /** What changes, in plain words the people who use it would follow (read aloud). */
  what: z.string().min(1),
  /** Where it lands in the code — the research that grounds it (shown, never read). */
  files: z.array(z.string().min(1)).min(1),
  /** Earlier build numbers it needs — a tree, not a line. */
  dependsOn: z.array(z.string()),
  /**
   * Why each dependency is needed, keyed by its build number.
   * Optional so checkpoints stored before it still parse.
   */
  dependsWhy: z.record(z.string(), z.string()).optional(),
  e2e: z.object({
    kind: z.enum(E2E_KINDS),
    /** The spec file (new or existing); omitted only for `none`. */
    spec: z.string().optional(),
    /** For `new-file`: why an existing spec can't hold it. For `none`: why no E2E. */
    why: z.string().optional(),
  }),
  /**
   * Its build lane when it isn't a normal build: written as the label when the
   * ticket is created, shown on the card as a tag, never read aloud.
   */
  lane: laneSchema.optional(),
  /** Docs this ticket makes out of date (file names), so they stay true. */
  docs: z.array(z.string()).default([]),
  /** Existing tickets this folds in or overlaps. */
  overlaps: z.array(
    z.object({
      id: z.string(),
      how: z.enum(['folds-in', 'overlaps', 'related']),
      note: z.string(),
    })
  ),
});

/** One ticket of the split proposal (CP3, pipeline 2). */
export const ProposedTicketSchema = z.preprocess(
  docsAlias,
  ProposedTicketShape
);

export type ProposedTicket = z.infer<typeof ProposedTicketSchema>;

/** `lambda pod checkpoint post --proposal-file` (CP3): every ticket cold-read. */
export const ProposalFileSchema = z.object({
  tickets: z.array(
    z.preprocess(
      docsAlias,
      ProposedTicketShape.extend({
        /** A fresh subagent's read of title + what ALONE. `unclear` must be empty. */
        coldRead: z.object({
          restatement: z.string(),
          unclear: z.array(z.string()),
        }),
      })
    )
  ),
});

export type ProposalFile = z.infer<typeof ProposalFileSchema>;

/**
 * "Changed since you approved the split" (CP4) / "since the UX review" (CP5):
 * what moved that the owner would care about. Decisions are listed on the
 * checkpoint already; these are the rest.
 */
export const CHANGE_KINDS = [
  'screen',
  'ticket',
  'e2e',
  'human',
  'engineering',
] as const;

export const ChangeSchema = z.object({
  kind: z.enum(CHANGE_KINDS),
  /** What it is now, in a plain sentence (read aloud unless `engineering`). */
  text: z.string().min(1),
  /** What it was when the owner approved it — so the change makes sense alone. */
  before: z.string().optional(),
  /** Why it changed (which decision, review or request caused it). */
  why: z.string().optional(),
});

export type Change = z.infer<typeof ChangeSchema>;

export const ChangesFileSchema = z.object({ changes: z.array(ChangeSchema) });

/** A judgement (or copy rule) suggested at the final checkpoint. */
export const SuggestedJudgementSchema = z.object({
  kind: z.enum(['judgement', 'copy']),
  /** One plain sentence that makes sense on its own (read aloud). */
  statement: z.string().min(1),
  /** Why it's good long term (read aloud). */
  why: z.string().min(1),
  /** The owner's own words it came from — verbatim. */
  quote: z.string().min(1),
  /** Copy rules: the term to use, the ones never to use, what it means. */
  copy: z
    .object({
      use: z.string().min(1),
      never: z.array(z.string()),
      meaning: z.string().min(1),
    })
    .optional(),
});

export type SuggestedJudgement = z.infer<typeof SuggestedJudgementSchema>;

export const JudgementsFileSchema = z.object({
  judgements: z.array(SuggestedJudgementSchema),
});

export const QuestionSchema = z.object({
  id,
  origin: QuestionOriginSchema.optional(),
  podId: id,
  kind: z.enum(['question', 'checkpoint']),
  ticketId: z.string().optional(),
  phase: z.number().int().min(1).max(5),
  status: z.enum(QUESTION_STATUSES),
  blocksCheckpoint: z.boolean(),
  dependsOn: z.array(id),
  createdAt: z.string(),
  committedAt: z.string().optional(),
  answeredAt: z.string().optional(),
  withdrawnAt: z.string().optional(),
  withdrawReason: z.string().optional(),
  summary: z.string().optional(),
  context: z.string().optional(),
  problem: z.string().optional(),
  options: z.array(OptionSchema),
  recommendation: RecommendationSchema.optional(),
  visual: VisualSchema.optional(),
  commit: z
    .object({ justification: z.string(), coldRead: ColdReadSchema })
    .optional(),
  checkpoint: z
    .object({
      cp: z.number().int().min(1).max(5),
      decisionIds: z.array(z.string()),
      /** CP4, the UX review: one card per screen that changes, in flow order. */
      screens: z.array(ScreenSchema).optional(),
      /** CP4: the flows the screens are grouped into (screens point here). */
      flows: z.array(FlowSchema).optional(),
      /** CP3 (pipeline 2): the proposed split, before any ticket is written. */
      proposal: z.array(ProposedTicketSchema).optional(),
      /** CP4 (pipeline 2): "What I understood" — the intent, in 2–3 sentences. */
      understood: z.string().optional(),
      /**
       * CP4: changed since the split was approved; CP5: since the UX review.
       * Empty = nothing (said so on the card).
       */
      changes: z.array(ChangeSchema).optional(),
      /**
       * CP5: lasting judgements and copy rules the dev suggests from what
       * the owner decided in this pod. The owner ticks the ones to keep (`kept`, by
       * index); they are saved to the knowledge store when the owner closes it.
       */
      suggestedJudgements: z.array(SuggestedJudgementSchema).optional(),
      keptJudgements: z.array(z.number().int().nonnegative()).optional(),
      /**
       * "The plan": the whole plan as it now stands, high level — what people
       * will see and do, plus only the heavy architecture. Read aloud. Required
       * by `checkpoint post`; optional here so older checkpoints still parse.
       */
      plan: z.string().optional(),
      /**
       * Once the epic has children: one plain summary per ticket, in build
       * order, after the epic paragraph in `plan`. `id` (the ticket id) is for the
       * coverage check only — never shown or spoken.
       */
      planTickets: z
        .array(
          z.object({
            id: z.string(),
            /** The ticket title — engineer shorthand; shown only as a fallback. */
            title: z.string(),
            /** "1 - Closed trails show on the map": plain, keeps the build number. */
            name: z.string().optional(),
            /** How it works now, as the people who use it would see it. */
            today: z.string().optional(),
            /** What changes once this ticket ships. */
            after: z.string().optional(),
            /** Older checkpoints: one paragraph instead of today/after. */
            summary: z.string().optional(),
            /** A batch's triage (CP2): what the dev proposes for this ticket. */
            proposal: z.enum(TRIAGE_PROPOSALS).optional(),
            /** Its lane once planned — shown as a tag, never read aloud. */
            lane: laneSchema.optional(),
            /** Its lane before, when triage changes it. */
            laneWas: laneSchema.optional(),
          })
        )
        .optional(),
      /**
       * Where the card's content came from, so it can be edited like a doc:
       * while the checkpoint is open, an edit to one of these files is
       * re-read (same checks as posting) and the card updates in place
       * (`lambda pod checkpoint refresh`, run by the inbox when a file changes).
       * Closing it freezes the card as it was.
       */
      sources: z
        .object({
          summary: z.string(),
          plan: z.string().optional(),
          planFile: z.string().optional(),
          screensFile: z.string().optional(),
          proposalFile: z.string().optional(),
          understood: z.string().optional(),
          changesFile: z.string().optional(),
          judgementsFile: z.string().optional(),
        })
        .optional(),
      /** When the card was last re-read from its files. */
      refreshedAt: z.string().optional(),
      /** The last edit didn't pass the checks: why. The card keeps its last good version. */
      refreshError: z.string().optional(),
      /**
       * Which version of the card this is (1 when unset), when it appeared
       * and how: earlier versions are kept under `versions/<qid>/` (see
       * versions.ts).
       */
      version: z.number().int().positive().optional(),
      versionAt: z.string().optional(),
      versionKind: z.enum(['posted', 'reposted', 'edited']).optional(),
      /**
       * The decisions it lists, as worded when this version was saved — the
       * decision log is amended in place, so an earlier version needs its own
       * copy to show them as they were.
       */
      decisionSnapshot: z
        .array(z.lazy(() => AutonomousDecisionSchema))
        .optional(),
    })
    .optional(),
});

export type Question = z.infer<typeof QuestionSchema>;

/** `lambda pod checkpoint post --decisions-cold-read`: one read per decision on it. */
export const DecisionsColdReadSchema = z.array(
  z.object({
    id: z.string(),
    /** What the fresh reader thinks the situation was BEFORE the decision. */
    situation: z.string(),
    restatement: z.string(),
    unclear: z.array(z.string()),
    /** Phrases that point at something never explained ("this rule", "the release"). */
    unexplained: z.array(z.string()),
  })
);

/**
 * `lambda pod checkpoint post --screens-file` (CP4): the screens grouped into
 * flows — each flow a journey, its screens in the order the person meets
 * them — every screen cold-read.
 */
export const ScreensFileSchema = z.object({
  flows: z.array(
    FlowSchema.extend({
      screens: z.array(
        ScreenSchema.omit({ flow: true }).extend({
          /**
           * A fresh subagent's read of the screen's name, changes and journey
           * ALONE: what the people who use it will notice, and anything it
           * couldn't follow.
           */
          coldRead: z.object({
            restatement: z.string(),
            unclear: z.array(z.string()),
          }),
        })
      ),
    })
  ),
});

export type ScreensFile = z.infer<typeof ScreensFileSchema>;

/** `lambda pod checkpoint post --plan-file`: the epic paragraph + one line per ticket. */
export const PlanFileSchema = z.object({
  epic: z.string(),
  tickets: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        name: z.string(),
        today: z.string(),
        after: z.string(),
        /** A batch's triage row: plan · fixed · merge · pull-out · lane. */
        proposal: z.enum(TRIAGE_PROPOSALS).optional(),
        /** Its lane once planned, and before if triage changes it: a tag on the card, not words in the row. */
        lane: laneSchema.optional(),
        laneWas: laneSchema.optional(),
        /**
         * A fresh subagent's read of name + today + after ALONE: what changes
         * for the people who use it, in one sentence, and anything it couldn't
         * follow. `unclear` must be empty to post.
         */
        coldRead: z.object({
          restatement: z.string(),
          unclear: z.array(z.string()),
        }),
      })
    )
    .default([]),
});

export type PlanFile = z.infer<typeof PlanFileSchema>;

export const THREAD_SENDERS = [
  'human',
  'dev',
  'manager',
  'fork',
  'system',
  // A building pod's roles: each bubble is credited to whoever wrote it.
  'engineering-manager',
  'qa',
  'product-manager',
] as const;

export type ThreadSender = (typeof THREAD_SENDERS)[number];

export const ThreadEntrySchema = z.object({
  id,
  podId: id,
  qid: id.optional(),
  /**
   * The owner's chat message was ABOUT this item (the one up when the owner sent it) —
   * for the chat's "About …" heading and the dev's context. Unlike `qid`,
   * it is not an answer on the item: the item stays in the owner's inbox.
   */
  about: id.optional(),
  from: z.enum(THREAD_SENDERS),
  mode: z.enum(['async', 'sync', 'note']),
  text: z.string(),
  /** Exactly what was pasted into the agent's pane (human → agent only). */
  wire: z.string().optional(),
  /** Which agent the wire text is addressed to: `manager`, `dev` or `fork-<qid>`. */
  target: z.string().optional(),
  /**
   * Agent → the owner only: true when the message asks the owner something (`lambda pod
   * reply --ask`) and so belongs in the owner's inbox; false/absent for FYIs and
   * acknowledgements (`--fyi`), which stay in the thread.
   */
  expectsReply: z.boolean().optional(),
  /**
   * The sidebar chat (the pod's `fork-chat`): the owner's messages there and the
   * fork's replies. Handed to the dev — with what the owner decided — the next time
   * the owner answers an item in the center (see `lambda pod fork handoff`).
   */
  chat: z.boolean().optional(),
  /**
   * A sidebar-chat message sent with ⌘⏎: "answer this, and keep the pod out
   * of my inbox until you do". The pod's items step aside until the chat
   * replies (see `chatHold` in the inbox app).
   */
  hold: z.boolean().optional(),
  /**
   * A progress note ("on it — reading the tickets"), not THE reply: it shows
   * in the item's chat but never brings the item back to the owner's inbox.
   */
  progress: z.boolean().optional(),
  /**
   * A reply to a message with several parts, split into question → answer
   * pairs (`reply --parts-file`): each `quote` is verbatim from the message
   * `replyTo`. The card and the audio show them interleaved.
   */
  replyTo: z.string().optional(),
  parts: z
    .array(z.object({ quote: z.string(), answer: z.string() }))
    .optional(),
  /**
   * A building pod's Blocked item for a ticket its visual check blocked: the
   * expected | actual composites, file names inside
   * `<pods root>/<pod>/visual/<picturesAt.ticketId>/<picturesAt.round>/`.
   */
  pictures: z.array(z.string()).optional(),
  picturesAt: z
    .object({ ticketId: z.string(), round: z.number().int().positive() })
    .optional(),
  /**
   * A building pod's "ready to review" ask (QA on): the owner approves it
   * (it merges) or sends it back with a note.
   */
  review: z.object({ ticketId: z.string() }).optional(),
  createdAt: z.string(),
});

export type ThreadEntry = z.infer<typeof ThreadEntrySchema>;

export const DeliveryEventSchema = z.object({
  msgId: id,
  status: z.enum(['delivered', 'received']),
  at: z.string(),
});

export type DeliveryEvent = z.infer<typeof DeliveryEventSchema>;

export type DeliveryStatus = 'pending' | 'delivered' | 'received';

export type ThreadMessage = ThreadEntry & { delivery: DeliveryStatus };

export const HumanDecisionSchema = z.object({
  id,
  podId: id,
  qid: id.optional(),
  decision: z.string().min(1),
  quote: z.string().min(1),
  /** The owner explicitly put this off ("later"), rather than deciding it. */
  deferred: z.boolean().optional(),
  createdAt: z.string(),
});

export type HumanDecision = z.infer<typeof HumanDecisionSchema>;

export const AutonomousDecisionSchema = z.object({
  id,
  podId: id,
  phase: z.number().int().min(1).max(5),
  /**
   * The HEADLINE the owner skims and hears: plain language, says what happened,
   * no ticket numbers, code names or file paths (see `headlineProblems`).
   */
  decision: z.string().min(1),
  /**
   * The situation that called for it — what was true, or what was wrong,
   * before this decision. Plain words, nothing assumed. The decision's
   * "Before" (like a ticket's Today). Required by `decide`.
   */
  before: z.string().optional(),
  /**
   * What it means for the people who use it — what they'll see or experience.
   * The decision's "After". Required by `decide` (optional here so older
   * decisions parse; `checkpoint post` refuses any without it). For an
   * engineering decision: what changes, in plain engineering terms.
   */
  means: z.string().optional(),
  /**
   * `product`: people will notice it. `engineering`: only the build does —
   * shown in its own group, collapsed and not read aloud by default.
   */
  kind: z.enum(['product', 'engineering']).optional(),
  /** The justification: why, in a sentence or two. Read aloud after the headline. */
  why: z.string().min(1),
  /** Build numbers of the tickets it affects ("2", "14b"). */
  tickets: z.array(z.string()).optional(),
  /** Expandable on the card, never spoken. Technical detail lives here. */
  details: z.string().optional(),
  /** A decision about what users see — its details must include an ASCII sketch. */
  ux: z.boolean().optional(),
  /**
   * The option NOT taken. A real decision has one; protocol ("planned the
   * epic I was given") does not — which is why `decide` requires it.
   * Optional here only so decisions logged before the rule still parse.
   */
  instead: z.string().optional(),
  intentRef: z.string().optional(),
  whyNoIntent: z.string().optional(),
  /** Withdrawn decisions (protocol, not a choice) never reach a checkpoint. */
  withdrawnAt: z.string().optional(),
  withdrawReason: z.string().optional(),
  createdAt: z.string(),
});

export type AutonomousDecision = z.infer<typeof AutonomousDecisionSchema>;

export const InboxSchema = z.object({
  /** Pod ids, highest priority first. Pods not listed sort after, oldest first. */
  priority: z.array(id),
});

export type Inbox = z.infer<typeof InboxSchema>;

export const FORK_STATES = [
  'warming',
  'active',
  'parked',
  'closing',
  'resolved',
  'dead',
] as const;

export type ForkState = (typeof FORK_STATES)[number];

export const ForkSchema = z.object({
  qid: id,
  podId: id,
  window: z.string(),
  state: z.enum(FORK_STATES),
  startedAt: z.string(),
  lastActivityAt: z.string(),
  resolvedAt: z.string().optional(),
  /** The sidebar chat fork (`qid: chat`): when its talk last went to the dev. */
  handedOffAt: z.string().optional(),
});

export type Fork = z.infer<typeof ForkSchema>;

export const TurnSchema = z.object({
  /** Last time something was sent to this agent's pane. */
  sentAt: z.string().optional(),
  /** Last UserPromptSubmit seen from this agent. */
  startedAt: z.string().optional(),
  /** Last Stop seen from this agent. */
  endedAt: z.string().optional(),
  /**
   * The session transcript this agent is writing (from the hook's
   * `transcript_path`). A resume or fork writes to a NEW file, so the watchdog
   * reads this, never a path guessed from the pod's original session id.
   */
  transcriptPath: z.string().optional(),
});

export type Turn = z.infer<typeof TurnSchema>;

/**
 * One line of `steps.jsonl`: a workflow step starting, finishing or being
 * skipped (reported by the dev with `lambda pod step`), or a note from the app's
 * watchdog. The workflow panel reads this for "where we're at", and its
 * history across pods for each step's numbers.
 */
export const StepEventSchema = z.object({
  at: z.string(),
  /** A step id from WORKFLOW, or `watchdog`. */
  step: z.string(),
  event: z.enum(['start', 'done', 'skip', 'note']),
  /** Who reported it: `dev`, `manager`, `watchdog`. */
  by: z.string().optional(),
  /** Which pass of a repeated step (red-flags passes). */
  pass: z.number().int().positive().optional(),
  /** Batch pods: the ticket this event is about (the inbox's ticket grid). */
  ticket: z.string().optional(),
  /** "7/11" — progress through a per-ticket step. */
  progress: z
    .string()
    .regex(/^\d+\/\d+$/)
    .optional(),
  /** What the step produced: fixes made, findings, tickets written. */
  found: z.number().int().nonnegative().optional(),
  note: z.string().optional(),
  /** `skip`: why ("no design"); a building pod's `visual-check` skip needs one. */
  reason: z.string().optional(),
});

export type StepEvent = z.infer<typeof StepEventSchema>;

/**
 * A work request: anything the owner asks a pod to DO, at any time ("rebase on
 * Epic 1", "add a ticket for the trail-closure banner"). The manager runs it at once —
 * interrupting the dev's turn — and while it is queued or running, every one
 * of the pod's inbox items steps aside, so nothing stale reaches the owner. Stored
 * one file per request under `requests/`.
 */
export const REQUEST_STATUSES = ['queued', 'working', 'done'] as const;

export const RequestSchema = z.object({
  /** r1, r2… */
  id,
  podId: id,
  /** One plain line: what to do (shown in the panel and the chat). */
  summary: z.string().min(1),
  /** The owner's exact words. */
  quote: z.string().min(1),
  /** The item on screen when the owner asked, if any. */
  qid: id.optional(),
  status: z.enum(REQUEST_STATUSES),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  doneAt: z.string().optional(),
  /** The dev's one-line result ("4 tickets changed, 2 decisions, 1 question"). */
  result: z.string().optional(),
  /** Stages it made stale (workflow stage ids, e.g. `ux-review`) — redone after. */
  invalidates: z.array(z.string()).optional(),
});

export type WorkRequest = z.infer<typeof RequestSchema>;

// ── building pods ───────────────────────────────────────────────────────────

export * from './buildingSchemas';

/**
 * A read-only fork the Product manager asks (`lambda pod ask`). Kept here, not
 * in buildingSchemas.ts: it needs this file's pod id shape.
 */
export const AskThreadSchema = z.object({
  id,
  podId: id,
  target: z.enum(['engineering-manager', 'dev']),
  /** Its own scratch window in the pod's session. */
  window: z.string(),
  /** The target's Claude session, the one the fork was made from. */
  sessionId: z.string(),
  startedAt: z.string(),
  lastUsedAt: z.string(),
  closedAt: z.string().optional(),
});

export type AskThread = z.infer<typeof AskThreadSchema>;
