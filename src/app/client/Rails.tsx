import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useRef,
  useState,
} from 'react';

import { planningRailsOf, railFor } from '../shared/screenChoice';
import type { Player } from './usePlayer';

/**
 * The right-hand rails, as in Claude Code on the web: the chat stays in the
 * center, and one rail at a time opens beside it from the icons in the chat's
 * header. Plan (the item you're reviewing, with its audio in the footer),
 * Workflow (the pod's pipeline), Made here (what this Lambda made:
 * prototypes and pictures) and Agents (the live terminals). A building pod
 * has Workflow, Tickets (done, current, up next) and Agents.
 */

export type RailId =
  | 'plan'
  | 'workflow'
  | 'made'
  | 'tickets'
  | 'review'
  | 'summary'
  | 'agents';

export const RAILS: { id: RailId; label: string; hint: string }[] = [
  { id: 'plan', label: 'Plan', hint: 'The item up for review' },
  {
    id: 'workflow',
    label: 'Workflow',
    hint: "This Lambda's pipeline and tickets",
  },
  {
    id: 'made',
    label: 'Made here',
    hint: "This Lambda's prototypes, design pictures and screenshots",
  },
  {
    id: 'tickets',
    label: 'Tickets',
    hint: "This Lambda's tickets: done, current and up next",
  },
  {
    id: 'review',
    label: 'Review',
    hint: 'Ready for your review: approve it or send it back',
  },
  { id: 'summary', label: 'Summary', hint: 'What shipped, and what changed' },
  { id: 'agents', label: 'Agents', hint: 'The live Dev, Manager and forks' },
];

/** A planning pod's rails. */
export const PLANNING_RAILS: RailId[] = planningRailsOf('planning');

/** A building pod's rails. */
export const BUILDING_RAILS: RailId[] = ['workflow', 'tickets', 'agents'];

const RAIL_KEY = 'pods.rail';
/** Each Lambda's own rail: pod id → the rail open on it ('' = shut). */
const BY_POD_KEY = 'pods.railByPod';
/** Only the Lambdas seen most recently are remembered. */
const BY_POD_MAX = 60;
/** The rail's share of the room beside the sidebar (0–1). */
const SHARE_KEY = 'pods.railShare';
/** The open rail is maximized ('yes'), and was when last closed. */
const EXPANDED_KEY = 'pods.railExpanded';
const LAST_EXPANDED_KEY = 'pods.railLastExpanded';
/** Before shares: the rail's width in pixels, read once to carry it over. */
const WIDTH_KEY = 'pods.railWidth';
const MIN_WIDTH = 320;
/**
 * The chat keeps at least this much room unless the rail is expanded — small,
 * as in Claude Code, so the rail can take well over half the screen.
 */
export const MIN_CHAT = 300;
/** The main area runs flush to the window's right edge. */
const INSET = 0;
const DEFAULT_WIDTH = 520;

const read = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode: it just isn't remembered.
  }
};

const isRail = (value: string | null): value is RailId =>
  RAILS.some((rail) => rail.id === value);

const readByPod = (): Record<string, string> => {
  try {
    const saved: unknown = JSON.parse(read(BY_POD_KEY) ?? '{}');

    return typeof saved === 'object' && saved !== null
      ? Object.fromEntries(
          Object.entries(saved).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
          )
        )
      : {};
  } catch {
    return {};
  }
};

const writeByPod = (podId: string, next: RailId | null): void => {
  const kept = Object.entries(readByPod()).filter(([id]) => id !== podId);
  write(
    BY_POD_KEY,
    JSON.stringify(
      Object.fromEntries([
        ...kept.slice(-(BY_POD_MAX - 1)),
        [podId, next ?? ''],
      ])
    )
  );
};

/** The room the chat and the rail share: the window less the sidebar. */
const roomBeside = (sidebar: number): number =>
  Math.max(1, window.innerWidth - sidebar - INSET);

/** As wide as asked, leaving the chat its minimum beside the sidebar. */
const clampWidth = (width: number, sidebar: number): number =>
  Math.round(
    Math.max(
      MIN_WIDTH,
      Math.min(width, window.innerWidth - sidebar - INSET - MIN_CHAT)
    )
  );

/**
 * Which rail is open, how wide it is, and whether it fills the chat's room.
 * `sidebar`: the sidebar's width right now (it folds to an icon strip).
 * Each Lambda keeps its own open rail (`showPod`); off a Lambda, the last
 * one open is used.
 */
