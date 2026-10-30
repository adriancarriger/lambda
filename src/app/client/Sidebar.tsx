import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { agoShort } from '../shared/building';
import {
  type Lambda,
  type LambdaTicket,
  type SidebarSections,
} from '../shared/lambdas';
import { phaseName } from '../shared/phases';
import { podName } from '../shared/podName';
import { orderPods } from '../shared/podOrder';
import type { AccountPage } from '../shared/route';
import type { FavoriteKind } from '../shared/savedViews';
import { sideRowNeedsYou } from '../shared/screenChoice';
import {
  type InboxEntry,
  type LambdaInfo,
  type PodStatus,
  type PodSummary,
  isWorking,
} from '../shared/types';
import { waitingFailureNote } from '../shared/waitingNote';
import { ComputersLine } from './ComputersLine';
import type { Page } from './page';
import { groupByProject } from './projects';

/**
 * The left sidebar, laid out like Claude Code's: the brand and a collapse
 * button, search, the nav rows (New, Tickets, Time), then the lists in
 * sections — Building, Conversations (each open "Talk about this ticket"),
 * Pods (in priority order, drag to reorder) and Done. A section is
 * generic, so Runners can join as one more later. At the bottom: Auto mode
 * (‹ › through the queue, and its switch), then the account row (local for
 * now; auth comes later).
 */

/** One favorite as the sidebar draws it: App resolves its name and icon. */
export interface FavoriteRow {
  id: string;
  kind: FavoriteKind;
  ref: string;
  label: string;
  /** A tracker icon's emoji; null draws the kind's own glyph. */
  emoji: string | null;
  color: string | null;
  /** It's what's on screen. */
  active: boolean;
}

/** A favorite with no emoji: Linear's cube for a project, layers for a view. */
const FavoriteGlyph = ({
  kind,
  color,
}: {
  kind: FavoriteKind;
  color: string | null;
}) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke={color ?? 'currentColor'}
    strokeWidth="1.8"
    aria-hidden="true"
  >
    {kind === 'project' ? (
      <>
        <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
        <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
      </>
    ) : kind === 'view' ? (
      <>
        <path d="M12 4l9 5-9 5-9-5z" />
        <path d="M3 14l9 5 9-5" />
      </>
    ) : kind === 'ticket' ? (
      <circle cx="12" cy="12" r="8" />
    ) : (
      <path d="M8 5c3 0 4.2 1.6 5.4 4.4L19 20h2M13 12l-6 8" />
    )}
  </svg>
);

interface Props {
  pods: PodSummary[];
  priority: string[];
  /** The pod on screen — picked, or brought up by Auto — highlighted. */
  activePodId: string | null;
  /** The nav row that's on screen, if not a pod. */
  page: Page | null;
  /** The mothership's: you, your projects, pods waiting for a computer. */
  lambda: LambdaInfo | undefined;
  onOpenAccountPage: (page: AccountPage) => void;
  onSignOut: () => void;
  /**
   * Auto mode, above the account: when on, the pod on screen follows the
   * queue (every pod's items, by priority) and ‹ › step through it; picking
   * a pod turns it off.
   */
  auto: {
    on: boolean;
    /** The item on screen's place in the queue (-1: none). */
    index: number;
    /** Items waiting. */
    total: number;
    onToggle: (on: boolean) => void;
    onPrev: () => void;
    onNext: () => void;
  };
  /** Pods with an item set aside ("Next item"): working, not a badge. */
  asidePods: Set<string>;
  /** `via`: what selected it — for the page's log (uiLog). */
  onSelectPod: (podId: string, via: 'click' | 'enter-key') => void;
  onReorder: (order: string[]) => void;
  onNewPod: () => void;
  onRename: (podId: string, title: string) => void;
  onDelete: (podId: string) => void;
  /** A building computer's ⋯ menu: Pause or Resume building. */
  onPauseBuilding: (podId: string, pause: boolean) => void;
  /** A building computer's ⋯ menu: its pod, with the Agents rail open. */
  onOpenTerminal: (podId: string) => void;
  /**
   * Every Lambda, by section: Needs you, Planning, Queued, Building,
   * Shipped (a day) and Done. A Lambda's row stays until it ships.
   */
  sections: SidebarSections;
  /** The Lambda on screen, highlighted. */
  activeLambdaKey: string | null;
  onSelectLambda: (lambda: Lambda) => void;
  /** A Queued row dropped on another: right after it in the build queue. */
  onMoveTicket: (moving: Lambda, after: Lambda) => void;
  /** The computers footer: a computer's own page (its building pod). */
  onOpenComputer: (podId: string) => void;
  /** A checkpoint item's number, for "checkpoint 3 · plan". */
  checkpointOf: (entry: InboxEntry) => number | null;
  /** Starred views, projects, tickets and Lambdas, in their order. */
  favorites: FavoriteRow[];
  onOpenFavorite: (favorite: FavoriteRow) => void;
  onUnfavorite: (favorite: FavoriteRow) => void;
  onReorderFavorites: (ids: string[]) => void;
  /** The workspace's tracker projects and saved views. */
  onOpenProjects: () => void;
  /** The Tickets list is a project's or a view's: Projects or Views is lit, not Tickets. */
  ticketsScoped: boolean;
  onOpenViews: () => void;
  /** Active planning time today (see useActiveTime). */
  stopwatch: { ticking: boolean; today: string };
  onOpenTickets: () => void;
  /** The Time row opens the Time page. */
  onOpenTime: () => void;
  /** Pods with something new since the current item came up (a dot). */
  freshPods: Set<string>;
  collapsed: boolean;
  /** Sliding shut: still laid out open while it narrows to the strip. */
  closing: boolean;
  onCollapse: (collapsed: boolean) => void;
}

