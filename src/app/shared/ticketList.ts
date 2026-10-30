import { type GroupEvent, shippingGroups } from './shippingGroups';

/**
 * The Tickets screen's helpers shared by the list and a ticket's page: keys,
 * shipping-together membership, refresh timing and links out. The list's
 * groups and filters are ticketBoard.ts.
 */

/** A ticket's key across projects (a ticket id is only unique in one). */
export const ticketKey = (projectId: string, ticketId: string): string =>
  `${projectId}\u0000${ticketId}`;

/** `<project>/<ticket>` keys of every ticket in an open shipping-together group. */
export const openGroupKeys = (
  events: GroupEvent[],
  projectId: string
): Set<string> =>
  new Set(
    shippingGroups(events).open.flatMap((group) =>
      group.tickets.map((ticketId) => ticketKey(projectId, ticketId))
    )
  );

/** One project's open-group keys per project, from the screen's group events. */
export const openGroupKeysByProject = (
  events: (GroupEvent & { projectId: string })[]
): Set<string> =>
  new Set(
    [...new Set(events.map((event) => event.projectId))].flatMap(
      (projectId) => [
        ...openGroupKeys(
          events.filter((event) => event.projectId === projectId),
          projectId
        ),
      ]
    )
  );

/**
 * Each read of the Tickets screen asks every project's source (Linear, Jira)
 * again, so it isn't re-read on every app event — only once this long has
 * passed since the last read. The first read is always due. While a ticket's
 * summary is being written its page looks for it more often, but still not
 * on every event.
 */
export const TICKETS_REFRESH_MS = 60_000;
export const SUMMARY_REFRESH_MS = 5_000;

export const ticketsRefreshDue = (
  lastAt: number | null,
  now: number,
  writing = false
): boolean =>
  lastAt === null ||
  now - lastAt >= (writing ? SUMMARY_REFRESH_MS : TICKETS_REFRESH_MS);

/**
 * A ticket's address as a link, or null: a tracker's text isn't trusted, so
 * only an http or https address becomes an `href`.
 */
export const linkOf = (url: string | null): string | null => {
  try {
    return url !== null && ['http:', 'https:'].includes(new URL(url).protocol)
      ? url
      : null;
  } catch {
    return null;
  }
};

/** The tracker a ticket links out to, by its own source; none for the rest. */
export const sourceLabel = (source: string): string | null =>
  ({ linear: 'Linear', jira: 'Jira' }[source] ?? null);

/**
 * What "Talk about this ticket" sends, or null: nothing while a send is in
 * flight, so a double click doesn't start two conversations.
 */
export const talkToSend = (text: string, sending: boolean): string | null =>
  sending || text.trim() === '' ? null : text.trim();