export const useRails = (sidebar: number) => {
  const [rail, setRailNow] = useState<RailId | null>(() => {
    const saved = read(RAIL_KEY);

    return isRail(saved) ? saved : 'plan';
  });
  // Kept as a share of the room beside the sidebar, so folding or opening the
  // sidebar keeps the chat and the rail in the same proportion.
  const [share, setShare] = useState(() => {
    const saved = Number(read(SHARE_KEY));

    if (Number.isFinite(saved) && saved > 0 && saved < 1) {
      return saved;
    }

    const pixels = Number(read(WIDTH_KEY));

    return (
      (Number.isFinite(pixels) && pixels > 0 ? pixels : DEFAULT_WIDTH) /
      roomBeside(sidebar)
    );
  });
  // Maximized stays maximized across reloads, as does what `]` brings back.
  const [expanded, setExpandedNow] = useState(
    () => rail !== null && read(EXPANDED_KEY) === 'yes'
  );
  const setExpanded = useCallback((next: boolean) => {
    setExpandedNow(next);
    write(EXPANDED_KEY, next ? 'yes' : '');
  }, []);
  /** The Lambda on screen, whose rail this is (null: not on a Lambda). */
  const podNow = useRef<string | null>(null);
  /** How it's shown: the rails of the screen it's on (its own page or not). */
  const railsNow = useRef<readonly RailId[]>([]);
  /** The rail last open, for `]` to bring back — maximized if it was. */
  const last = useRef<RailId>(rail ?? 'plan');
  const lastExpanded = useRef(read(LAST_EXPANDED_KEY) === 'yes');
  const expandedNow = useRef(expanded);
  expandedNow.current = expanded;

  const setRail = useCallback(
    (next: RailId | null) => {
      setRailNow(next);
      write(RAIL_KEY, next ?? '');

      if (podNow.current !== null) {
        writeByPod(podNow.current, next);
      }

      if (next !== null) {
        last.current = next;
      }

      if (next === null) {
        lastExpanded.current = expandedNow.current;
        write(LAST_EXPANDED_KEY, expandedNow.current ? 'yes' : '');
        setExpanded(false);
      }
    },
    [setExpanded]
  );
  /**
   * A Lambda came on screen, on a screen with `available` rails: show its
   * rail as they left it, or `fallback` the first time (its own default —
   * shut for a chat) or when the rail left open isn't one this screen has.
   * The same Lambda moving between screens (the inbox's planning screen and
   * a building pod's own page) counts as coming on screen again.
   */
  const showPod = useCallback(
    (
      podId: string | null,
      fallback: RailId | null,
      available: readonly RailId[]
    ) => {
      if (
        podId === podNow.current &&
        available.join() === railsNow.current.join()
      ) {
        return;
      }

      podNow.current = podId;
      railsNow.current = available;

      if (podId === null) {
        return;
      }

      setRailNow(railFor(readByPod()[podId], available, fallback));
    },
    []
  );
  /** Open `next` unless another rail they chose (not Workflow) is open. */
  const openIfShut = useCallback((next: RailId) => {
    setRailNow((open) => {
      if (open !== null && open !== 'workflow') {
        return open;
      }

      write(RAIL_KEY, next);
      last.current = next;

      if (podNow.current !== null) {
        writeByPod(podNow.current, next);
      }

      return next;
    });
  }, []);
  const setWidth = useCallback(
    (next: number) => {
      const nextShare = clampWidth(next, sidebar) / roomBeside(sidebar);
      setShare(nextShare);
      write(SHARE_KEY, String(nextShare));
    },
    [sidebar]
  );

  /** Close the open rail, or bring back the last one as it was. */
  const toggleRail = useCallback(() => {
    if (rail !== null) {
      setRail(null);

      return;
    }

    setRail(last.current);
    setExpanded(lastExpanded.current);
  }, [rail, setRail, setExpanded]);
  /** Maximize the rail or shrink it back, opening the last one if shut. */
  const toggleExpanded = useCallback(() => {
    if (rail === null) {
      setRail(last.current);
      setExpanded(true);

      return;
    }

    setExpanded(!expanded);
  }, [rail, expanded, setRail, setExpanded]);

  return {
    rail,
    setRail,
    showPod,
    openIfShut,
    toggleRail,
    toggleExpanded,
    width: clampWidth(share * roomBeside(sidebar), sidebar),
    setWidth,
    expanded,
    setExpanded,
  };
};

export type Rails = ReturnType<typeof useRails>;

const ICON_PATHS: Record<RailId, ReactNode> = {
  plan: (
    <>
      <path d="M8 6h12M8 12h12M8 18h12" />
      <circle cx="4" cy="6" r="1" />
      <circle cx="4" cy="12" r="1" />
      <circle cx="4" cy="18" r="1" />
    </>
  ),
  workflow: (
    <>
      <circle cx="5" cy="6" r="2" />
      <circle cx="5" cy="18" r="2" />
      <circle cx="19" cy="12" r="2" />
      <path d="M5 8v8M7 6h4a4 4 0 0 1 4 4v0a2 2 0 0 0 2 2M7 18h4a4 4 0 0 0 4-4" />
    </>
  ),
  made: (
    <>
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
      <path d="M13 17h8M17 13v8" />
    </>
  ),
  tickets: (
    <>
      <path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z" />
      <path d="M10 5v12" strokeDasharray="2 2" />
    </>
  ),
  review: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.2l2.4 2.4 4.8-5" />
    </>
  ),
  summary: (
    <>
      <path d="M6 3h9l3 3v15H6z" />
      <path d="M9 11h6M9 15h6" />
    </>
  ),
  agents: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M12 15h5" />
    </>
  ),
};