/** Every pod reads as exactly one of these — Needs you, or Working, or something is wrong. */
const STATUS_LABEL: Record<PodStatus, (summary: PodSummary) => string> = {
  'needs-you': () => 'Needs you',
  working: (summary) =>
    summary.request !== undefined
      ? 'Working · your request'
      : summary.chatHold
      ? 'Answering your chat ⌘⏎'
      : summary.liveForks.length > 0
      ? 'Working · talking'
      : isWorking(summary)
      ? 'Working…'
      : 'Waiting for your reply',
  stalled: () => 'Stalled',
  'waiting-step0': (summary) =>
    `Waiting on step 0 (${summary.pod.waitingOnHuman?.ticketId ?? ''})`,
  paused: () => 'Paused',
  done: () => 'Done',
};

export { orderPods };

const Icon = ({ children }: { children: ReactNode }) => (
  <svg
    className="side-icon"
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

const ICONS = {
  search: (
    <Icon>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.2-4.2" />
    </Icon>
  ),
  new: (
    <Icon>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8M8 12h8" />
    </Icon>
  ),
  projects: (
    <Icon>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
    </Icon>
  ),
  views: (
    <Icon>
      <path d="M12 4l9 5-9 5-9-5z" />
      <path d="M3 14l9 5 9-5" />
    </Icon>
  ),
  tickets: (
    <Icon>
      <path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z" />
      <path d="M14 5v12" strokeDasharray="2 2" />
    </Icon>
  ),
  time: (
    <Icon>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l2.5 2M10 2h4" />
    </Icon>
  ),
  plus: (
    <Icon>
      <path d="M12 6v12M6 12h12" />
    </Icon>
  ),
  chevron: (
    <Icon>
      <path d="M7 10l5 5 5-5" />
    </Icon>
  ),
  prev: (
    <Icon>
      <path d="M15 6l-6 6 6 6" />
    </Icon>
  ),
  next: (
    <Icon>
      <path d="M9 6l6 6-6 6" />
    </Icon>
  ),
  more: (
    <Icon>
      <circle cx="6" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="18" cy="12" r="1" />
    </Icon>
  ),
  pause: (
    <Icon>
      <path d="M9 6v12M15 6v12" />
    </Icon>
  ),
  resume: (
    <Icon>
      <path d="M8 5.5v13l10-6.5z" />
    </Icon>
  ),
  terminal: (
    <Icon>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5" />
    </Icon>
  ),
  pausedBars: (
    <svg viewBox="0 0 10 10" width="10" height="10" fill="currentColor">
      <rect x="1.5" y="1" width="2.5" height="8" rx="0.6" />
      <rect x="6" y="1" width="2.5" height="8" rx="0.6" />
    </svg>
  ),
  stalled: (
    <Icon>
      <path d="M12 3l9.5 17h-19z" />
      <path d="M12 10v4M12 17v.5" />
    </Icon>
  ),
  paused: (
    <Icon>
      <path d="M9 6v12M15 6v12" />
    </Icon>
  ),
  done: (
    <Icon>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Icon>
  ),
  waiting: (
    <Icon>
      <path d="M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9" />
    </Icon>
  ),
};

/** The right end of a pod row: what it needs from you, else its state. */
const StatusMark = ({
  summary,
  aside,
}: {
  summary: PodSummary;
  /** An item of its is set aside until the dev's done: it's working. */
  aside: boolean;
}) => {
  if (aside && summary.needsYou <= 1) {
    return <span className="side-row__working" aria-label="Working" />;
  }

  if (summary.needsYou > 0) {
    return <span className="count">{summary.needsYou}</span>;
  }

  if (isWorking(summary)) {
    return <span className="side-row__working" aria-label="Working" />;
  }

  if (summary.status === 'stalled') {
    return ICONS.stalled;
  }

  if (summary.status === 'paused') {
    return ICONS.paused;
  }

  if (summary.status === 'waiting-step0') {
    return ICONS.waiting;
  }

  return summary.status === 'done' ? ICONS.done : null;
};

/** A planning row's state in a word, at its end: "working", "paused". */
const stateWord = (summary: PodSummary, aside: boolean): string => {
  if (aside || isWorking(summary)) {
    return 'working';
  }

  if (summary.needsYou > 0) {
    return 'your turn';
  }

  switch (summary.status) {
    case 'stalled':
      return 'stalled';
    case 'paused':
      return 'paused';
    case 'waiting-step0':
      return 'step 0';
    case 'done':
      return '';
    default:
      return 'idle';
  }
};

const SECTIONS_KEY = 'pods.sections';

/** Queued shows its first few; the rest behind "+ N more". */
const QUEUED_SHOWN = 3;

const readCollapsedSections = (): Record<string, boolean> => {
  try {
    const saved: unknown = JSON.parse(
      window.localStorage.getItem(SECTIONS_KEY) ?? '{}'
    );

    return typeof saved === 'object' && saved !== null
      ? Object.fromEntries(
          Object.entries(saved).filter(
            (entry): entry is [string, boolean] => typeof entry[1] === 'boolean'
          )
        )
      : {};
  } catch {
    return {};
  }
};

/**
 * One list in the sidebar, under a quiet header: Planning (or, with two or
 * more projects, one per project) and Done. Collapsing it is remembered.
 */
const Section = ({
  id,
  title,
  action,
  defaultCollapsed = false,
  count,
  hint,
  children,
}: {
  id: string;
  title: string;
  /** A count beside the title (Needs you's badge, Queued's total). */
  count?: number;
  /** A quiet note after the title: Done's "chats and plans with no tickets". */
  hint?: string;
  /** e.g. "+" for a new pod. */
  action?: { label: string; onClick: () => void };
  defaultCollapsed?: boolean;
  children: ReactNode;
}) => {
  const [collapsed, setCollapsed] = useState(
    () => readCollapsedSections()[id] ?? defaultCollapsed
  );

  const toggle = (): void => {
    const next = !collapsed;
    setCollapsed(next);

    try {
      window.localStorage.setItem(
        SECTIONS_KEY,
        JSON.stringify({ ...readCollapsedSections(), [id]: next })
      );
    } catch {
      // Private mode: it just isn't remembered.
    }
  };

  return (
    <section className={`side-section side-section--${id}`}>
      <div className="side-section__head">
        <button
          type="button"
          className="side-section__title"
          aria-expanded={!collapsed}
          onClick={toggle}
        >
          {title}
          {count !== undefined && id !== 'needs-you' && (
            <span className="side-section__count">· {count}</span>
          )}
          <span
            className={`side-section__chevron${
              collapsed ? ' side-section__chevron--closed' : ''
            }`}
          >
            {ICONS.chevron}
          </span>
          {hint !== undefined && (
            <span className="side-section__hint">{hint}</span>
          )}
        </button>
        {count !== undefined && id === 'needs-you' && (
          <span className="side-section__count side-section__count--badge">
            {count}
          </span>
        )}
        {action !== undefined && (
          <button
            type="button"
            className="side-section__action"
            title={action.label}
            aria-label={action.label}
            onClick={action.onClick}
          >
            {ICONS.plus}
          </button>
        )}
      </div>
      {!collapsed && children}
    </section>
  );
};

export const Sidebar = ({
  pods,
  priority,
  activePodId,
  page,
  auto,
  asidePods,
  onSelectPod,
  onReorder,
  onNewPod,
  onRename,
  onDelete,
  onPauseBuilding,
  onOpenTerminal,
  sections,
  activeLambdaKey,
  onSelectLambda,
  onMoveTicket,
  onOpenComputer,
  checkpointOf,
  stopwatch,
  favorites,
  onOpenFavorite,
  onUnfavorite,
  onReorderFavorites,
  onOpenProjects,
  onOpenViews,
  ticketsScoped,
  onOpenTickets,
  onOpenTime,
  freshPods,
  collapsed,
  closing,
  onCollapse,
  lambda,
  onOpenAccountPage,
  onSignOut,
}: Props) => {
  const account = lambda?.owner ?? { name: 'You', initials: '?' };
  const [dragging, setDragging] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    podId: string;
    x: number;
    y: number;
    /** A building computer's menu, not a planning pod's. */
    building?: boolean;
  } | null>(null);
  /** Re-read each minute, for "shipped … 4m ago". */
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);

    return () => window.clearInterval(id);
  }, []);
  const [renaming, setRenaming] = useState<{
    podId: string;
    value: string;
  } | null>(null);
  const [query, setQuery] = useState('');
  const [accountOpen, setAccountOpen] = useState(false);
  /** Bumped on each click of the brand, to replay its load animation. */
  const [brandPlays, setBrandPlays] = useState(0);
  const brandText = useRef<HTMLSpanElement>(null);
  /**
   * How the brand animates. On load, or on a click of "Lambda", the λ flies
   * in ('load'). As the sidebar slides shut the word slides left into the λ
   * and fades ('leave'), and back out of it as the sidebar opens ('arrive').
   */
  const [brandMode, setBrandMode] = useState<'load' | 'leave' | 'arrive'>(
    'load'
  );
  const mounted = useRef(false);

  useLayoutEffect(() => {
    if (!mounted.current) {
      mounted.current = true;

      return;
    }

    setBrandMode(closing ? 'leave' : 'arrive');
  }, [collapsed, closing]);
  const brandMark = useRef<SVGSVGElement>(null);

  // The λ flies in from just past the word to the toggle: how far that is.
  useLayoutEffect(() => {
    const text = brandText.current?.getBoundingClientRect();
    const mark = brandMark.current;

    if (text === undefined || mark === null) {
      return;
    }

    mark.style.setProperty(
      '--brand-from',
      `${text.right + 3 - mark.getBoundingClientRect().left}px`
    );
  }, [brandPlays]);
  const search = useRef<HTMLInputElement>(null);
  const ordered = orderPods(pods, priority);

  // Any click or Escape elsewhere closes the right-click menu and the
  // account menu.
  useEffect(() => {
    if (menu === null && !accountOpen) {
      return undefined;
    }

    const close = (): void => {
      setMenu(null);
      setAccountOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        close();
      }
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu, accountOpen]);

  // ⇧⌘O starts a new pod, as in Claude Code.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === 'o'
      ) {
        event.preventDefault();
        onNewPod();
      }
    };
    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [onNewPod]);

  /** Enter (or clicking away) saves; an empty or unchanged title is a no-op. */
  const commitRename = (): void => {
    if (renaming === null) {
      return;
    }

    const title = renaming.value.trim();
    const target = pods.find((summary) => summary.pod.id === renaming.podId);
    setRenaming(null);

    if (title !== '' && target !== undefined && title !== podName(target.pod)) {
      onRename(renaming.podId, title);
    }
  };

  const drop = (targetId: string): void => {
    if (dragging === null || dragging === targetId) {
      return;
    }

    const ids = ordered
      .map((summary) => summary.pod.id)
      .filter((id) => id !== dragging);
    const at = ids.indexOf(targetId);
    onReorder([...ids.slice(0, at), dragging, ...ids.slice(at)]);
    setDragging(null);
  };

  const needle = query.trim().toLowerCase();
  const matches = (summary: PodSummary): boolean =>
    needle === '' ||
    [podName(summary.pod), summary.pod.id, summary.pod.epicId ?? '']
      .join(' ')
      .toLowerCase()
      .includes(needle);
  const summaryOf = (podId: string | null): PodSummary | undefined =>
    podId === null
      ? undefined
      : ordered.find((summary) => summary.pod.id === podId);
  const matchesLambda = (one: Lambda): boolean =>
    needle === '' ||
    [one.title, one.ticketId ?? '', ...one.tickets.map((ticket) => ticket.id)]
      .join(' ')
      .toLowerCase()
      .includes(needle);
  /** Planning: the planning pods, in priority order, as before. */
  const planningPods = sections.planning
    .filter(matchesLambda)
    .flatMap((one) => {
      const summary = summaryOf(one.planningPodId);

      return summary === undefined ? [] : [summary];
    });
  const doneRows = sections.done.filter(matchesLambda);

  const menuPod = pods.find((summary) => summary.pod.id === menu?.podId);

  const tooltip = (summary: PodSummary): string => {
    const origin =
      summary.pod.from === undefined
        ? undefined
        : pods.find(
            (candidate) => candidate.pod.id === summary.pod.from?.podId
          );
    const from =
      summary.pod.from === undefined
        ? ''
        : `\nfrom ${
            origin === undefined ? summary.pod.from.podId : podName(origin.pod)
          }`;
    const phase =
      summary.pod.mode === 'freeform'
        ? 'Freeform'
        : `P${summary.pod.phase} ${phaseName(summary.pod.phase, summary.pod)}`;

    return `${podName(summary.pod)}\n${
      asidePods.has(summary.pod.id)
        ? 'Working on your reply · comes back to you when done'
        : STATUS_LABEL[summary.status](summary)
    } · ${phase}${from}`;
  };

  const podRow = (summary: PodSummary) => {
    const { id } = summary.pod;
    const isRenaming = renaming?.podId === id;
    // Reordering is the queue's priority: only the full, unfiltered list.
    const draggable = !isRenaming && needle === '' && summary.status !== 'done';

    return (
      <div
        key={id}
        role="button"
        tabIndex={0}
        title={tooltip(summary)}
        draggable={draggable}
        onDragStart={() => setDragging(id)}
        onDragOver={(event) => event.preventDefault()}
        onDrop={() => drop(id)}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ podId: id, x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (!isRenaming && event.key === 'Enter') {
            onSelectPod(id, 'enter-key');
          }
        }}
        className={`side-row side-row--pod${
          activePodId === id && page === null ? ' side-row--active' : ''
        }${dragging === id ? ' side-row--dragging' : ''}${sideRowNeedsYou(
          summary
        )}${menu?.podId === id ? ' side-row--menu' : ''}`}
        onClick={() => {
          if (!isRenaming) {
            onSelectPod(id, 'click');
          }
        }}
      >
        {freshPods.has(id) && (
          <span
            className="side-row__fresh"
            title="Something new arrived for this Lambda since your current item came up"
          />
        )}
        {isRenaming ? (
          <input
            className="rename"
            autoFocus
            value={renaming.value}
            onFocus={(event) => event.target.select()}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) =>
              setRenaming({ podId: id, value: event.target.value })
            }
            onKeyDown={(event) => {
              event.stopPropagation();

              if (event.key === 'Enter') {
                commitRename();
              }

              if (event.key === 'Escape') {
                setRenaming(null);
              }
            }}
            onBlur={commitRename}
          />
        ) : (
          <>
            <span className="side-row__lead" aria-hidden="true">
              <StatusMark summary={summary} aside={asidePods.has(id)} />
            </span>
            <span className="side-row__label">{podName(summary.pod)}</span>
          </>
        )}
        <span className="side-row__end">
          <span className="side-row__status side-row__state">
            {stateWord(summary, asidePods.has(id))}
          </span>
          <button
            type="button"
            className="side-row__more"
            aria-label={`More for ${podName(summary.pod)}`}
            onClick={(event) => {
              event.stopPropagation();
              const box = event.currentTarget.getBoundingClientRect();
              setMenu({ podId: id, x: box.left, y: box.bottom + 4 });
            }}
          >
            {ICONS.more}
          </button>
        </span>
      </div>
    );
  };

  /** What a Needs-you row waits on, in a few words. */
  const needsLine = (one: Lambda): { text: string; urgent: boolean } => {
    const [first] = one.needsYou;
    const blocked = one.tickets.find(
      (ticket) => ticket.where.kind === 'blocked'
    );

    if (first?.tag === 'blocked') {
      return {
        text: `blocked · ${
          blocked?.where.kind === 'blocked'
            ? blocked.where.computer
            : 'a computer'
        } is waiting`,
        urgent: true,
      };
    }

    if (first?.tag === 'review') {
      return { text: 'ready to review', urgent: false };
    }

    if (first?.kind === 'checkpoint') {
      const cp = checkpointOf(first);

      return {
        text: cp === null ? 'checkpoint · plan' : `checkpoint ${cp} · plan`,
        urgent: false,
      };
    }

    const words: Record<string, string> = {
      question: 'a question for you',
      reply: 'your turn',
      stalled: 'stalled',
      structure: 'start planning?',
    };

    return {
      text: words[first?.kind ?? 'reply'] ?? 'your turn',
      urgent: false,
    };
  };

  const lambdaRowClass = (one: Lambda, extra = ''): string =>
    `side-row side-row--pod side-row--lambda${
      activeLambdaKey === one.key && page === null ? ' side-row--active' : ''
    }${extra}`;

  const needsRow = (one: Lambda) => {
    const line = needsLine(one);

    return (
      <button
        key={one.key}
        type="button"
        className={lambdaRowClass(one)}
        title={`${one.title}\n${line.text}`}
        onClick={() => onSelectLambda(one)}
        onContextMenu={(event) => {
          if (one.planningPodId !== null) {
            event.preventDefault();
            setMenu({
              podId: one.planningPodId,
              x: event.clientX,
              y: event.clientY,
            });
          }
        }}
      >
        <span
          className={`side-row__dot side-row__dot--${
            line.urgent ? 'blocked' : 'needs'
          }`}
          aria-hidden="true"
        />
        <span className="side-row__label">
          {one.title}
          <span
            className={`side-row__sub${
              line.urgent ? ' side-row__sub--urgent' : ''
            }`}
          >
            {line.text}
          </span>
        </span>
        {one.needsYou.length > 1 && (
          <span className="side-row__end">
            <span className="count">{one.needsYou.length}</span>
          </span>
        )}
      </button>
    );
  };

  const ordinal = (place: number): string =>
    `${place}${
      place % 10 === 1 && place % 100 !== 11
        ? 'st'
        : place % 10 === 2 && place % 100 !== 12
        ? 'nd'
        : place % 10 === 3 && place % 100 !== 13
        ? 'rd'
        : 'th'
    }`;

  const ticketLine = (ticket: LambdaTicket): string => {
    const { where } = ticket;

    switch (where.kind) {
      case 'building':
        return `${where.step} · ${Math.max(
          0,
          Math.round((now - Date.parse(where.startedAt)) / 60_000)
        )}m · ${where.computer}`;
      case 'queued':
        return `${ordinal(where.place)} · ${where.computer}`;
      case 'blocked':
        return `blocked · ${where.computer}`;
      case 'shipped':
        return `shipped ${agoShort(Date.parse(where.at), now)}`;
      default:
        return 'ready';
    }
  };

  const [movingTicket, setMovingTicket] = useState<Lambda | null>(null);
  const [draggingFavorite, setDraggingFavorite] = useState<string | null>(null);
  const [allQueued, setAllQueued] = useState(false);

  const queuedRow = (one: Lambda) => {
    const next =
      one.tickets.find((ticket) => ticket.where.kind === 'queued') ??
      one.tickets[0];

    return (
      <button
        key={one.key}
        type="button"
        className={lambdaRowClass(one)}
        title={`${one.title}\nDrag to reorder the build queue`}
        draggable={needle === ''}
        onDragStart={() => setMovingTicket(one)}
        onDragOver={(event) => event.preventDefault()}
        onDrop={() => {
          if (movingTicket !== null && movingTicket.key !== one.key) {
            onMoveTicket(movingTicket, one);
          }

          setMovingTicket(null);
        }}
        onClick={() => onSelectLambda(one)}
      >
        <svg
          className="side-row__ring"
          width="12"
          height="12"
          viewBox="0 0 16 16"
          aria-hidden="true"
        >
          <circle
            cx="8"
            cy="8"
            r="6.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          />
        </svg>
        <span className="side-row__label">
          {one.title}
          {next !== undefined && (
            <span className="side-row__sub">{ticketLine(next)}</span>
          )}
        </span>
      </button>
    );
  };

  const buildingLambdaRow = (one: Lambda) => {
    const live = one.tickets.filter(
      (ticket) =>
        ticket.where.kind === 'building' || ticket.where.kind === 'blocked'
    );
    const shipped = one.tickets.filter(
      (ticket) => ticket.where.kind === 'shipped'
    ).length;

    if (one.tickets.length <= 1) {
      const [only] = one.tickets;

      return (
        <button
          key={one.key}
          type="button"
          className={lambdaRowClass(one)}
          onClick={() => onSelectLambda(one)}
        >
          <span
            className="side-row__dot side-row__dot--building"
            aria-hidden="true"
          />
          <span className="side-row__label">
            {one.title}
            {only !== undefined && (
              <span className="side-row__sub">{ticketLine(only)}</span>
            )}
          </span>
        </button>
      );
    }

    return (
      <div key={one.key} className="side-epic">
        <button
          type="button"
          className={lambdaRowClass(one, ' side-row--epic')}
          onClick={() => onSelectLambda(one)}
        >
          <span className="side-row__caret" aria-hidden="true">
            {ICONS.chevron}
          </span>
          <span className="side-row__label">{one.title}</span>
          <span className="side-row__end">
            <span className="side-chip">
              {shipped}/{one.tickets.length}
            </span>
          </span>
        </button>
        {live.map((ticket) => (
          <button
            key={ticket.id}
            type="button"
            className="side-row side-row--pod side-row--child"
            onClick={() => onSelectLambda(one)}
          >
            <span
              className={`side-row__dot side-row__dot--${
                ticket.where.kind === 'blocked' ? 'blocked' : 'building'
              }`}
              aria-hidden="true"
            />
            <span className="side-row__label">
              {ticket.title}
              <span className="side-row__sub">{ticketLine(ticket)}</span>
            </span>
          </button>
        ))}
      </div>
    );
  };

  const shippedRow = (one: Lambda) => (
    <button
      key={one.key}
      type="button"
      className={lambdaRowClass(one)}
      onClick={() => onSelectLambda(one)}
    >
      <svg
        className="side-row__shipped"
        width="12"
        height="12"
        viewBox="0 0 16 16"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path
          d="M4.8 8.2l2.2 2.2 4.2-4.6"
          fill="none"
          stroke="#fff"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="side-row__label">{one.title}</span>
      <span className="side-row__end side-row__when">
        {one.shippedAt === null ? '' : agoShort(Date.parse(one.shippedAt), now)}
      </span>
    </button>
  );

  const navRow = ({
    icon,
    label,
    on,
    onClick,
    end,
    hint,
    id,
  }: {
    icon: ReactNode;
    label: string;
    on: boolean;
    onClick: () => void;
    end?: ReactNode;
    hint?: string;
    id: string;
  }) => (
    <button
      type="button"
      className={`side-row side-row--nav side-row--${id}${
        on ? ' side-row--active' : ''
      }`}
      title={collapsed ? label : hint}
      onClick={onClick}
    >
      {icon}
      <span className="side-row__label">{label}</span>
      {end !== undefined && <span className="side-row__end">{end}</span>}
    </button>
  );

  return (
    <nav
      className={`sidebar${collapsed ? ' sidebar--collapsed' : ''}${
        brandMode === 'load' ? '' : ` sidebar--brand-${brandMode}`
      }`}
    >
      <div className="sidebar__head">
        <button
          type="button"
          className="side-icon-button"
          title={collapsed ? 'Open sidebar' : 'Close sidebar'}
          aria-label={collapsed ? 'Open sidebar' : 'Close sidebar'}
          onClick={() => onCollapse(!collapsed)}
        >
          <svg
            key={brandPlays}
            ref={brandMark}
            className="sidebar__brand-mark"
            viewBox="6 4 20 24"
            aria-hidden="true"
          >
            <path d="M9 6.5c3 0 4.2 1.6 5.4 4.4L21 25.5h3" />
            <path d="M15.4 14.2L8.5 25.5" />
          </svg>
        </button>
        <button
          type="button"
          className="sidebar__brand"
          title="New planning Lambda"
          onClick={() => {
            setBrandPlays((plays) => plays + 1);
            setBrandMode('load');
            onNewPod();
          }}
        >
          <span key={brandPlays} className="sidebar__brand-word">
            <span ref={brandText} className="sidebar__brand-text">
              Lambda
            </span>
          </span>
        </button>
      </div>

      {collapsed ? (
        <button
          type="button"
          className="side-row side-row--nav side-row--search"
          title="Search"
          onClick={() => {
            onCollapse(false);
            window.setTimeout(() => search.current?.focus(), 0);
          }}
        >
          {ICONS.search}
        </button>
      ) : (
        <label className="side-search">
          {ICONS.search}
          <input
            ref={search}
            value={query}
            placeholder="Search"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setQuery('');
                event.currentTarget.blur();
              }
            }}
          />
        </label>
      )}

      <div className="sidebar__nav">
        {navRow({
          icon: ICONS.new,
          id: 'new',
          label: 'New',
          on: page === 'new',
          onClick: onNewPod,
          hint: 'New planning Lambda (⇧⌘O)',
        })}
        {navRow({
          id: 'tickets',
          icon: ICONS.tickets,
          label: 'Tickets',
          on: page === 'tickets' && !ticketsScoped,
          onClick: onOpenTickets,
        })}
        {navRow({
          id: 'projects',
          icon: ICONS.projects,
          label: 'Projects',
          on: page === 'projects',
          onClick: onOpenProjects,
        })}
        {navRow({
          id: 'views',
          icon: ICONS.views,
          label: 'Views',
          on: page === 'views',
          onClick: onOpenViews,
        })}
        {navRow({
          icon: ICONS.time,
          id: 'time',
          label: 'Time',
          on: page === 'time',
          onClick: onOpenTime,
          // Black while it counts, grey when paused.
          end: (
            <span
              className={`side-row__number${
                stopwatch.ticking ? ' side-row__number--ticking' : ''
              }`}
            >
              {stopwatch.today}
            </span>
          ),
          hint: `${
            stopwatch.ticking ? 'Planning' : 'Paused'
          } — active planning time today. Counts only while you scroll, type, click, listen to audio or wait on a live reply; idle for 15 seconds and it stops. Click for the breakdown.`,
        })}
      </div>

      {!collapsed && (
        <div className="sidebar__lists">
          {favorites.length > 0 && (
            <Section id="favorites" title="Favorites">
              {favorites.map((favorite) => (
                <button
                  key={favorite.id}
                  type="button"
                  className={`side-row side-row--favorite${
                    favorite.active ? ' side-row--active' : ''
                  }`}
                  title={favorite.label}
                  draggable
                  onDragStart={() => setDraggingFavorite(favorite.id)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    if (
                      draggingFavorite === null ||
                      draggingFavorite === favorite.id
                    ) {
                      return;
                    }

                    const ids = favorites
                      .map((one) => one.id)
                      .filter((id) => id !== draggingFavorite);
                    ids.splice(ids.indexOf(favorite.id), 0, draggingFavorite);
                    setDraggingFavorite(null);
                    onReorderFavorites(ids);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    onUnfavorite(favorite);
                  }}
                  onClick={() => onOpenFavorite(favorite)}
                >
                  <span className="side-row__favicon" aria-hidden="true">
                    {favorite.emoji ?? (
                      <FavoriteGlyph
                        kind={favorite.kind}
                        color={favorite.color}
                      />
                    )}
                  </span>
                  <span className="side-row__label">{favorite.label}</span>
                </button>
              ))}
            </Section>
          )}
          {sections.needsYou.filter(matchesLambda).length > 0 && (
            <Section
              id="needs-you"
              title="Needs you"
              count={sections.needsYou.filter(matchesLambda).length}
            >
              {sections.needsYou.filter(matchesLambda).map(needsRow)}
            </Section>
          )}

          <Section
            id="planning"
            title="Planning"
            action={{ label: 'New planning Lambda', onClick: onNewPod }}
          >
            {groupByProject(planningPods, lambda).map((group) => (
              <div
                key={group.project?.id ?? (group.other ? 'other' : 'pods')}
                className="side-group"
              >
                {(group.project !== null || group.other) && (
                  <p className="side-group__name">
                    {group.project?.name ?? 'No project'}
                  </p>
                )}
                {group.pods.map(podRow)}
                {group.waiting.map((waiting) => (
                  <div
                    key={waiting.id}
                    className="side-row side-row--pod side-row--waiting"
                    title={waiting.label}
                  >
                    <span className="side-row__label">
                      {waiting.title}
                      <span className="side-row__sub">
                        waiting for a computer
                      </span>
                      {waiting.failure !== undefined && (
                        <span className="side-row__sub side-row__sub--error">
                          {waitingFailureNote(waiting.failure, Date.now())}
                        </span>
                      )}
                    </span>
                  </div>
                ))}
                {group.pods.length === 0 && group.waiting.length === 0 && (
                  <p className="muted sidebar__empty">
                    {needle === ''
                      ? 'No planning Lambdas yet. Start one with New.'
                      : 'Nothing matches.'}
                  </p>
                )}
              </div>
            ))}
          </Section>

          {sections.queued.filter(matchesLambda).length > 0 && (
            <Section
              id="queued"
              title="Queued"
              count={sections.queued.filter(matchesLambda).length}
            >
              {sections.queued
                .filter(matchesLambda)
                .slice(0, allQueued || needle !== '' ? undefined : QUEUED_SHOWN)
                .map(queuedRow)}
              {!allQueued &&
                needle === '' &&
                sections.queued.length > QUEUED_SHOWN && (
                  <button
                    type="button"
                    className="side-more"
                    onClick={() => setAllQueued(true)}
                  >
                    + {sections.queued.length - QUEUED_SHOWN} more
                  </button>
                )}
            </Section>
          )}

          {sections.building.filter(matchesLambda).length > 0 && (
            <Section id="building" title="Building">
              {sections.building.filter(matchesLambda).map(buildingLambdaRow)}
            </Section>
          )}

          {sections.shipped.filter(matchesLambda).length > 0 && (
            <Section id="shipped" title="Shipped · last 24h">
              {sections.shipped.filter(matchesLambda).map(shippedRow)}
            </Section>
          )}

          {doneRows.length > 0 && (
            <Section
              id="done"
              title="Done"
              hint="chats and plans with no tickets"
              defaultCollapsed
            >
              {doneRows.flatMap((one) => {
                const summary = summaryOf(one.planningPodId);

                return summary === undefined ? [] : [podRow(summary)];
              })}
            </Section>
          )}
        </div>
      )}

      {menu !== null && menu.building === true && (
        <div
          className="context-menu"
          role="menu"
          aria-label={lambda?.podComputers?.[menu.podId] ?? 'Building'}
          style={{ left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onPauseBuilding(menu.podId, menuPod?.pod.status !== 'paused');
              setMenu(null);
            }}
          >
            {menuPod?.pod.status === 'paused' ? (
              <>{ICONS.resume} Resume building</>
            ) : (
              <>{ICONS.pause} Pause building</>
            )}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onOpenTerminal(menu.podId);
              setMenu(null);
            }}
          >
            {ICONS.terminal} Open terminal
          </button>
        </div>
      )}

      {menu !== null && menu.building !== true && (
        <div
          className="context-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const target = pods.find(
                (summary) => summary.pod.id === menu.podId
              );
              setRenaming({
                podId: menu.podId,
                value: target === undefined ? '' : podName(target.pod),
              });
              setMenu(null);
            }}
          >
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            className="context-menu__danger"
            onClick={() => {
              const target = pods.find(
                (summary) => summary.pod.id === menu.podId
              );
              const name =
                target === undefined ? menu.podId : podName(target.pod);
              setMenu(null);

              if (
                window.confirm(
                  `Delete "${name}"?\n\nIts agents stop and it leaves the app. Its tickets are not touched, and its files move to the pods' trash so it can be restored.`
                )
              ) {
                onDelete(menu.podId);
              }
            }}
          >
            Delete pod…
          </button>
        </div>
      )}

      <div className="sidebar__foot">
        {!collapsed && (lambda?.computers ?? []).length > 0 && (
          <ComputersLine
            pods={pods}
            lambda={lambda}
            now={now}
            onPause={onPauseBuilding}
            onOpenComputer={onOpenComputer}
            onOpenTerminal={onOpenTerminal}
            onOpenPage={() => onOpenAccountPage('computers')}
            onOpenTickets={onOpenTickets}
          />
        )}
        <div
          className={`side-auto${auto.on ? ' side-auto--on' : ''}`}
          title={
            auto.on
              ? 'Auto: the screen follows whatever needs you next. Picking a Lambda turns it off.'
              : 'Auto is off: you picked a Lambda. Turn it on to be taken to whatever needs you next.'
          }
        >
          {!collapsed && auto.on && auto.total > 0 && (
            <>
              <button
                type="button"
                className="side-icon-button side-auto__step"
                aria-label="Previous item (P)"
                title="Previous item (P)"
                disabled={auto.index <= 0}
                onClick={auto.onPrev}
              >
                {ICONS.prev}
              </button>
              <button
                type="button"
                className="side-icon-button side-auto__step"
                aria-label="Next item (N)"
                title="Next item (N)"
                disabled={auto.index < 0 || auto.index >= auto.total - 1}
                onClick={auto.onNext}
              >
                {ICONS.next}
              </button>
              <span className="side-auto__count">
                {auto.index >= 0 ? auto.index + 1 : '–'} of {auto.total}
              </span>
            </>
          )}
          {!collapsed && auto.on && auto.total === 0 && (
            <span className="side-auto__count">All caught up</span>
          )}
          {!collapsed && !auto.on && auto.total > 0 && (
            <span className="side-auto__count">{auto.total} waiting</span>
          )}
          <label className="switch side-auto__switch">
            <input
              type="checkbox"
              role="switch"
              checked={auto.on}
              onChange={(event) => auto.onToggle(event.target.checked)}
            />
            <span className="switch__track" aria-hidden="true">
              <span className="switch__thumb" />
            </span>
            {!collapsed && <span>Auto</span>}
          </label>
          {collapsed && auto.total > 0 && (
            <span className="side-auto__badge">{auto.total}</span>
          )}
        </div>

        <div className="side-account">
          <button
            type="button"
            className="side-row side-row--account"
            aria-haspopup="menu"
            aria-expanded={accountOpen}
            onClick={(event) => {
              event.stopPropagation();
              setAccountOpen(!accountOpen);
            }}
          >
            <span className="side-avatar">{account.initials}</span>
            {!collapsed && (
              <>
                <span className="side-row__label">{account.name}</span>
                <span className="side-account__chevron">{ICONS.chevron}</span>
              </>
            )}
          </button>
          {accountOpen && (
            <div
              className="context-menu side-account__menu"
              role="menu"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="side-account__who">
                <span className="side-avatar">{account.initials}</span>
                <strong>{account.name}</strong>
              </div>
              {(
                [
                  ['computers', 'Computers'],
                  ['analytics', 'Analytics'],
                  ['settings/devices', 'Settings'],
                ] as const
              ).map(([target, label]) => (
                <button
                  key={target}
                  type="button"
                  role="menuitem"
                  className={
                    page === target ||
                    (target === 'settings/devices' &&
                      (page === 'settings/process' ||
                        page === 'settings/design-system'))
                      ? 'context-menu__on'
                      : undefined
                  }
                  onClick={() => {
                    setAccountOpen(false);
                    onOpenAccountPage(target);
                  }}
                >
                  {label}
                </button>
              ))}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAccountOpen(false);
                  onSignOut();
                }}
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
};
