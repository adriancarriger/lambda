import { type Project } from '../../config/projectConfig';
import { type Ticket, type TicketSource } from '../../tickets/source';
import { defaultBranchRef } from './git';
import { readManifestOnBranch } from './manifest';

/**
 * Making a project's design system the first time is an ordinary ticket,
 * created in Ready by Settings → Design system's Make it and built by a
 * building pod like any other. Only when the project has none: a manifest on
 * its default branch, or an open setup ticket, means nothing is created.
 */

export const SETUP_TICKET_TITLE = 'Make the design system from the app';

/** Statuses after which a setup ticket no longer counts as open. */
const CLOSED: Ticket['status'][] = ['done', 'canceled'];

export const setupTicketBody = ({
  dir,
  by,
}: {
  dir: string;
  by: string;
}): string =>
  [
    "Pull the app's look into a new design system. One direction only: from the app to the design system. Never change the app's own code.",
    '',
    `Design system: ${dir} (lambda.json design.system.dir)`,
    "There's no design system yet: make one in this folder.",
    `Asked for by ${by} from Settings.`,
    '',
    '1. Read the app: lambda design system detect.',
    `2. Write the design system's source in ${dir}: the bundle entry, the catalog, the components it re-exports from the app, the pattern copies (hand-made copies of app pieces that can't run in a canvas), the source map (sources.json), one sample data set (sampleData.ts) and the reference screens (screens/).`,
    '3. Build and check it: lambda design system build --check. Fix what it names in the design system, never in the app.',
    '4. Photograph 3 to 5 real screens with the photo hook, draw each as a reference screen with the design system and the sample data, and grade each pair on the visual severity scale.',
    '5. Loop: fix the design system and repeat from step 3 until lambda design system round record says MATCH or CLOSE. Round 7 is the most.',
    "6. Write the manifest with lambda design system manifest write, post the last round's pictures on this ticket, and ship it as usual.",
    '',
    "The full steps are Lambda's design-system-setup instructions.",
  ].join('\n');

/** Whether a ticket is the setup ticket: its exact title. */
export const isSetupTicket = (ticket: Pick<Ticket, 'title'>): boolean =>
  ticket.title === SETUP_TICKET_TITLE;

/** The project's open setup ticket, from a ticket list. */
export const openSetupTicket = (tickets: Ticket[]): Ticket | undefined =>
  tickets.find(
    (ticket) => isSetupTicket(ticket) && !CLOSED.includes(ticket.status)
  );

export interface SetupTicketResult {
  id: string;
  title: string;
  url: string | null;
  status: Ticket['status'];
  /** The open ticket that was already there; nothing was created. */
  existing: boolean;
}

/** Refused: the project already has a design system on its default branch. */
export class HasDesignSystemError extends Error {}

export const alreadyHasMessage = (projectName: string): string =>
  `${projectName} already has a design system.`;

const reasonOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/\.+$/, '');

interface SetupTicketInput {
  project: Project;
  /** The project's name as Lambda shows it. */
  projectName: string;
  /** Who pressed Make it. */
  by: string;
  source: TicketSource;
  /** Where "has a design system" is read: origin's default branch. */
  ref?: string;
}

/**
 * Each project's last Make it, settled or not. List-then-create isn't
 * atomic, so two presses at once would both find no ticket and both create
 * one: the second waits for the first and finds its ticket.
 */
const making = new Map<string, Promise<unknown>>();

const oneAtATime = <T>(root: string, run: () => Promise<T>): Promise<T> => {
  const next = (making.get(root) ?? Promise.resolve())
    .catch(() => undefined)
    .then(run);
  const settled = next.catch(() => undefined);
  making.set(root, settled);
  void settled.then(() => {
    if (making.get(root) === settled) {
      making.delete(root);
    }
  });

  return next;
};

/**
 * Create the setup ticket, or return the open one. Throws
 * `HasDesignSystemError` (nothing listed or created) when the default branch
 * has a manifest, and "Couldn't create the design system ticket: <reason>."
 * when the tracker fails. One at a time per project.
 */
export const createSetupTicket = (
  input: SetupTicketInput
): Promise<SetupTicketResult> =>
  oneAtATime(input.project.root, () => createOne(input));

const createOne = async ({
  project,
  projectName,
  by,
  source,
  ref = defaultBranchRef(project.root),
}: SetupTicketInput): Promise<SetupTicketResult> => {
  const { dir, manifest } = project.config.design.system;

  if (readManifestOnBranch(project.root, ref, manifest) !== null) {
    throw new HasDesignSystemError(alreadyHasMessage(projectName));
  }

  try {
    const open = openSetupTicket(await source.list());

    if (open !== undefined) {
      return {
        id: open.id,
        title: open.title,
        url: open.url,
        status: open.status,
        existing: true,
      };
    }

    const created = await source.create({
      title: SETUP_TICKET_TITLE,
      status: 'ready',
      description: setupTicketBody({ dir, by }),
    });

    return {
      id: created.id,
      title: created.title,
      url: created.url,
      status: created.status,
      existing: false,
    };
  } catch (error) {
    throw new Error(
      `Couldn't create the design system ticket: ${reasonOf(error)}.`
    );
  }
};
