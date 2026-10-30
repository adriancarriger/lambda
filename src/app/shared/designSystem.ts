/**
 * Settings → Design system: the page state a runner builds from the design
 * system as committed on the project's main branch, and the lines the page
 * shows for it. Every computer reads the same commit, so every computer
 * shows the same thing.
 */

export type DesignSeverityLabel = 'high' | 'medium' | 'medium-low' | 'low';

export type SetupTicketStatus =
  | 'inbox'
  | 'planning'
  | 'ready'
  | 'building'
  | 'blocked'
  | 'done'
  | 'canceled';

export interface DesignSystemTicket {
  id: string;
  title: string;
  url: string | null;
  status: SetupTicketStatus;
  blockReason: string | null;
}

export interface DesignSystemCheck {
  result: 'match' | 'close' | 'not-checked';
  rounds: number;
  photos: number;
  issues: { severity: DesignSeverityLabel; where: string; what: string }[];
  reason?: string;
}

/** The newest commit on main that touched the design system. */
export interface LastChange {
  /** The subject's leading `<PREFIX>-<n>`, else the whole subject. */
  ticket: string;
  /** Short sha. */
  sha: string;
  /** The rest of the subject; empty when there was no ticket id. */
  rest: string;
}

export interface DesignSystemInfo {
  /** Null: made by hand, not by Lambda. */
  version: number | null;
  madeByHand: boolean;
  syncedBy: string | null;
  builtFrom: string | null;
  source: 'code' | 'photos' | 'code+photos' | null;
  check: DesignSystemCheck | null;
  components: string[];
  patterns: string[];
  /** Reference screens' titles. */
  screens: string[];
  sampleData: boolean;
  /** Null when the newest such commit is the one that made it. */
  lastChanged: LastChange | null;
  /** The ticket that made it (`syncedBy`), where its pictures are. */
  picturesUrl: string | null;
}

export interface DesignSystemPage {
  project: string;
  /** The default branch, as "main". */
  branch: string;
  dir: string;
  /** `detect`'s Look line ("tailwind.config.ts", or "none"). */
  look: string;
  /** `detect`'s Components line ("12 — Button, …", or "none — …"). */
  components: string;
  /**
   * Whether Claude Design works with this computer's Claude account; null
   * when it was never checked (or the config couldn't be read): only an
   * explicit false greys Make it.
   */
  designAvailable: boolean | null;
  /** The open setup ticket, if any. */
  setupTicket: DesignSystemTicket | null;
  /** Null: no manifest on main. */
  system: DesignSystemInfo | null;
  /** Why the setup ticket and the pictures' link are missing, when the tickets couldn't be read. */
  ticketsError: string | null;
}

/** What Make it answers. */
export interface MadeDesignSystem {
  id: string;
  title: string;
  url: string | null;
  existing: boolean;
}

export const DEFAULT_LOOK = "Designs use Claude Design's default look.";
export const NEEDS_CLAUDE_DESIGN =
  "Needs Claude Design, which isn't available with this Claude account.";
export const KEPT_IN_STEP =
  'Kept in step by the build: a ticket that changes how the app looks updates the design system too.';
export const MAKE_IT_EXPLAINED =
  'Make it creates a ticket, "Make the design system from the app", in Ready. A building pod makes it from the app.';
export const MADE_BY_HAND = 'Made by hand, not by Lambda.';
export const PHOTOS_ONLY =
  "Made from photos only: Lambda couldn't find this app's theme or components in the code, so designs look like the app but use stand-in parts.";
export const SAMPLE_DATA =
  'Sample data: one set, the one every design draws from';

/**
 * Whether the heartbeat reads the page again: only after a failed read (the
 * computer was offline), never over a read on its way. A failed Make it isn't
 * a read: its message stays until the next press or another project.
 */
export const rereadsDesignSystem = (now: {
  readError: string | null;
  busy: boolean;
}): boolean => now.readError !== null && !now.busy;

/** Something Make it answered, kept with the project it was pressed on. */
export interface ForProject<T> {
  projectId: string;
  value: T;
}

