import { z } from 'zod';

import { isOwnersReporter } from '../building/owner';
import type { Message } from '../protocol';
import type { Reporter } from '../tickets/source';
import type { Db } from './db';
import { str } from './http';
import { type Owner, listAliases } from './owner';
import { folderOf, projectOfFolder } from './registry';

/**
 * Which runner is building which ticket. The insert is the claim: a unique
 * conflict means another runner has it. A claim is released when its pod
 * ends or the ticket goes blocked before shipping, and kept once shipped.
 */

export type ClaimOutcome = 'claimed' | 'taken' | 'not-owner';

export interface Claim {
  ticketId: string;
  runnerId: string;
  /** Epoch ms; null until it ships. */
  shippedAt: number | null;
}

export const claimTicket = (
  db: Db,
  input: {
    projectId: string;
    ticketId: string;
    runnerId: string;
    reporter: Reporter | null;
    owner: Owner;
    now: number;
  }
): ClaimOutcome => {
  // The backstop: the runner already matched against its copy of the owner.
  if (
    !isOwnersReporter(input.reporter, {
      name: input.owner.name,
      email: input.owner.email,
      aliases: listAliases(db),
    })
  ) {
    return 'not-owner';
  }

  const { changes } = db
    .prepare(
      'INSERT OR IGNORE INTO ticket_claims (project_id, ticket_id, runner_id, claimed_at, shipped_at) VALUES (?, ?, ?, ?, NULL)'
    )
    .run(input.projectId, input.ticketId, input.runnerId, input.now);

  if (changes === 1) {
    return 'claimed';
  }

  // Its own claim, asked for again: a pick-up whose status update failed, or
  // one cut short before the runner recorded it, tries again.
  const held = db
    .prepare<
      [string, string],
      { runner_id: string; shipped_at: number | null }
    >(
      'SELECT runner_id, shipped_at FROM ticket_claims WHERE project_id = ? AND ticket_id = ?'
    )
    .get(input.projectId, input.ticketId);

  return held?.runner_id === input.runnerId && held.shipped_at === null
    ? 'claimed'
    : 'taken';
};

export const listClaims = (db: Db, projectId: string): Claim[] =>
  db
    .prepare<
      [string],
      { ticket_id: string; runner_id: string; shipped_at: number | null }
    >(
      'SELECT ticket_id, runner_id, shipped_at FROM ticket_claims WHERE project_id = ? ORDER BY claimed_at, ticket_id'
    )
    .all(projectId)
    .map((row) => ({
      ticketId: row.ticket_id,
      runnerId: row.runner_id,
      shippedAt: row.shipped_at,
    }));

/** Only the runner holding it, and never once shipped. */
export const releaseClaim = (
  db: Db,
  input: { projectId: string; ticketId: string; runnerId: string }
): boolean =>
  db
    .prepare(
      'DELETE FROM ticket_claims WHERE project_id = ? AND ticket_id = ? AND runner_id = ? AND shipped_at IS NULL'
    )
    .run(input.projectId, input.ticketId, input.runnerId).changes > 0;

/**
 * Recorded even with no row (a claim released by a stall, then a hand ship),
 * so no other runner builds the ticket again. Over another runner's claim it
 * stays that runner's, but is marked shipped, so its next `ticket-claims`
 * shows the ticket done. Never for a project that is gone (a queued ship is
 * acknowledged, not refused and resent forever).
 */
export const markClaimShipped = (
  db: Db,
  input: { projectId: string; ticketId: string; runnerId: string; now: number }
): boolean =>
  db
    .prepare(
      `INSERT INTO ticket_claims (project_id, ticket_id, runner_id, claimed_at, shipped_at)
       SELECT id, ?, ?, ?, ? FROM projects WHERE id = ?
       ON CONFLICT (project_id, ticket_id) DO UPDATE SET shipped_at = COALESCE(shipped_at, excluded.shipped_at)`
    )
    .run(input.ticketId, input.runnerId, input.now, input.now, input.projectId)
    .changes > 0;

const REPORTER = z
  .object({ name: z.string(), email: z.string().optional() })
  .nullable();

