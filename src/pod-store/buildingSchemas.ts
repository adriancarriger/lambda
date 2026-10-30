import { z } from 'zod';

/**
 * The building pods' persisted shapes: the tickets a pod took, its own
 * `building.json`, qa's screenshots, check-ticket verdicts and ticket
 * summaries. Re-exported from `schemas.ts`, so import them from there.
 */

/**
 * One ticket a building pod took, from pick-up to shipped or blocked. Kept in
 * `building.json` (`runs`, oldest first): the last run with neither
 * `shippedAt` nor `blocked` is the pod's current ticket.
 */
export const BuildTicketRunSchema = z.object({
  /** The ticket id. */
  id: z.string().min(1),
  title: z.string(),
  /** The step it's on (a building workflow step id). */
  step: z.string(),
  /** The attempt at that step: the nth `start` of it for this ticket. */
  attempt: z.number().int().positive(),
  startedAt: z.string(),
  shippedAt: z.string().optional(),
  /** Set when it went blocked (`lambda pod blocked`, or a second stall). */
  blocked: z
    .object({
      at: z.string(),
      what: z.string(),
      problem: z.string(),
      options: z.string(),
      recommendation: z.string(),
      /**
       * The owner's Blocked item for it: settled once the owner answers it
       * (an answer `about` it, delivered to the Engineering manager) or the
       * ticket is back in the queue (Up next) or picked up again. A chat to
       * the Product manager never settles it.
       */
      messageId: z.string().optional(),
      /** Its work's stash (`git stash list`), when it left any. */
      setAside: z.string().optional(),
      /**
       * Tickets the same problem held right after it, folded into its item:
       * never started, so put back to Ready instead of blocked.
       */
      alsoHeld: z
        .array(
          z.object({
            id: z.string(),
            title: z.string(),
            at: z.string(),
            problem: z.string(),
          })
        )
        .optional(),
    })
    .optional(),
  /** The project's `commands.pickUp`, as run for it before it was built. */
  prepared: z.string().optional(),
  /**
   * The mothership's claim on it: `claimed` once taken, `released` once the
   * runner told the mothership it was let go (blocked, or the pod ended).
   */
  claim: z.enum(['claimed', 'released']).optional(),
  /** The runner has told the mothership it shipped. */
  shipReported: z.boolean().optional(),
  /**
   * The Engineering manager has been told it was picked up: false until
   * that message went, so a failed send is sent again. A run written
   * before this was kept has none, and was told.
   */
  announced: z.boolean().optional(),
});

export type BuildTicketRun = z.infer<typeof BuildTicketRunSchema>;

/** A building pod's own state, `<pod>/building.json`. */
export const BuildingStateSchema = z.object({
  runs: z.array(BuildTicketRunSchema),
  /**
   * This runner's queue after the current ticket, in queue order, as of the
   * last pick-up or poll: the Tickets rail's Up next and "ticket N of M".
   */
  upNext: z.array(z.object({ id: z.string(), title: z.string() })).default([]),
  /** The last time the ticket source was asked for a Ready ticket (ISO). */
  polledAt: z.string().optional(),
  /** Why the last pick-up took nothing ("Nothing ready to build", unreachable). */
  idleReason: z.string().optional(),
  /** The stall watch on the current step (see building/stall.ts). */
  stall: z
    .object({
      ticket: z.string(),
      step: z.string(),
      attempt: z.number().int().positive(),
      /** When the step last showed life: a step event or a pane change. */
      quietSince: z.string(),
      /** A hash of the three panes' captures at `quietSince`. */
      panes: z.string(),
      nudgedAt: z.string().optional(),
      /** Why the nudge went: everyone idle, or a turn frozen for hours. */
      nudgedFor: z.enum(['idle', 'hung']).optional(),
      /** Since when no agent has had a turn or a command running. */
      idleSince: z.string().optional(),
    })
    .optional(),
  /** The Product manager window's lifecycle (see building/productManager.ts). */
  productManager: z
    .object({
      /** Its window is open. */
      awake: z.boolean(),
      /** The last chat message to it, or reply from it (ISO). */
      lastActivityAt: z.string(),
    })
    .optional(),
  /**
   * The last pause, kept until Resume: its windows stay open, so Resume
   * tells the Engineering manager who was stopped mid-turn, and on what.
   */
  /**
   * Roles started fresh while the pod was paused: told nothing then, so
   * resuming sends each its opening message first.
   */
  unbriefed: z.array(z.string()).optional(),
  pause: z
    .object({
      at: z.string(),
      /** The agents Escape stopped mid-turn (the idle ones were left alone). */
      interrupted: z.array(z.string()),
      /** The ticket being built when it was paused. */
      ticket: z.string().optional(),
      /** Lambda paused it itself (see building/breaker.ts): why. */
      reason: z.string().optional(),
    })
    .optional(),
  /** The last Resume: blocks before it no longer count toward a pause. */
  resumedAt: z.string().optional(),
});

export type BuildingState = z.infer<typeof BuildingStateSchema>;

/**
 * One screenshot qa recorded during a test attempt:
 * `<pods root>/<pod>/screenshots/<ticket>/<attempt>/manifest.json` lists them.
 */
export const ScreenshotSchema = z.object({
  /** The PNG's file name in that folder. */
  file: z.string(),
  ticketId: z.string(),
  attempt: z.number().int().positive(),
  url: z.string(),
  consoleErrors: z.array(z.string()),
  /** The tester's one-line conclusion. */
  conclusion: z.string(),
  passed: z.boolean(),
  at: z.string(),
});

export type Screenshot = z.infer<typeof ScreenshotSchema>;

export const ScreenshotManifestSchema = z.array(ScreenshotSchema);

/**
 * A check-ticket verdict, at `<project>/<verdicts.dir>/<id>.json`. Extra
 * fields another tool wrote are ignored, never refused.
 */
export const VerdictSchema = z.object({
  ticketId: z.string(),
  verdict: z.enum(['COMPLETE', 'INCOMPLETE']),
  failedDimensions: z.array(z.string()),
  deviations: z.array(z.string()),
  recordedAt: z.string(),
  /** Provenance only (absent in a non-git folder); never compared. */
  headSha: z.string().optional(),
});

export type Verdict = z.infer<typeof VerdictSchema>;

/**
 * A ticket's plain summary for the Tickets screen, cached by ticket id. From
 * the checkpoint that planned it (`planning`), else written by the Product
 * manager (`product-manager`) and rewritten when the description changes.
 */
export const TicketSummarySchema = z.object({
  ticketId: z.string(),
  name: z.string(),
  today: z.string(),
  after: z.string(),
  /** SHA-256 of the ticket's description text when it was written. */
  sourceHash: z.string(),
  by: z.enum(['planning', 'product-manager']),
  /** The pod it was planned in, for the "Planned in" link. */
  podId: z.string().optional(),
});

export type TicketSummary = z.infer<typeof TicketSummarySchema>;
