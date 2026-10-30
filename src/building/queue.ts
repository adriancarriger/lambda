import {
  type Reporter,
  type Ticket,
  type TicketState,
  findNext,
  sameName,
} from '../tickets/source';

/**
 * A runner's queue: the ticket source's `next` order, skipping tickets
 * another runner has claimed (or anyone shipped), tickets someone else
 * reported, tickets assigned to another computer, tickets dependent on a
 * Blocked one, and the pod's skip list.
 */

export interface ClaimRow {
  ticketId: string;
  runnerId: string;
  /** Epoch ms; null until it ships. */
  shippedAt: number | null;
}

export interface QueueInput {
  tickets: Ticket[];
  /** The mothership's claims for this project. */
  claims: ClaimRow[];
  runnerId: string;
  /** The pod's skip list: left out for the life of the pod. */
  skipped: string[];
  /** The ticket this pod is building now: never queued again. */
  current?: string;
  /**
   * Blockers the tracker keeps out of `tickets` (Linear's archived issues,
   * another Jira project's), by status: what the source's own `next` uses.
   */
  outside?: ReadonlyMap<string, TicketState>;
  isOwners: (reporter: Reporter | null) => boolean;
  /**
   * This computer's name: a ticket assigned to anyone else (another
   * computer, or a person doing it by hand) is never taken here. Left out,
   * assignees are ignored.
   */
  computer?: string;
}

/** Is `ticket` assigned to a computer other than `computer`? */
export const assignedElsewhere = (
  ticket: Pick<Ticket, 'assignee'>,
  computer: string | undefined
): boolean =>
  computer !== undefined &&
  ticket.assignee !== null &&
  !sameName(ticket.assignee, computer);

/**
 * Each ticket as the queue sees it. A shipped claim is done whatever a copy
 * of the tickets says (a markdown file another computer never updated);
 * another runner's claim is under way; this pod's current ticket counts as
 * done, so what comes after it can be listed. A skipped or someone else's
 * ticket can't be taken, but still blocks what depends on it.
 */
const asQueued = (input: QueueInput) => {
  const claims = new Map(input.claims.map((claim) => [claim.ticketId, claim]));
  const skipped = new Set(input.skipped);

  return (ticket: Ticket): Ticket => {
    const claim = claims.get(ticket.id);
    const status = ((): TicketState => {
      if (claim?.shippedAt !== null && claim !== undefined) {
        return 'done';
      }

      if (ticket.id === input.current) {
        return 'done';
      }

      // Another runner's is under way. This runner's own, when it isn't the
      // current ticket, is a pick-up that never finished: takeable again.
      if (claim !== undefined && claim.runnerId !== input.runnerId) {
        return ticket.status === 'done' ? 'done' : 'building';
      }

      if (ticket.status === 'done') {
        return 'done';
      }

      // Someone else's, a sub-issue too: never this computer's to build. A
      // child keeps its place, so the epic's later children wait behind it.
      // Checked first: this runner's own leftover claim doesn't undo a skip.
      const theirs =
        !input.isOwners(ticket.reporter) ||
        assignedElsewhere(ticket, input.computer);

      if (skipped.has(ticket.id) || theirs) {
        return 'canceled';
      }

      // Its `building` may be this runner's own unfinished pick-up.
      return claim !== undefined && ticket.status === 'building'
        ? 'ready'
        : ticket.status;
    })();

    return {
      ...ticket,
      status,
      // A skipped child is left out of its parent, so the next one can run.
      children: ticket.children.filter((child) => !skipped.has(child)),
    };
  };
};

/** Every ticket this runner may take, in the order it would take them. */
export const buildQueue = (input: QueueInput): Ticket[] => {
  const start = input.tickets.map(asQueued(input));
  const take = (tickets: Ticket[], taken: Ticket[]): Ticket[] => {
    const next = findNext(tickets, {}, input.outside);

    // Each taken one is treated as done, which bounds this by the list.
    if (next === null || taken.length >= input.tickets.length) {
      return taken;
    }

    const original = input.tickets.find((ticket) => ticket.id === next.id);

    return take(
      tickets.map((ticket) =>
        ticket.id === next.id ? { ...ticket, status: 'done' } : ticket
      ),
      [...taken, original ?? next]
    );
  };

  return take(start, []);
};
