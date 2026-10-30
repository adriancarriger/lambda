/**
 * An epic and its children, through the ticket interface, so pods read them
 * the same way on every tracker.
 */
import {
  type Ticket,
  type TicketSource,
  assertTicketId,
  unknownTicket,
} from './source';

export interface EpicChild {
  id: string;
  title: string;
}

/** The epic (or a lone ticket) and its children's ids. */
export const findEpic = async (
  source: TicketSource,
  id: string
): Promise<{ id: string; title: string; children: string[] }> => {
  const ticket = await source.get(assertTicketId(id));

  return { id: ticket.id, title: ticket.title, children: ticket.children };
};

/**
 * The epic's live children, in queue order: what a checkpoint's ticket list
 * must cover. Canceled ones are left out. One `list`, so a tracker is
 * scanned once.
 */
export const listEpicChildren = async (
  source: TicketSource,
  epicId: string
): Promise<EpicChild[]> => {
  assertTicketId(epicId);
  const all = await source.list();
  const byId = new Map(
    all.map((ticket): [string, Ticket] => [ticket.id, ticket])
  );
  const epic = byId.get(epicId);

  if (epic === undefined) {
    throw unknownTicket(epicId);
  }

  return epic.children
    .map((child) => byId.get(child))
    .filter(
      (child): child is Ticket =>
        child !== undefined && child.status !== 'canceled'
    )
    .map((child) => ({ id: child.id, title: child.title }));
};