export const RailIcon = ({ id }: { id: RailId }) => (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {ICON_PATHS[id]}
  </svg>
);

/** The icons in the chat's header; a dot marks a rail with something new. */
export const RailSwitcher = ({
  rails,
  shown,
  badges,
  ids = PLANNING_RAILS,
}: {
  rails: Rails;
  /** The rail actually on screen (Plan steps aside on the New pod/Time pages). */
  shown: RailId | null;
  badges: Partial<Record<RailId, boolean>>;
  /** Which rails this pod has (a building pod's differ). */
  ids?: RailId[];
}) => (
  <div className="rail-switch" role="toolbar" aria-label="Rails">
    {RAILS.filter(({ id }) => ids.includes(id)).map(({ id, label, hint }) => (
      <button
        key={id}
        type="button"
        className={`rail-switch__button${
          shown === id ? ' rail-switch__button--active' : ''
        }`}
        title={`${label} — ${hint}`}
        aria-label={label}
        aria-pressed={shown === id}
        onClick={() => (shown === id ? rails.setRail(null) : rails.setRail(id))}
      >
        <RailIcon id={id} />
        {badges[id] === true && shown !== id && (
          <span className="rail-switch__badge" aria-hidden="true" />
        )}
      </button>
    ))}
  </div>
);

/**
 * Play/pause with a progress ring, always in the chat's header — so audio is
 * never stranded behind a closed Player rail.
 */
export const MiniPlayer = ({ player }: { player: Player }) => {
  const disabled = player.source === 'none' || player.duration <= 0;
  const progress =
    player.duration > 0 ? Math.min(1, player.time / player.duration) : 0;
  const radius = 15;
  const around = 2 * Math.PI * radius;

  return (
    <button
      type="button"
      className={`mini-player${player.playing ? ' mini-player--playing' : ''}`}
      title="Play / pause (Space)"
      aria-label={player.playing ? 'Pause' : 'Play'}
      disabled={disabled}
      onClick={player.toggle}
    >
      <svg viewBox="0 0 36 36" width="34" height="34" aria-hidden="true">
        <circle className="mini-player__track" cx="18" cy="18" r={radius} />
        <circle
          className="mini-player__ring"
          cx="18"
          cy="18"
          r={radius}
          strokeDasharray={around}
          strokeDashoffset={around * (1 - progress)}
        />
      </svg>
      <span className="mini-player__glyph">{player.playing ? '❚❚' : '▶'}</span>
    </button>
  );
};

const headIcon = (path: ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {path}
  </svg>
);

/** The rail head's icons (as Claude Code's panel): expand, shrink, close. */
const HEAD_ICONS = {
  expand: headIcon(<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />),
  shrink: headIcon(<path d="M20 10h-6V4M4 14h6v6M14 10l7-7M10 14l-7 7" />),
  close: headIcon(<path d="M6 6l12 12M18 6L6 18" />),
};

/** The open rail: its title, expand and close, and a draggable left edge. */
export const RailHost = ({
  rails,
  title,
  dark = false,
  hidden = false,
  actions,
  children,
}: {
  rails: Rails;
  title: ReactNode;
  /** The Agents rail is a black terminal. */
  dark?: boolean;
  /** Kept mounted but out of sight (the Plan rail keeps its scroll and state). */
  hidden?: boolean;
  /** Buttons in the head, before expand and close (the Plan rail's Skip). */
  actions?: ReactNode;
  children: ReactNode;
}) => {
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (rails.expanded) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragging) {
      rails.setWidth(window.innerWidth - event.clientX);
    }
  };

  return (
    <aside
      className={`rail${dark ? ' rail--dark' : ''}${
        dragging ? ' rail--resizing' : ''
      }`}
      hidden={hidden}
    >
      <div
        className="rail__edge"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize"
        title="Drag to resize"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
      />
      <div className="rail__head">
        <strong className="rail__title">{title}</strong>
        {actions}
        <button
          type="button"
          className="rail__action"
          title={rails.expanded ? 'Shrink back beside the chat' : 'Expand'}
          aria-label={rails.expanded ? 'Shrink' : 'Expand'}
          onClick={() => rails.setExpanded(!rails.expanded)}
        >
          {rails.expanded ? HEAD_ICONS.shrink : HEAD_ICONS.expand}
        </button>
        <button
          type="button"
          className="rail__action"
          title="Close"
          aria-label="Close"
          onClick={() => rails.setRail(null)}
        >
          {HEAD_ICONS.close}
        </button>
      </div>
      {children}
    </aside>
  );
};
