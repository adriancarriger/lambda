import type { Reporter, Ticket, TicketSource } from '../tickets/source';
import { type OwnerIdentity, isOwnersReporter } from './owner';
import { type ClaimRow, buildQueue } from './queue';

/**
 * Pick-up: the next ticket in this runner's queue, claimed at the mothership
 * before anything is built. The claim is one atomic insert there, so two
 * runners on one project never take the same ticket: a lost claim moves on
 * to the next in the queue. Once claimed, the ticket is set `building`.
 *
 * Never on a checkout with uncommitted work: the next ship would commit it
 * under the new ticket's id. Nothing is claimed until it's clean.
 *
 * The owner is the mothership's copy (its `owner` message), never this
 * computer's own config. None yet, or the mothership unreachable: nothing is
 * started, and the caller asks again later.
 */

export type ClaimOutcome = 'claimed' | 'taken' | 'not-owner';

export interface PickUpDeps {
  source: TicketSource;
  owner: OwnerIdentity | null;
  runnerId: string;
  /** This computer's name: tickets assigned elsewhere are skipped. */
  computer?: string;
  skipped: string[];
  /** The mothership's claims for this project; throws when unreachable. */
  claims: () => Promise<ClaimRow[]>;
  /** One claim; throws when unreachable. */
  claim: (ticketId: string, reporter: Reporter | null) => Promise<ClaimOutcome>;
  /** Let a claim go (an outbox item: kept until the mothership has it). */
  release: (ticketId: string) => void;
  /** The checkout's uncommitted changes; none, when left out. */
  uncommitted?: () => string[];
}

export type PickUpResult =
  | { kind: 'picked'; ticket: Ticket; upNext: Ticket[] }
  /**
   * Nothing to take. `notYours`: Ready tickets passed over because someone
   * other than the owner reported them, so the idle line can say so.
   */
  | { kind: 'nothing'; notYours: Ticket[] }
  | { kind: 'unreachable' }
  /** The checkout has uncommitted work: nothing is claimed. */
  | { kind: 'dirty'; changes: number }
  /** Claimed, but the ticket couldn't be set `building`: the claim is let go. */
  | { kind: 'failed'; ticketId: string; reason: string };

const firstClaimed = async (
  queue: Ticket[],
  claim: PickUpDeps['claim']
): Promise<Ticket | null> => {
  const [first, ...rest] = queue;

  if (first === undefined) {
    return null;
  }

  // `taken`: another runner won it. `not-owner`: the mothership's backstop.
  return (await claim(first.id, first.reporter)) === 'claimed'
    ? first
    : firstClaimed(rest, claim);
};

export const pickUp = async (deps: PickUpDeps): Promise<PickUpResult> => {
  const { owner } = deps;

  if (owner === null) {
    return { kind: 'unreachable' };
  }

  const changes = deps.uncommitted?.().length ?? 0;

  if (changes > 0) {
    return { kind: 'dirty', changes };
  }

  const { tickets, outside } = await deps.source.queue();
  const queueOf = (claims: ClaimRow[], current?: string) =>
    buildQueue({
      tickets,
      outside,
      claims,
      runnerId: deps.runnerId,
      skipped: deps.skipped,
      current,
      isOwners: (reporter) => isOwnersReporter(reporter, owner),
      computer: deps.computer,
    });

  try {
    const claims = await deps.claims();
    const picked = await firstClaimed(queueOf(claims), deps.claim);

    if (picked === null) {
      return {
        kind: 'nothing',
        notYours: tickets.filter(
          (ticket) =>
            ticket.status === 'ready' &&
            !isOwnersReporter(ticket.reporter, owner)
        ),
      };
    }

    // Claimed but never set building, the ticket would be held for ever:
    // the claim goes, and the next pick-up tries again.
    const failure = await deps.source
      .update(picked.id, { status: 'building' })
      .then(
        () => null,
        (error: unknown) =>
          error instanceof Error ? error.message : String(error)
      );

    if (failure !== null) {
      deps.release(picked.id);

      return { kind: 'failed', ticketId: picked.id, reason: failure };
    }

    return {
      kind: 'picked',
      ticket: picked,
      upNext: queueOf(claims, picked.id),
    };
  } catch (error) {
    if (error instanceof Error && /reach Lambda/i.test(error.message)) {
      return { kind: 'unreachable' };
    }

    throw error;
  }
};