/** Make it's answer, only on the page of the project it was pressed on. */
export const forProject = <T>(
  answered: ForProject<T> | null,
  projectId: string
): T | null =>
  answered !== null && answered.projectId === projectId ? answered.value : null;

/** Make it shows only with no design system on main and no open setup ticket. */
export const showsMakeIt = (page: DesignSystemPage): boolean =>
  page.system === null && page.setupTicket === null;

const SEVERITY_LABEL: Record<DesignSeverityLabel, string> = {
  high: 'High',
  medium: 'Medium',
  'medium-low': 'Medium-low',
  low: 'Low',
};

const withoutStop = (text: string): string => text.trim().replace(/\.+$/, '');

const shortList = (names: string[], max = 5): string =>
  names.length > max
    ? `${names.slice(0, max).join(', ')}, …`
    : names.join(', ');

export const issueLine = (issue: DesignSystemCheck['issues'][number]): string =>
  `${SEVERITY_LABEL[issue.severity]} · ${issue.where}: ${issue.what}`;

/** "Matches the app, with 1 small difference:" and its issues, or the reason it wasn't checked. */
export const checkLines = (check: DesignSystemCheck): string[] => {
  if (check.result === 'not-checked') {
    return [
      check.reason === undefined || check.reason.trim() === ''
        ? 'Not checked against the app.'
        : `Not checked against the app: ${withoutStop(check.reason)}.`,
    ];
  }

  const count = check.issues.length;

  if (count === 0) {
    return ['Matches the app.'];
  }

  return [
    `Matches the app, with ${count} small ${
      count === 1 ? 'difference' : 'differences'
    }:`,
    ...check.issues.map(issueLine),
  ];
};

export const versionLine = (
  system: DesignSystemInfo,
  branch: string
): string => {
  const by = system.syncedBy === null ? '' : ` · made by ${system.syncedBy}`;
  const from =
    system.builtFrom === null
      ? ''
      : `${by === '' ? ' · made' : ''} from ${branch}@${system.builtFrom.slice(
          0,
          7
        )}`;

  return `Version ${system.version ?? '?'}${by}${from}`;
};

export const lastChangedLine = (change: LastChange, branch: string): string =>
  `Last changed by ${change.ticket} (${branch}@${change.sha})${
    change.rest === '' ? '' : `: ${change.rest}`
  }`;

export const lookText = (look: string): string =>
  look === 'none'
    ? 'Look: none found in the code'
    : `Look: colours, fonts and spacing from ${look}`;

export const componentsText = (
  system: DesignSystemInfo,
  detected: string
): string =>
  system.components.length === 0
    ? `Components: ${detected}`
    : `Components (${system.components.length}): ${shortList(
        system.components
      )}`;

export const createdLine = (made: MadeDesignSystem): string =>
  `Created ${made.id}: ${withoutStop(
    made.title
  )}. It's in Ready. Designs use it once it ships.`;

export const openTicketLine = (ticket: DesignSystemTicket): string => {
  if (ticket.status === 'blocked') {
    const reason =
      ticket.blockReason === null || ticket.blockReason.trim() === ''
        ? ''
        : `: ${withoutStop(ticket.blockReason)}`;

    return `${ticket.id} is blocked${reason}. Designs keep using Claude Design's default look.`;
  }

  return `${ticket.id} is open: ${withoutStop(ticket.title)} (${
    ticket.status
  }). Designs keep using Claude Design's default look until it ships.`;
};

/** One line of the page: text, an optional link after it, an indented issue. */
export interface PageLine {
  text: string;
  link?: { label: string; url: string | null };
  issue?: boolean;
}

/** "Checked against 4 photos · pictures on PAWNEE-12 ↗", when the check used any. */
export const photosLine = (system: DesignSystemInfo): PageLine | null => {
  const { check } = system;

  if (check === null || check.result === 'not-checked' || check.photos === 0) {
    return null;
  }

  const photos = `Checked against ${check.photos} ${
    check.photos === 1 ? 'photo' : 'photos'
  }`;

  return system.syncedBy === null
    ? { text: photos }
    : {
        text: `${photos} · `,
        link: {
          label: `pictures on ${system.syncedBy}`,
          url: system.picturesUrl,
        },
      };
};

