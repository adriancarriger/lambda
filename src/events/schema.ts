import { z } from 'zod';

/**
 * One event, from `lambda event` or a line of `.lambda/events.jsonl` (the
 * same door): a stage, attempt or ship starting or ending, or a metric.
 * Building pods add the `group.*` types.
 */
export const EVENT_TYPES = [
  'stage.start',
  'stage.end',
  'attempt.start',
  'attempt.end',
  'ship.start',
  'ship.end',
  'metric',
  // A project's own "shipping together" groups. Lambda never
  // makes one: they come only from the project, as these events.
  'group.add',
  'group.reason',
  'group.hold',
  'group.release',
  'group.shipping',
  'group.shipped',
  // A person's change on the Tickets screen: `name` is the field
  // (`priority`, `assignee`, `status`, …), `note` what it became, `source`
  // who made it. `ticket.create` for a ticket made there.
  'ticket.edit',
  'ticket.create',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const EventLineSchema = z.object({
  type: z.string().min(1),
  name: z.string().optional(),
  result: z.enum(['pass', 'fail']).optional(),
  note: z.string().optional(),
  value: z.number().optional(),
  unit: z.string().optional(),
  ticket: z.string().optional(),
  attempt: z.number().int().positive().optional(),
  /** `group.*`: the group's id. */
  groupId: z.string().min(1).optional(),
  /**
   * `group.reason`: why it's held ("Ships when the epic completes, 1 left").
   * A skipped stage's `stage.end`: why it was skipped ("no design").
   */
  reason: z.string().optional(),
  /** `group.hold`: whether it's held. */
  held: z.boolean().optional(),
  /** `stage.end`: the stage never ran, it was skipped (Lambda's own steps). */
  skipped: z.boolean().optional(),
  /** ISO time; filled in when it's missing. */
  at: z.string().optional(),
});

export type EventLine = z.infer<typeof EventLineSchema>;

/** What a runner forwards: the line plus where it came from. */
export interface ForwardedEvent extends EventLine {
  at: string;
  pod?: string;
  /** `lambda` for Lambda's own steps (a pod's steps.jsonl). */
  source?: string;
  /** Set when the line couldn't be read: kept, shown as a warning. */
  warning?: string;
  /** A bad line's text, as written. */
  raw?: string;
}

export interface StoredEvent {
  id: string;
  /** The file's generation when the line was read: 0 until it is rewritten. */
  generation: number;
  projectId: string | null;
  pod: string | null;
  ticket: string | null;
  attempt: number | null;
  groupId: string | null;
  reason: string | null;
  held: boolean | null;
  skipped: boolean | null;
  type: string;
  name: string | null;
  result: string | null;
  note: string | null;
  value: number | null;
  unit: string | null;
  source: string | null;
  at: number;
  receivedAt: number;
  warning: string | null;
}

export const isKnownType = (type: string): type is EventType =>
  EVENT_TYPES.some((known) => known === type);
