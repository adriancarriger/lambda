/**
 * Argument validators for the commands that hand an argument to git, gh or
 * tmux. Each returns its input unchanged, or throws naming what it expected.
 */
const TICKET_ID = /^[A-Z]+-\d+$/;
const PANE_NAME = /^[\w-]+$/;
const WINDOW_TARGET = /^[\w-]+:[\w-]+$/;

export const assertTicketId = (ticketId: string): string => {
  if (!TICKET_ID.test(ticketId)) {
    throw new Error(
      `Not a ticket id: ${JSON.stringify(ticketId)} (expected e.g. DEMO-1)`,
    );
  }

  return ticketId;
};

export const assertPaneName = (pane: string): string => {
  if (!PANE_NAME.test(pane)) {
    throw new Error(
      `Not a pane name: ${JSON.stringify(pane)} (letters, digits, _ and - only)`,
    );
  }

  return pane;
};

export const assertWindowTarget = (target: string): string => {
  if (!WINDOW_TARGET.test(target)) {
    throw new Error(
      `Not a tmux window: ${JSON.stringify(target)} (expected session:window, e.g. lambda:ron)`,
    );
  }

  return target;
};