/**
 * A claim request's reporter: `{name, email?}`, or null for none. Anything
 * else is refused: "no reporter" counts as the owner's, so a malformed one
 * must never be read as none.
 */
export const reporterOf = (value: unknown): Reporter | null => {
  const parsed = REPORTER.safeParse(value);

  if (!parsed.success) {
    throw new Error("A claim's reporter must be {name, email?} or null.");
  }

  if (parsed.data === null) {
    return null;
  }

  const { name, email } = parsed.data;

  return email !== undefined && email !== '' ? { name, email } : { name };
};

export interface ClaimMessageContext {
  db: Db;
  /** The runner whose signed socket sent the message. */
  runnerId: string;
  owner: () => Owner;
  now: () => number;
  /** An outbox item already stored (the `received` table). */
  seen: (id: string) => boolean;
  markSeen: (id: string) => void;
}

/** The project of a runner's own folder; refused when it isn't one. */
const claimProject = (
  { db, runnerId }: ClaimMessageContext,
  message: Message
): string => {
  const folder = str(message, 'folder');
  const projectId = projectOfFolder(db, runnerId, folder);

  if (projectId === null) {
    throw new Error(`${folder} isn't a codebase of this computer.`);
  }

  return projectId;
};

/**
 * A queued release or ship may arrive after its folder was re-linked from
 * another checkout, or after the runner let the project go: it names the
 * project, and the claim row's runner is the check (`releaseClaim` touches
 * only the runner's own claim; `markClaimShipped` never changes whose a
 * claim is). Items queued
 * before `projectId` rode along fall back to the folder; null when that
 * folder is no longer the runner's, or the named project is one the runner
 * neither holds nor has a claim in, so the item is acknowledged, not
 * refused and resent forever.
 */
const queuedClaimProject = (
  { db, runnerId }: ClaimMessageContext,
  message: Message
): string | null => {
  if (message.projectId === undefined) {
    return projectOfFolder(db, runnerId, str(message, 'folder'));
  }

  const projectId = str(message, 'projectId');
  const hasClaim =
    db
      .prepare<[string, string], { n: number }>(
        'SELECT 1 AS n FROM ticket_claims WHERE project_id = ? AND runner_id = ? LIMIT 1'
      )
      .get(projectId, runnerId) !== undefined;

  return hasClaim || folderOf(db, runnerId, projectId) !== null
    ? projectId
    : null;
};

/**
 * A runner's `ticket-claim`, `ticket-claims`, `ticket-release` or
 * `ticket-shipped`: the result to answer it with. Throws to refuse.
 */
export const handleClaimMessage = (
  context: ClaimMessageContext,
  message: Message
): unknown => {
  const { db, runnerId } = context;

  switch (message.type) {
    case 'ticket-claim':
      // The claim is the signed socket's: a body naming another runner is
      // refused, never written.
      if (message.runnerId !== undefined && message.runnerId !== runnerId) {
        throw new Error('A computer can only claim tickets for itself.');
      }

      if (!('reporter' in message)) {
        throw new Error('A claim says who reported the ticket.');
      }

      return {
        outcome: claimTicket(db, {
          projectId: claimProject(context, message),
          ticketId: str(message, 'ticketId'),
          runnerId,
          reporter: reporterOf(message.reporter),
          owner: context.owner(),
          now: context.now(),
        }),
      };
    case 'ticket-claims':
      return { claims: listClaims(db, claimProject(context, message)) };
    case 'ticket-release':
    case 'ticket-shipped': {
      const outboxId = str(message, 'id');

      if (context.seen(outboxId)) {
        return 'duplicate';
      }

      const ticketId = str(message, 'ticketId');
      const projectId = queuedClaimProject(context, message);

      if (projectId === null) {
        context.markSeen(outboxId);

        return 'unchanged';
      }

      const claim = { projectId, ticketId, runnerId };
      const changed =
        message.type === 'ticket-release'
          ? releaseClaim(db, claim)
          : markClaimShipped(db, { ...claim, now: context.now() });
      context.markSeen(outboxId);

      return changed ? 'stored' : 'unchanged';
    }
    default:
      throw new Error(`${message.type} isn't a claim message.`);
  }
};
