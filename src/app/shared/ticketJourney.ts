import type { TicketState } from '../../tickets/source';
import { formatMinutes, ticketTimeline } from './buildTimeline';
import type { TicketPage } from './building';
import type { ShippingGroups } from './shippingGroups';

/**
 * A ticket page's journey: planned → built Nm → checked → shipping together
 * → shipped. "Shipping together" is there while the ticket's group is open,
 * and stays once that group has shipped: it's part of how it got there.
 */
export const ticketJourney = (
  page: TicketPage,
  groups: Pick<ShippingGroups, 'groupOf' | 'shippedTickets'>
): string[] => {
  const { id, status } = page.ticket;
  // Every step the ticket reported, not just Build: a build whose end was
  // never reported is over once a later step started.
  const steps = [
    ...new Set(
      page.events
        .filter((event) => event.type === 'stage.start')
        .map((event) => event.name ?? '')
    ),
  ].map((step) => ({ id: step, label: step }));
  const built = ticketTimeline(page.events, id, steps).steps.find(
    (step) => step.id === 'build'
  );
  const reached = (states: TicketState[]): boolean => states.includes(status);
  const together =
    groups.groupOf(id) !== undefined || groups.shippedTickets.includes(id);

  // Built once its build has ended: an open build span counts up to now,
  // and a ticket still being built isn't built yet.
  return [
    'planned',
    ...(built !== undefined && built.status === 'done' && built.ms > 0
      ? [`built ${formatMinutes(built.ms)}`]
      : reached(['done'])
      ? ['built']
      : []),
    ...(page.verdict === 'COMPLETE' ? ['checked'] : []),
    ...(together ? ['shipping together'] : []),
    ...(status === 'done' ? ['shipped'] : []),
  ];
};