const plain = (text: string): PageLine => ({ text });

/** The view-only page's lines, top to bottom, for a project with a design system. */
export const systemLines = (page: DesignSystemPage): PageLine[] => {
  const { system } = page;

  if (system === null) {
    return [];
  }

  const { check } = system;
  const photos = photosLine(system);
  const [checkHead, ...issues] = check === null ? [] : checkLines(check);

  return [
    plain(system.madeByHand ? MADE_BY_HAND : versionLine(system, page.branch)),
    ...(system.lastChanged === null
      ? []
      : [plain(lastChangedLine(system.lastChanged, page.branch))]),
    plain(`Kept in the codebase's code: ${page.dir}`),
    plain(KEPT_IN_STEP),
    ...(system.source === 'photos' ? [plain(PHOTOS_ONLY)] : []),
    ...(checkHead === undefined ? [] : [plain(checkHead)]),
    ...issues.map((text) => ({ text, issue: true })),
    ...(photos === null ? [] : [photos]),
    plain(lookText(page.look)),
    plain(componentsText(system, page.components)),
    ...(system.patterns.length === 0
      ? []
      : [
          plain(
            `Copied by hand (${system.patterns.length}): ${system.patterns.join(
              ', '
            )}`
          ),
        ]),
    ...(system.screens.length === 0
      ? []
      : [
          plain(
            `Reference screens (${
              system.screens.length
            }): ${system.screens.join(', ')}`
          ),
        ]),
    ...(system.sampleData ? [plain(SAMPLE_DATA)] : []),
    ...(page.ticketsError === null ? [] : [plain(page.ticketsError)]),
  ];
};

/** Where Settings → Design system's controls put what they learn. */
export interface DesignSystemTarget {
  page: (page: DesignSystemPage | null) => void;
  error: (text: string | null) => void;
  made: (made: ForProject<MadeDesignSystem> | null) => void;
  makeError: (text: ForProject<string> | null) => void;
  /** Make it is on its way. */
  busy: (busy: boolean) => void;
  /** A read is on its way. */
  reading: (reading: boolean) => void;
}

/**
 * Settings → Design system's reads and Make it. `load` is the page's
 * newest-answer-wins loader (it sets `page` and `error`); `shown` is the
 * project on screen now, so an answer for another project doesn't reload it.
 */
export const designSystemControls = ({
  read,
  make,
  load,
  errorText,
  shown,
  target,
}: {
  read: (projectId: string) => Promise<DesignSystemPage>;
  make: (projectId: string) => Promise<MadeDesignSystem>;
  load: (request: Promise<DesignSystemPage>) => Promise<void>;
  errorText: (caught: unknown) => string;
  shown: () => string | null;
  target: DesignSystemTarget;
}) => {
  const reads = { inFlight: 0 };
  // Every read says it's on its way, so the heartbeat never stacks another.
  const reread = async (projectId: string): Promise<void> => {
    reads.inFlight += 1;
    target.reading(true);

    try {
      await load(read(projectId));
    } finally {
      reads.inFlight -= 1;
      target.reading(reads.inFlight > 0);
    }
  };

  return {
    /** Opening the page, or another project picked: nothing of the last one shows. */
    open: (projectId: string): Promise<void> => {
      target.page(null);
      target.error(null);
      target.made(null);
      target.makeError(null);

      return reread(projectId);
    },
    read: reread,
    /**
     * Make it, then the page read again, whether it made the ticket or was
     * refused (a 409 means the page is out of date). A failed read after it
     * keeps Make it's message: the read only touches the page and its error.
     */
    make: async (projectId: string): Promise<void> => {
      target.busy(true);
      target.makeError(null);

      try {
        try {
          const answer = await make(projectId);
          target.made({ projectId, value: answer });
        } catch (caught) {
          target.makeError({ projectId, value: errorText(caught) });
        }

        // Another project's page reads its own; this answer doesn't reload it.
        if (shown() === projectId) {
          await reread(projectId);
        }
      } finally {
        target.busy(false);
      }
    },
  };
};
