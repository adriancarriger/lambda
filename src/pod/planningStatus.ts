/**
 * A ticket a planning pod picks up moves to `planning`, so the tracker says
 * where everything is: `planning` (a pod is planning it) → `ready` (planned,
 * waiting to be built) → the build.
 *
 * Only a ticket that hasn't started building moves: one in the `inbox`
 * (where every new ticket lands), or one that is `ready` — re-planning a
 * ready ticket takes it out of the build queue until it is planned again. Anything building, blocked or closed is left alone and
 * named. An epic brings its open children.
 */
import { type Ticket, type TicketSource } from '../tickets/source';

export const PLANNING = 'planning';
const MOVABLE: Ticket['status'][] = ['inbox', 'ready'];

const isOpen = (ticket: Ticket): boolean =>
  ticket.status !== 'done' && ticket.status !== 'canceled';

/** Which of these move to planning, and which are left where they are. */
export const planningMoves = (
  tickets: Ticket[]
): { move: Ticket[]; leave: Ticket[] } => ({
  move: tickets.filter((ticket) => MOVABLE.includes(ticket.status)),
  leave: tickets.filter(
    (ticket) => ticket.status !== PLANNING && !MOVABLE.includes(ticket.status)
  ),
});

/** One id → itself and its open children. */
const readTarget = async (
  source: TicketSource,
  id: string
): Promise<Ticket[]> => {
  const ticket = await source.get(id);
  const children = await Promise.all(
    ticket.children.map((child) => source.get(child))
  );

  return [ticket, ...children.filter(isOpen)];
};

/**
 * Move a pod's tickets (an epic with its children, a lone ticket, or a
 * batch) to planning. Prints one line per ticket it moved or left.
 */
export const markPlanning = async (
  source: TicketSource,
  ids: string[]
): Promise<void> => {
  const targets = await Promise.all(
    ids.map((id) => readTarget(source, id.trim()))
  );
  const { move, leave } = planningMoves(
    targets
      .flat()
      .filter(
        (ticket, index, all) =>
          all.findIndex((other) => other.id === ticket.id) === index
      )
  );

  await move.reduce(async (previous, ticket) => {
    await previous;
    await source.update(ticket.id, { status: PLANNING });
  }, Promise.resolve());
  move.forEach((ticket) =>
    console.log(`  ${ticket.id}: ${ticket.status} → ${PLANNING}`)
  );
  leave.forEach((ticket) =>
    console.log(
      `  ${ticket.id}: left in ${ticket.status} (only inbox and ready tickets move to ${PLANNING})`
    )
  );
};

/** The tickets a structured pod plans (none for a new idea). */
export const podTicketIds = (pod: {
  epicId?: string;
  tickets?: string[];
}): string[] =>
  pod.tickets !== undefined && pod.tickets.length > 0
    ? pod.tickets
    : pod.epicId === undefined
    ? []
    : [pod.epicId];

/**
 * Planning has started on these: move them, and say so. A tracker failure is
 * printed, never thrown — the pod still starts, and the dev can move them.
 */
export const startPlanning = async (
  source: () => TicketSource,
  ids: string[]
): Promise<void> => {
  if (ids.length === 0) {
    return;
  }

  console.log(`Moving to ${PLANNING}: ${ids.join(', ')}`);
  await Promise.resolve()
    .then(() => markPlanning(source(), ids))
    .catch((error: unknown) =>
      console.log(
        `  ⚠ Couldn't move them to ${PLANNING} (${
          error instanceof Error ? error.message : String(error)
        }). Move them by hand: lambda tickets update <id> --status ${PLANNING}`
      )
    );
};
