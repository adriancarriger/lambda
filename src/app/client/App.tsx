import {
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { Question } from '../../pod-store';
import { buildingScreenMode } from '../shared/building';
import { buildTimeline } from '../shared/cardHistory';
import { caughtUpLine, launchItems } from '../shared/caughtUp';
import { CHAT_HOLD_MS, owesReply } from '../shared/conversation';
import { iconEmoji } from '../shared/emoji';
import { withWords, wordsOf } from '../shared/images';
import { itemChat, itemStatus, itemTitle } from '../shared/items';
import {
  type Lambda,
  anchorOf,
  lambdaOfEntry,
  lambdasOf,
  sidebarSections,
} from '../shared/lambdas';
import { offersKeepOne } from '../shared/phases';
import { podName } from '../shared/podName';
import { orderPods } from '../shared/podOrder';
import { podNumber } from '../shared/podOrder';
import {
  type Route,
  formatRoute,
  itemSlug,
  lambdaFromSlug,
  lambdaSlugs,
  parseRoute,
  questionFromSlug,
} from '../shared/route';
import { favoriteRef, splitFavoriteRef } from '../shared/savedViews';
import {
  firstRailOf,
  planningRailOf,
  planningRailsOf,
} from '../shared/screenChoice';
import {
  type AppState,
  type InboxEntry,
  type PodDetail,
  isWorking,
} from '../shared/types';
import { isWaitingPodId } from '../shared/waitingPod';
import { CaughtUp, LambdaMark } from './CaughtUp';
import type { PendingChat } from './ChatPanel';
import { Lazy } from './ChunkBoundary';
import { ImageDrop } from './ImageDrop';
import { LambdaTicketsRail } from './LambdaTickets';
import {
  NewPodForm,
  clearNewDraft,
  startNewAbout,
  startNewDraft,
} from './NewPodForm';
import { PhaseStrip } from './PhaseStrip';
import {
  BUILDING_RAILS,
  MIN_CHAT,
  MiniPlayer,
  RailHost,
  RailSwitcher,
  useRails,
} from './Rails';
import { type FavoriteRow, Sidebar } from './Sidebar';
import type { OpenTicket, TicketsScope } from './TicketsPage';
import { ViewerProvider } from './Viewer';
import { api } from './api';
import { playChatChime, playReadyChime } from './chime';
import { isTypingTarget } from './keys';
import { type Page, accountPageOf, pageOfRoute, settingsTabOf } from './page';
import {
  type ScrollAnchor,
  anchorAt,
  loadPlace,
  savePlace,
  scrollToAnchor,
} from './planPlace';
import { ACCOUNT_PAGE_TITLES, withProjectTag } from './projects';
import { itemSections } from './speech';
import { uiLog } from './uiLog';
import { untilFound } from './untilFound';
import { formatDuration, useActiveTime } from './useActiveTime';
import { usePlayer } from './usePlayer';
import { useWorkspace } from './useWorkspace';

// Each page is its own chunk: the first load doesn't ship them all.
const TimePage = lazy(() =>
  import('./TimePage').then((module) => ({ default: module.TimePage }))
);
const ComputersPage = lazy(() =>
  import('./ComputersPage').then((module) => ({
    default: module.ComputersPage,
  }))
);
const AnalyticsPage = lazy(() =>
  import('./AnalyticsPage').then((module) => ({
    default: module.AnalyticsPage,
  }))
);
const SettingsPage = lazy(() =>
  import('./SettingsPage').then((module) => ({ default: module.SettingsPage }))
);
const TicketsPage = lazy(() =>
  import('./TicketsPage').then((module) => ({ default: module.TicketsPage }))
);
const ProjectsPage = lazy(() =>
  import('./ProjectsPage').then((module) => ({
    default: module.ProjectsPage,
  }))
);
const ViewsPage = lazy(() =>
  import('./ViewsPage').then((module) => ({ default: module.ViewsPage }))
);
// A building pod's page: its own chunk, like the pod screen.
const BuildingPodScreen = lazy(() =>
  import('./BuildingPodScreen').then((module) => ({
    default: module.BuildingPodScreen,
  }))
);

// A Lambda's page past planning: Ready, Building, QA and Merged.
const LambdaScreen = lazy(() =>
  import('./LambdaScreen').then((module) => ({
    default: module.LambdaScreen,
  }))
);

// The pod screen — a Lambda's chat, its cards, workflow, terminals and what
// it made — is its own chunk too (PodScreen.tsx); this file is the shell
// around it (sidebar, queue, player, pages).
const podScreen = () => import('./PodScreen');
const ChatPanel = lazy(() =>
  podScreen().then((module) => ({ default: module.ChatPanel }))
);
const QuestionCard = lazy(() =>
  podScreen().then((module) => ({ default: module.QuestionCard }))
);
const WorkflowPanel = lazy(() =>
  podScreen().then((module) => ({ default: module.WorkflowPanel }))
);
const WindowPicker = lazy(() =>
  podScreen().then((module) => ({ default: module.WindowPicker }))
);

/** A planning pod's window as the Agents panel names it. */
const planningWindowName = (window: string): string =>
  window === 'dev'
    ? 'Dev'
    : window === 'manager'
    ? 'Manager'
    : `Fork ${window.slice(5)}`;
const PlanPlayer = lazy(() =>
  podScreen().then((module) => ({ default: module.PlanPlayer }))
);
const PodIdle = lazy(() =>
  podScreen().then((module) => ({ default: module.PodIdle }))
);
const StructureCard = lazy(() =>
  podScreen().then((module) => ({ default: module.StructureCard }))
);
const YourTurnCard = lazy(() =>
  podScreen().then((module) => ({ default: module.YourTurnCard }))
);
const StalledCard = lazy(() =>
  podScreen().then((module) => ({ default: module.StalledCard }))
);
const OldVersionNote = lazy(() =>
  podScreen().then((module) => ({ default: module.OldVersionNote }))
);
const VersionMenu = lazy(() =>
  podScreen().then((module) => ({ default: module.VersionMenu }))
);
const MadeRail = lazy(() =>
  podScreen().then((module) => ({ default: module.MadeRail }))
);

/** How long a remembered scroll place keeps being put back while the card lays out. */
const RESTORE_MS = 2_000;
/** The shortest time the λ loading screen shows. */
const MIN_LOADING_MS = 1_300;
/** The loading screen's fade out (matches .loading--out in styles.css). */
const LOADING_FADE_MS = 400;
/** How long the sidebar takes to slide open or shut (see styles.css). */
const SIDEBAR_SLIDE_MS = 220;

const keyOf = (entry: InboxEntry): string => entry.key;

/** Why this item has no audio, in words the owner can act on. */
const audioUnavailableReason = (audioMeta: InboxEntry['audio']): string => {
  // Shown only when no clip can be rendered: the first one says why.
  const [audio] = Object.values(audioMeta?.clips ?? {});

  if (audio === undefined || audio.status !== 'unavailable') {
    return 'No audio';
  }

  if (audio.reason === 'no-key') {
    return 'No audio — no ElevenLabs key found';
  }

  if (audio.reason === 'over-budget') {
    return 'No audio — monthly audio budget reached';
  }

  if (audio.reason.includes('quota')) {
    return 'No audio — ElevenLabs credits used up';
  }

  if (audio.reason.includes('text_to_speech')) {
    return 'No audio — the ElevenLabs key lacks the text-to-speech permission';
  }

  return `No audio — the render failed (${audio.reason.slice(0, 80)})`;
};

/**
 * Drafts survive reloads and app restarts: saved per item as you type,
 * restored when the item comes up, cleared once sent. (Browser storage can be
 * unavailable — then drafts just aren't kept.)
 */
const DRAFT_PREFIX = 'pods.draft.';

const saveDraft = (key: string | null, value: string): void => {
  if (key === null) {
    return;
  }

  try {
    if (value.trim() === '') {
      window.localStorage.removeItem(DRAFT_PREFIX + key);

      return;
    }

    window.localStorage.setItem(DRAFT_PREFIX + key, value);
  } catch {
    // Not kept — the box still works.
  }
};

const loadDraft = (key: string): string => {
  try {
    return window.localStorage.getItem(DRAFT_PREFIX + key) ?? '';
  } catch {
    return '';
  }
};

/**
 * Every message sent from this browser, kept 48 h (whatever happens to the
 * box): if one never shows up in its pod's saved thread, the page offers it
 * back. Drafts are cleared on send; these are not.
 */
const SENT_KEY = 'pods.sent';
const SENT_KEEP_MS = 48 * 60 * 60_000;
/** How long a send may take to show up in the thread before it counts as lost. */
const ARRIVAL_GRACE_MS = 30_000;

interface SentMessage {
  id: string;
  podId: string;
  /** The inbox item it was typed on (for putting it back in the box). */
  itemKey: string | null;
  text: string;
  at: number;
  dismissed?: boolean;
}

const isSentMessage = (value: unknown): value is SentMessage =>
  typeof value === 'object' &&
  value !== null &&
  'id' in value &&
  typeof value.id === 'string' &&
  'podId' in value &&
  typeof value.podId === 'string' &&
  'text' in value &&
  typeof value.text === 'string' &&
  'at' in value &&
  typeof value.at === 'number';

const loadSent = (): SentMessage[] => {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(SENT_KEY) ?? '[]'
    );

    return Array.isArray(parsed)
      ? parsed
          .filter(isSentMessage)
          .filter((message) => Date.now() - message.at < SENT_KEEP_MS)
      : [];
  } catch {
    return [];
  }
};

const storeSent = (messages: SentMessage[]): void => {
  try {
    window.localStorage.setItem(SENT_KEY, JSON.stringify(messages));
  } catch {
    // Not kept — sending still works.
  }
};

/**
 * "Back when done": an item set aside until its pod's dev finishes the turn
 * they're waiting on. Kept in this browser, so a reload doesn't bring it back.
 */
interface AsideItem {
  key: string;
  podId: string;
  at: number;
}

const ASIDE_KEY = 'pods.aside';

const isAsideItem = (value: unknown): value is AsideItem =>
  typeof value === 'object' &&
  value !== null &&
  'key' in value &&
  typeof value.key === 'string' &&
  'podId' in value &&
  typeof value.podId === 'string' &&
  'at' in value &&
  typeof value.at === 'number';

const loadAside = (): AsideItem[] => {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(ASIDE_KEY) ?? '[]'
    );

    return Array.isArray(parsed) ? parsed.filter(isAsideItem) : [];
  } catch {
    return [];
  }
};

const storeAside = (items: AsideItem[]): void => {
  try {
    window.localStorage.setItem(ASIDE_KEY, JSON.stringify(items));
  } catch {
    // Not kept: a reload brings set-aside items straight back.
  }
};

export const App = () => {
  const [state, setState] = useState<AppState | null>(null);
  const [detail, setDetail] = useState<PodDetail | null>(null);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /**
   * null = Auto mode: the pod on screen follows the queue (every pod's items,
   * by priority). A pod id = that pod, picked in the sidebar (Auto is off).
   */
  const [view, setViewNow] = useState<string | null>(null);
  /** Every view change is logged with what caused it (see uiLog). */
  const setView = useCallback((next: string | null, why = 'unknown') => {
    setViewNow((from) => {
      if (from !== next) {
        uiLog('view', { from, to: next, why });
      }

      return next;
    });
  }, []);
  /**
   * A Lambda's page picked in the sidebar (or a /work URL): its key, and the
   * pod `view` was set to with it. Shown while `view` is still that pod, so
   * picking anything else leaves it.
   */
  const [lambdaOpen, setLambdaOpen] = useState<{
    key: string;
    podId: string;
  } | null>(null);
  /** The item being worked on — stays put during a conversation. */
  const [pinned, setPinned] = useState<InboxEntry | null>(null);
  /** Answered locally; hidden until the server shows it caught up. */
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [conversation, setConversation] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [chatDraft, setChatDraft] = useState('');
  /** An option they clicked on the item up (else Done goes with the rec). */
  const [pick, setPick] = useState<{ key: string; optionId: string } | null>(
    null
  );
  // The λ loading screen stays up at least MIN_LOADING_MS, so a fast load
  // doesn't flash it.
  const [loadingShown, setLoadingShown] = useState(false);
  /** The loading screen has finished fading out. */
  const [loadingGone, setLoadingGone] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setLoadingShown(true), MIN_LOADING_MS);

    return () => window.clearTimeout(id);
  }, []);
  /** The chat box's text when no item is up (an item's is `draft`). */
  const [podDraft, setPodDraft] = useState('');
  // The sidebar can fold to an icon strip, as in Claude Code. Remembered.
  const [sidebarCollapsed, setSidebarCollapsedNow] = useState(() => {
    try {
      return window.localStorage.getItem('pods.sidebar') === 'collapsed';
    } catch {
      return false;
    }
  });
  const setSidebarCollapsed = (next: boolean): void => {
    setSidebarCollapsedNow(next);

    try {
      window.localStorage.setItem('pods.sidebar', next ? 'collapsed' : 'open');
    } catch {
      // Private mode: it just isn't remembered.
    }
  };
  /**
   * Opening or closing the sidebar slides it: the column narrows or widens
   * while the sidebar stays laid out open inside it, clipped, so nothing
   * re-wraps. Closing keeps the open sidebar until the slide ends.
   */
  const [sidebarSlide, setSidebarSlide] = useState<
    'opening' | 'closing' | null
  >(null);
  const slideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (slideTimer.current !== null) {
        clearTimeout(slideTimer.current);
      }
    },
    []
  );
  const toggleSidebar = (close: boolean): void => {
    if (slideTimer.current !== null) {
      return;
    }

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setSidebarCollapsed(close);

      return;
    }

    setSidebarSlide(close ? 'closing' : 'opening');

    if (!close) {
      setSidebarCollapsed(false);
    }

    slideTimer.current = setTimeout(() => {
      slideTimer.current = null;

      if (close) {
        setSidebarCollapsed(true);
      }

      setSidebarSlide(null);
    }, SIDEBAR_SLIDE_MS);
  };
  const sidebarNarrow = sidebarCollapsed || sidebarSlide === 'closing';
  // The chat is always in the center; one rail at a time opens beside it.
  const rails = useRails(sidebarNarrow ? 56 : 288);
  const [chatPending, setChatPending] = useState<PendingChat[]>([]);
  const [rightTab, setRightTab] = useState('dev');
  // The screen starts as the URL says (shared/route.ts); a Lambda or an item
  // in it is resolved once the state has loaded.
  const startRoute = useRef(
    parseRoute(window.location.pathname, window.location.search)
  );
  /** The page up instead of the inbox or a Lambda (page.ts), if any. */
  const [page, setPage] = useState<Page | null>(() =>
    pageOfRoute(startRoute.current)
  );
  const creating = page === 'new';
  /** The Time page (opened from the stopwatch). */
  const showTime = page === 'time';
  /** The Tickets page: Computers, All tickets and a ticket's own page. */
  const showTickets = page === 'tickets';
  /** Tickets, Projects or Views: full-width pages of their own, Linear's way. */
  const listPage = showTickets || page === 'projects' || page === 'views';
  /** The ticket page up on the Tickets screen, if any. */
  const [openTicket, setOpenTicket] = useState<OpenTicket | null>(null);
  /** The Tickets list: all of it, a tracker project's, or a saved view's. */
  const [ticketsScope, setTicketsScope] = useState<TicketsScope>({
    kind: 'all',
  });
  /** A project's or view's unsaved filters, as the address keeps them. */
  const [ticketsFilter, setTicketsFilter] = useState<string | undefined>(
    undefined
  );
  /** The project "Plan with Lambda" picked for the New page, if any. */
  const [newProjectId, setNewProjectId] = useState<string | null>(null);
  /** An account-menu page: Computers, Analytics or Settings. */
  const accountPage = accountPageOf(page);
  const otherPage = page !== null;
  /** Show one page, or none of them (the inbox, or a Lambda). */
  const showPage = setPage;
  /** The inbox item being worked on (its key) — held until dealt with or skipped. */
  const [held, setHeld] = useState<string | null>(null);
  /** Set aside with "Back when done" — out of the queue until the dev's done. */
  const [aside, setAsideNow] = useState<AsideItem[]>(loadAside);
  const setAside = (update: (previous: AsideItem[]) => AsideItem[]): void =>
    setAsideNow((previous) => {
      const next = update(previous);
      storeAside(next);

      return next;
    });
  /** Back from "Back when done": first in the queue, ahead of priority. */
  const [returned, setReturned] = useState<string[]>([]);
  /** What was already waiting when the current item came up. */
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  /**
   * Items opened from a link ("How we got here", "This led to", a pod's item
   * list) — a stack, so "← Back" retraces the chain. Top of it overrides the
   * inbox until closed.
   */
  const [trail, setTrail] = useState<{ podId: string; qid: string }[]>([]);

  const fail = useCallback((caught: unknown) => {
    setError(caught instanceof Error ? caught.message : String(caught));
  }, []);
  // Saved views, favorites and the trackers' projects.
  const workspace = useWorkspace(tick, fail);

  // ── data ────────────────────────────────────────────────────────────────
  // Fetch the pod screen's chunk while the state loads, so a Lambda opens
  // without waiting on it.
  useEffect(() => {
    // A failed prefetch isn't lost: the lazy screen's own import fails the
    // same way and its ChunkBoundary says so.
    podScreen().catch(() => undefined);
  }, []);

  const stateFailures = useRef(0);

  useEffect(() => {
    const source = new EventSource('/api/events');
    source.onmessage = () => setTick((value) => value + 1);
    source.onerror = () =>
      uiLog('events-error', { readyState: source.readyState });
    source.onopen = () => uiLog('events-open');
    // Belt and braces: the event stream runs through the Tailscale proxy and
    // can go quiet without closing, leaving the page on an old state (an
    // answer sat behind "Working…" that way). Re-read every 20s while visible.
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        setTick((value) => value + 1);
      }
    }, 20_000);

    return () => {
      source.close();
      window.clearInterval(poll);
    };
  }, []);

  useEffect(() => {
    // A failed read retries shortly rather than leaving the page stale until
    // the next change happens to arrive.
    const retry = { timer: 0 };
    api
      .state()
      .then((next) => {
        if (stateFailures.current > 0) {
          uiLog('state-recovered', { after: stateFailures.current });
          stateFailures.current = 0;
        }

        setState(next);
      })
      .catch((caught: unknown) => {
        stateFailures.current += 1;
        uiLog('state-failed', {
          n: stateFailures.current,
          error: caught instanceof Error ? caught.message : String(caught),
        });
        retry.timer = window.setTimeout(
          () => setTick((value) => value + 1),
          3_000
        );
      });

    return () => window.clearTimeout(retry.timer);
  }, [tick]);

  /** A pod just started here, until the state has it. */
  const justCreated = useRef<string | null>(null);

  // A remembered pod that no longer exists (deleted elsewhere): back to Auto.
  // One just created isn't gone — the state hasn't caught up with it yet.
  useEffect(() => {
    if (state === null || view === null) {
      return;
    }

    if (state.pods.some((summary) => summary.pod.id === view)) {
      if (justCreated.current === view) {
        justCreated.current = null;
      }

      return;
    }

    if (justCreated.current !== view) {
      setView(null, 'pod-gone');
    }
  }, [state, view, setView]);

  // Drop local hides the server has caught up with, so an item can come back
  // later (e.g. a parked conversation the fork has since replied to).
  useEffect(() => {
    if (state === null) {
      return;
    }

    const live = new Set(state.inbox.map(keyOf));
    setHidden(
      (previous) => new Set([...previous].filter((key) => live.has(key)))
    );
  }, [state]);

  // Empty inbox → something to review: chime. Never on first load (that's
  // not a change), and counted across all pods, whatever page is open.
  const waiting =
    state === null
      ? null
      : state.inbox.filter((entry) => !hidden.has(keyOf(entry))).length;
  const lastWaiting = useRef<number | null>(null);

  useEffect(() => {
    if (waiting === null) {
      return;
    }

    if (lastWaiting.current === 0 && waiting > 0) {
      playReadyChime();
    }

    lastWaiting.current = waiting;
  }, [waiting]);

  // ⌘⏎ in the Chat panel hides the pod at once; the server holds it from the
  // moment its message is in the thread (summary.chatSentAt) until the reply.
  const holdingNow = useMemo(
    () =>
      new Set(
        chatPending
          .filter((sent) => {
            const sentAt = state?.pods.find(
              (summary) => summary.pod.id === sent.podId
            )?.chatSentAt;
            const serverHasIt =
              sentAt !== undefined && Date.parse(sentAt) >= sent.at - 60_000;

            return (
              sent.hold === true &&
              sent.failed !== true &&
              !serverHasIt &&
              Date.now() - sent.at < CHAT_HOLD_MS
            );
          })
          .map((sent) => sent.podId)
      ),
    [chatPending, state]
  );

  /**
   * What's waiting on them, every pod. A "Your turn" (the dev asked them
   * something) is the latest message in that pod's chat: when the pod also
   * has a real item up, it isn't a stop of its own — they see the item, and
   * answer the dev in the chat beside it.
   */
  const stops = useMemo(() => {
    // A pod set aside is busy answering them: all of it waits, not just the
    // item they left — its other items come back with it when it's done.
    const live = (state?.inbox ?? []).filter(
      (entry) =>
        !hidden.has(keyOf(entry)) &&
        !aside.some((item) => item.podId === entry.podId)
    );

    return live.filter(
      (entry) =>
        entry.kind !== 'reply' ||
        !live.some(
          (other) =>
            other.podId === entry.podId &&
            (other.kind === 'question' || other.kind === 'checkpoint')
        )
    );
  }, [state, hidden, aside]);

  const visibleInbox = useMemo(
    () =>
      stops.filter(
        (entry) =>
          !holdingNow.has(entry.podId) &&
          (view === null || entry.podId === view)
      ),
    [stops, holdingNow, view]
  );

  // Every chat reply, from any pod, gets the chat chime — not on first load.
  const chatReplied = useRef<Map<string, string> | null>(null);

  useEffect(() => {
    if (state === null) {
      return;
    }

    const latest = new Map(
      state.pods.flatMap((summary) =>
        summary.chatRepliedAt === undefined
          ? []
          : [[summary.pod.id, summary.chatRepliedAt] as const]
      )
    );
    const before = chatReplied.current;

    if (
      before !== null &&
      [...latest].some(([podId, at]) => (before.get(podId) ?? '') < at)
    ) {
      playChatChime();
    }

    chatReplied.current = latest;
  }, [state]);

  const opened = trail.at(-1) ?? null;
  const openedQuestion =
    opened === null
      ? undefined
      : state?.questions[opened.podId]?.find(
          (candidate) => candidate.id === opened.qid
        );
  const openedEntry: InboxEntry | null =
    opened === null || openedQuestion === undefined
      ? null
      : {
          podId: opened.podId,
          kind:
            openedQuestion.kind === 'checkpoint' ? 'checkpoint' : 'question',
          key: `${opened.podId}/q/${opened.qid}`,
          qid: opened.qid,
          // Its pre-rendered audio, when it is also in the inbox.
          audio: state?.inbox.find(
            (entry) => entry.key === `${opened.podId}/q/${opened.qid}`
          )?.audio,
        };
  // The queue: the server's priority order, with anything back from "Back
  // when done" first — it was already their turn on it.
  const queue = useMemo(
    () => [
      ...returned.flatMap((key) =>
        visibleInbox.filter((entry) => keyOf(entry) === key)
      ),
      ...visibleInbox.filter((entry) => !returned.includes(keyOf(entry))),
    ],
    [visibleInbox, returned]
  );

  // The item being worked on STAYS until it's dealt with or skipped — a new
  // arrival never replaces it. (The live entry, so its audio stays fresh.)
  const heldEntry =
    held === null
      ? undefined
      : visibleInbox.find((entry) => keyOf(entry) === held);
  const current: InboxEntry | null =
    openedEntry ??
    (pinned !== null && (view === null || pinned.podId === view)
      ? pinned
      : heldEntry ?? queue[0] ?? null);
  const currentKey = current === null ? null : keyOf(current);

  // Hold whatever came up, and remember what was already waiting at that
  // moment: anything that arrives after is "new" (the Up-next strip, badges).
  useEffect(() => {
    if (openedEntry !== null || pinned !== null) {
      return;
    }

    const head = heldEntry ?? queue[0];
    const key = head === undefined ? null : keyOf(head);

    if (key !== held) {
      setHeld(key);
      setSeen(new Set((state?.inbox ?? []).map(keyOf)));
    }
  }, [heldEntry, queue, held, openedEntry, pinned, state]);

  // Sent messages, kept 48 h, so one that never arrives can be put back.
  const [sentLog, setSentLog] = useState<SentMessage[]>(loadSent);
  const recordSent = useCallback(
    (podId: string, itemKey: string | null, text: string): void => {
      if (text.trim() === '') {
        return;
      }

      setSentLog((previous) => {
        const next = [
          ...previous.filter(
            (message) => Date.now() - message.at < SENT_KEEP_MS
          ),
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            podId,
            itemKey,
            text: text.trim(),
            at: Date.now(),
          },
        ];
        storeSent(next);

        return next;
      });
    },
    []
  );
  const dismissSent = useCallback((id: string): void => {
    setSentLog((previous) => {
      const next = previous.map((message) =>
        message.id === id ? { ...message, dismissed: true } : message
      );
      storeSent(next);

      return next;
    });
  }, []);

  // Whatever you'd typed for this item comes back with it.
  useEffect(() => {
    if (currentKey !== null) {
      setDraft(loadDraft(currentKey));
    }
  }, [currentKey]);

  // "Back when done": a pod set aside comes back once its dev is done — it has
  // answered them and its turn has ended — first in the queue, with a chime.
  // The item they left may have left the inbox meanwhile (their chat reply
  // answered it): the pod still waits for the turn to end, then its other
  // items come back. Checked on every state change.
  useEffect(() => {
    if (state === null) {
      return undefined;
    }

    const live = new Set(state.inbox.map(keyOf));
    const podsNow = new Set(state.pods.map((summary) => summary.pod.id));
    const kept = aside.filter((item) => podsNow.has(item.podId));

    setReturned((previous) =>
      previous.every((key) => live.has(key))
        ? previous
        : previous.filter((key) => live.has(key))
    );

    if (kept.length !== aside.length) {
      setAside(() => kept);
    }

    if (kept.length === 0) {
      return undefined;
    }

    const cancelled = { now: false };
    const podIds = [...new Set(kept.map((item) => item.podId))];

    Promise.all(
      podIds.map(async (podId) => {
        const summary = state.pods.find((each) => each.pod.id === podId);
        const podDetail = await api.pod(podId);
        const done = summary?.devBusy !== true && !owesReply(podDetail.thread);

        return done ? podId : null;
      })
    )
      .then((results) => {
        const donePods = new Set(results.filter((id) => id !== null));

        if (cancelled.now || donePods.size === 0) {
          return;
        }

        // The item they left, first in line — or, when it's gone (their reply
        // answered it, or they stepped away from the chat itself), what the
        // pod has waiting now: its answer.
        const ready = podIds
          .filter((podId) => donePods.has(podId))
          .flatMap((podId) => {
            const left = kept
              .filter((item) => item.podId === podId && live.has(item.key))
              .map((item) => item.key);

            return left.length > 0
              ? left
              : state.inbox.filter((entry) => entry.podId === podId).map(keyOf);
          });
        setAside((previous) =>
          previous.filter((item) => !donePods.has(item.podId))
        );
        setReturned((previous) => [
          ...previous,
          ...ready.filter((key) => !previous.includes(key)),
        ]);
        playReadyChime();
      })
      .catch(() => undefined);

    return () => {
      cancelled.now = true;
    };
  }, [state]);

  /**
   * Arrived since the current item came up — by priority (sidebar) order.
   * Only what's really up: a pod set aside answering them has nothing new.
   */
  const fresh = useMemo(
    () =>
      stops.filter(
        (entry) => !seen.has(keyOf(entry)) && keyOf(entry) !== currentKey
      ),
    [stops, seen, currentKey]
  );
  const freshPods = useMemo(
    () => new Set(fresh.map((entry) => entry.podId)),
    [fresh]
  );
  /** The strip offers only what this view can open (a pod page: its own items). */
  const freshHere = useMemo(
    () => fresh.filter((entry) => view === null || entry.podId === view),
    [fresh, view]
  );
  // The chat keeps the pod it was on when nothing is on screen (all caught up),
  // so sending a message never makes it vanish.
  const [lastPod, setLastPod] = useState<string | null>(null);
  const onScreenPod = current?.podId ?? view;

  /** The pod last on screen — never let go, for turning Auto off from all caught up. */
  const lastSeenPod = useRef<string | null>(null);

  useEffect(() => {
    if (onScreenPod !== null) {
      setLastPod(onScreenPod);
      lastSeenPod.current = onScreenPod;
    }
  }, [onScreenPod]);

  const detailPodId = onScreenPod ?? lastPod;

  // Every Lambda across its whole life, and the sidebar's sections of them.
  const lambdas = useMemo(
    () => (state === null ? [] : lambdasOf(state)),
    [state]
  );
  const lambdaSections = useMemo(
    // A shipped one leaves after a day: sorted afresh with each new state.
    () => sidebarSections(lambdas, stops, Date.now()),
    [lambdas, stops]
  );
  /**
   * The Lambda page on screen: one picked (while `view` is still its pod),
   * or in Auto, the Lambda past planning whose build blocker or review is up.
   */
  const pickedLambda =
    lambdaOpen !== null && view === lambdaOpen.podId
      ? lambdas.find((one) => one.key === lambdaOpen.key)
      : undefined;
  const autoLambda =
    view === null && current !== null && current.tag !== undefined
      ? lambdaOfEntry(lambdas, current)
      : undefined;
  /** The Lambda of the planning chat on screen: its tickets, its ticket link. */
  const detailLambda = lambdas.find(
    (one) => one.planningPodId !== null && one.planningPodId === detailPodId
  );
  const lambdaShown: Lambda | undefined =
    page !== null
      ? undefined
      : pickedLambda !== undefined && pickedLambda.phase !== 'planning'
      ? pickedLambda
      : autoLambda !== undefined && autoLambda.phase !== 'planning'
      ? autoLambda
      : undefined;

  // Tell the server what's on screen the moment it changes: the audio queue
  // re-prioritizes around it (an item, else a pod page) at Kokoro's next piece.
  useEffect(() => {
    api.focus(current?.podId ?? view, currentKey).catch(() => undefined);
  }, [current?.podId, currentKey, view]);

  useEffect(() => {
    if (detailPodId === null) {
      setDetail(null);

      return undefined;
    }

    // Retrying, so a pod left for another must not land on its page.
    const live = { current: true };

    untilFound(() => api.pod(detailPodId))
      .then((found) => {
        if (live.current) {
          setDetail(found);
        }
      })
      .catch((error: unknown) => {
        if (live.current) {
          fail(error);
        }
      });

    return () => {
      live.current = false;
    };
  }, [detailPodId, tick, fail]);

  const question =
    current === null
      ? null
      : state?.questions[current.podId]?.find(
          (candidate) => candidate.id === current.qid
        ) ?? null;
  const pod =
    state?.pods.find((summary) => summary.pod.id === current?.podId)?.pod ??
    null;
  const inConversation = currentKey !== null && conversation === currentKey;
  const podSummary =
    state?.pods.find((summary) => summary.pod.id === current?.podId) ?? null;

  // A checkpoint's earlier versions (re-fetched when it gets a new one): its
  // cards' drafts come from them (cardHistory.ts).
  const cardPodId = question?.kind === 'checkpoint' ? question.podId : null;
  const cardQid = question?.kind === 'checkpoint' ? question.id : null;
  const cardVersion = question?.checkpoint?.version ?? 1;
  const [cardVersions, setCardVersions] = useState<{
    qid: string;
    list: Question[];
  } | null>(null);

  useEffect(() => {
    if (cardPodId === null || cardQid === null) {
      return;
    }

    api
      .versions(cardPodId, cardQid)
      .then((list) => setCardVersions({ qid: cardQid, list }))
      // An inbox server older than versions: there are none to show.
      .catch(() => setCardVersions({ qid: cardQid, list: [] }));
  }, [cardPodId, cardQid, cardVersion]);

  const olderVersions =
    cardVersions !== null && cardVersions.qid === cardQid
      ? cardVersions.list
      : [];
  // The version on screen: the current one unless they picked another (from
  // the checkpoint's list or any card's). One version at a time, for the
  // whole checkpoint.
  const [viewingVersion, setViewingVersion] = useState<{
    qid: string;
    version: number;
  } | null>(null);
  const oldCard =
    viewingVersion !== null && viewingVersion.qid === cardQid
      ? olderVersions.find(
          (version) =>
            (version.checkpoint?.version ?? 1) === viewingVersion.version
        ) ?? null
      : null;
  const shownCard = oldCard ?? question;
  // The current version's decisions as worded now (a card posted before
  // versions kept a copy has none of its own).
  const liveDecisions = detail?.autonomous ?? [];
  const currentCard =
    question?.checkpoint === undefined ||
    question.checkpoint.decisionSnapshot !== undefined
      ? question
      : {
          ...question,
          checkpoint: {
            ...question.checkpoint,
            decisionSnapshot: liveDecisions.filter((decision) =>
              question.checkpoint?.decisionIds.includes(decision.id)
            ),
          },
        };
  const timeline = useMemo(
    () =>
      buildTimeline(
        currentCard === null || cardQid === null
          ? []
          : [...olderVersions, currentCard]
      ),
    [olderVersions, currentCard, cardQid]
  );
  /** The version the Plan rail is showing, for the timer (none: not shown). */
  const versionOnScreen =
    cardQid !== null && rails.rail === 'plan' && !otherPage
      ? shownCard?.checkpoint?.version ?? cardVersion
      : undefined;
  /**
   * Switching versions from a card keeps that card where it was on screen:
   * where it sat, read before the switch and restored after it.
   */
  const anchor = useRef<{ card: string; top: number } | null>(null);
  const viewVersion = (version: number | null, card?: string): void => {
    const box = scrollRef.current;
    const element =
      card === undefined
        ? null
        : box?.querySelector<HTMLElement>(`[data-card="${CSS.escape(card)}"]`);
    anchor.current =
      box === null ||
      box === undefined ||
      element === null ||
      element === undefined ||
      card === undefined
        ? null
        : {
            card,
            top:
              element.getBoundingClientRect().top -
              box.getBoundingClientRect().top,
          };
    pushNext.current = true;
    setViewingVersion(
      version === null || cardQid === null ? null : { qid: cardQid, version }
    );
  };

  // ── the address bar (shared/route.ts) ─────────────────────────────────
  /** The next URL change is a step they took inside the same place: a new entry. */
  const pushNext = useRef(false);
  /** The change came from Back/Forward: the URL is already right. */
  const fromHistory = useRef(false);
  /** The URL the start route has been applied (once the state is in). */
  const [routeReady, setRouteReady] = useState(false);
  /** Where they were, for "is this a new place?" (a page, Auto, or a Lambda). */
  const lastStop = useRef<string | null>(null);

  const lambdasNow = useMemo(
    () =>
      (state?.pods ?? []).map((summary) => ({
        id: summary.pod.id,
        name: podName(summary.pod),
        slug: summary.pod.slug,
      })),
    [state?.pods]
  );
  const slugs = useMemo(() => lambdaSlugs(lambdasNow), [lambdasNow]);
  const cpOf = (entry: InboxEntry): number | undefined =>
    entry.qid === undefined
      ? undefined
      : state?.questions[entry.podId]?.find(
          (candidate) => candidate.id === entry.qid
        )?.checkpoint?.cp;

  /** A pod just made (from the box, or New project): open it. */
  const openCreated = (podId: string): void => {
    // Its computer is busy on another project: it waits in the sidebar and
    // starts by itself.
    if (isWaitingPodId(podId)) {
      showPage(null);
      setTick((value) => value + 1);

      return;
    }

    justCreated.current = podId;
    showPage(null);
    setView(podId, 'new-pod-created');
    setPinned(null);
    setTick((value) => value + 1);
  };

  /** Show what a URL describes (on load, and on Back/Forward). */
  const applyRoute = (route: Route): void => {
    if (state === null) {
      return;
    }

    showPage(pageOfRoute(route));
    setPinned(null);
    setTrail([]);
    setViewingVersion(null);

    if (route.page === 'tickets') {
      if (route.project === undefined || route.ticket === undefined) {
        setOpenTicket(null);
        setTicketsScope({ kind: 'all' });
        setTicketsFilter(undefined);

        return;
      }

      setOpenTicket({ projectId: route.project, ticketId: route.ticket });

      return;
    }

    if (route.page === 'project' || route.page === 'view') {
      setOpenTicket(null);
      setTicketsScope(
        route.page === 'project'
          ? { kind: 'project', codebaseId: route.codebase, name: route.name }
          : { kind: 'view', viewId: route.id }
      );
      setTicketsFilter(route.filter);

      return;
    }

    if (route.page === 'work') {
      const named = lambdasOf(state).find((one) => one.key === route.lambda);
      const anchor = named === undefined ? null : anchorOf(named);

      if (named === undefined || anchor === null) {
        showPage('new');

        return;
      }

      setView(anchor, 'url');
      setLambdaOpen({ key: named.key, podId: anchor });

      return;
    }

    if (route.page !== 'auto' && route.page !== 'lambda') {
      return;
    }

    const podId =
      route.lambda === undefined
        ? undefined
        : lambdaFromSlug(route.lambda, lambdasNow);

    if (route.page === 'lambda' && podId === undefined) {
      // A Lambda that's gone: the front door.
      showPage('new');

      return;
    }

    setView(route.page === 'auto' ? null : podId ?? null, 'url');

    if (route.page === 'auto') {
      setHeld(null);
      setLastPod(null);
    }

    if (podId === undefined || route.item === undefined) {
      return;
    }

    const entry = state.inbox.find(
      (candidate) =>
        candidate.podId === podId &&
        itemSlug(candidate, cpOf(candidate)) === route.item
    );
    const questionNamed = questionFromSlug(
      route.item,
      state.questions[podId] ?? []
    );

    if (entry !== undefined) {
      setPinned(entry);
    } else if (route.page === 'lambda' && questionNamed !== undefined) {
      setTrail([{ podId, qid: questionNamed.id }]);
    }

    if (route.version !== undefined && questionNamed !== undefined) {
      setViewingVersion({ qid: questionNamed.id, version: route.version });
    }
  };
  const applyRouteRef = useRef(applyRoute);
  applyRouteRef.current = applyRoute;

  // The start URL, once there's something to resolve it against.
  useEffect(() => {
    if (state !== null && !routeReady) {
      applyRoute(startRoute.current);
      setRouteReady(true);
    }
  }, [state, routeReady]);

  // Back / Forward.
  useEffect(() => {
    const onPop = (): void => {
      fromHistory.current = true;
      applyRouteRef.current(
        parseRoute(window.location.pathname, window.location.search)
      );
    };
    window.addEventListener('popstate', onPop);

    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /** The URL for what's on screen now. */
  const itemPart =
    current === null ? undefined : itemSlug(current, cpOf(current));
  const versionPart =
    oldCard === null ? undefined : viewingVersion?.version ?? undefined;
  const routeNow: Route | null =
    state === null || !routeReady
      ? null
      : creating
      ? { page: 'new' }
      : showTime
      ? { page: 'time' }
      : showTickets
      ? openTicket !== null
        ? {
            page: 'tickets',
            project: openTicket.projectId,
            ticket: openTicket.ticketId,
          }
        : ticketsScope.kind === 'project'
        ? {
            page: 'project',
            codebase: ticketsScope.codebaseId,
            name: ticketsScope.name,
            filter: ticketsFilter,
          }
        : ticketsScope.kind === 'view'
        ? { page: 'view', id: ticketsScope.viewId, filter: ticketsFilter }
        : { page: 'tickets' }
      : page === 'projects'
      ? { page: 'projects' }
      : page === 'views'
      ? { page: 'views' }
      : accountPage !== null
      ? { page: 'account', which: accountPage }
      : pickedLambda !== undefined && lambdaShown === pickedLambda
      ? { page: 'work', lambda: pickedLambda.key }
      : view === null
      ? current === null
        ? { page: 'auto' }
        : {
            page: 'auto',
            lambda: slugs.get(current.podId) ?? current.podId,
            item: itemPart,
            version: versionPart,
          }
      : {
          page: 'lambda',
          lambda: slugs.get(view) ?? view,
          item:
            current !== null && current.podId === view ? itemPart : undefined,
          version: versionPart,
        };
  const urlNow = routeNow === null ? null : formatRoute(routeNow);
  const stopNow = creating
    ? 'new'
    : showTime
    ? 'time'
    : showTickets
    ? `tickets:${openTicket?.projectId ?? ''}:${openTicket?.ticketId ?? ''}:${
        ticketsScope.kind === 'project'
          ? `${ticketsScope.codebaseId}/${ticketsScope.name}`
          : ticketsScope.kind === 'view'
          ? ticketsScope.viewId
          : ''
      }`
    : page === 'projects' || page === 'views'
    ? page
    : accountPage !== null
    ? accountPage
    : pickedLambda !== undefined && lambdaShown === pickedLambda
    ? `work:${pickedLambda.key}`
    : view === null
    ? 'auto'
    : `lambda:${view}`;

  // Keep the address bar on what's on screen: a new place (a page, Auto, a
  // Lambda) or a step they took is a new entry; Auto moving along the queue
  // replaces the one they're on, so Back never lands on something done.
  useEffect(() => {
    if (urlNow === null) {
      return;
    }

    const here = window.location.pathname + window.location.search;
    const push =
      !fromHistory.current &&
      lastStop.current !== null &&
      (lastStop.current !== stopNow || pushNext.current);
    fromHistory.current = false;
    pushNext.current = false;
    lastStop.current = stopNow;

    if (urlNow === here) {
      return;
    }

    if (push) {
      window.history.pushState(null, '', urlNow);

      return;
    }

    window.history.replaceState(null, '', urlNow);
  }, [urlNow, stopNow]);

  useLayoutEffect(() => {
    const held = anchor.current;
    const box = scrollRef.current;
    anchor.current = null;

    if (held === null || box === null) {
      return;
    }

    const element = box.querySelector<HTMLElement>(
      `[data-card="${CSS.escape(held.card)}"]`
    );

    if (element !== null) {
      box.scrollTop +=
        element.getBoundingClientRect().top -
        box.getBoundingClientRect().top -
        held.top;
    }
  }, [viewingVersion]);

  // What this item reads aloud — built exactly as the server pre-renders it.
  const podLabel = podSummary === null ? 'A pod' : podName(podSummary.pod);
  const detailMatches = detail !== null && detail.pod.id === current?.podId;
  const sections = useMemo(
    () =>
      current === null
        ? null
        : itemSections({
            kind: current.kind,
            question,
            thread: detailMatches ? detail.thread : [],
            podLabel,
            decisions: detailMatches ? detail.autonomous : [],
            questions: state?.questions[current.podId] ?? [],
            humanDecisions: detailMatches ? detail.human : [],
            stalledReason: current.reason,
            structureProposal: state?.pods.find(
              (summary) => summary.pod.id === current.podId
            )?.pod.structureProposal,
            pod: state?.pods.find((summary) => summary.pod.id === current.podId)
              ?.pod,
            podNumber:
              state === null
                ? undefined
                : podNumber(state.pods, state.priority, current.podId),
          }),
    [current, question, detail, detailMatches, podLabel, state]
  );

  const player = usePlayer({
    itemKey: currentKey,
    podId: current?.podId ?? null,
    sections,
    audio: current?.audio,
    title: sections?.[0]?.text.slice(0, 120) ?? 'Lambda',
    artist: podLabel,
  });

  // ── the page's log (uiLog): what was on screen, and why it changed ──────
  useEffect(() => {
    uiLog('current', {
      key: currentKey,
      view,
      pinned: pinned === null ? null : keyOf(pinned),
      opened: openedEntry === null ? null : keyOf(openedEntry),
      held,
      queueHead: queue[0] === undefined ? null : keyOf(queue[0]),
      queueLength: queue.length,
    });
    // Only when the item itself changes — the rest is its context.
  }, [currentKey]);

  const loggedInbox = useRef<string[] | null>(null);
  useEffect(() => {
    if (state === null) {
      return;
    }

    const keys = state.inbox.map(keyOf);
    const before = loggedInbox.current;
    loggedInbox.current = keys;

    if (before === null) {
      uiLog('inbox', { keys });

      return;
    }

    const added = keys.filter((key) => !before.includes(key));
    const removed = before.filter((key) => !keys.includes(key));

    if (added.length > 0 || removed.length > 0) {
      uiLog('inbox', { added, removed, count: keys.length });
    }
  }, [state]);

  useEffect(() => {
    uiLog(player.playing ? 'audio-play' : 'audio-stop', { key: currentKey });
  }, [player.playing]);

  const sendToChat = (
    about: string | null,
    text: string,
    podId: string | null = detailPodId,
    hold = false
  ): void => {
    if (podId === null) {
      return;
    }

    const id = `${Date.now()}`;
    setChatPending((previous) => [
      ...previous.filter(
        (sent) => sent.failed === true || Date.now() - sent.at < 10 * 60_000
      ),
      { id, podId, about, text, at: Date.now(), ...(hold ? { hold } : {}) },
    ]);
    // Straight to the dev (lambda pod chat), as Claude Code talks to its agent.
    // A failed send (e.g. the app restarting) keeps the text, marked "not
    // sent" with a Retry — never a "sending…" that waits forever.
    api
      .chat(podId, text, about)
      .catch(() =>
        setChatPending((previous) =>
          previous.map((sent) =>
            sent.id === id ? { ...sent, failed: true } : sent
          )
        )
      );
  };

  const retryChat = (sent: PendingChat): void => {
    setChatPending((previous) =>
      previous.filter((candidate) => candidate.id !== sent.id)
    );
    // To the pod it was first sent to, whichever pod is open now.
    sendToChat(sent.about, sent.text, sent.podId, sent.hold === true);
  };

  // Chat replies are read aloud (Autoplay on) as they land.
  const chatSpoken = useRef<Set<string> | null>(null);

  useEffect(() => {
    const replies = (detail?.thread ?? []).filter(
      (message) => message.chat === true && message.from === 'fork'
    );

    // The first time: everything already there counts as heard.
    if (chatSpoken.current === null) {
      chatSpoken.current = new Set(replies.map((message) => message.id));

      return;
    }

    const heard = chatSpoken.current;
    const fresh = replies.filter((message) => !heard.has(message.id));
    fresh.forEach((message) => heard.add(message.id));

    if (player.autoplay) {
      fresh.forEach((message) => player.sayReply(message.podId, message.id));
    }
  }, [detail, player]);

  // Speak the fork's replies as they land.
  const spoken = useRef<Set<string>>(new Set());
  const conversationMessages = useMemo(
    () =>
      (detail?.thread ?? []).filter(
        (message) =>
          current !== null &&
          current.qid !== undefined &&
          message.podId === current.podId &&
          message.qid === current.qid &&
          message.mode === 'sync' &&
          (message.from === 'human' || message.from === 'fork')
      ),
    [detail, current]
  );

  useEffect(() => {
    const fresh = conversationMessages.filter(
      (message) => message.from === 'fork' && !spoken.current.has(message.id)
    );
    fresh.forEach((message) => spoken.current.add(message.id));

    if (inConversation) {
      fresh.forEach((message) => player.sayReply(message.podId, message.id));
    }
  }, [conversationMessages, inConversation, player]);

  // Chat-like views (a "Your turn" item, a pod's thread) sit at the newest
  // message, right above the composer; a question opens at its summary.
  const scrollRef = useRef<HTMLDivElement>(null);
  const chatLike =
    current?.kind === 'reply' || (view !== null && current === null);
  const threadLength = detail?.thread.length ?? 0;

  // A new item opens where they left it (planPlace.ts), or at its top.
  const placeKey = useRef<string | null>(null);
  placeKey.current = chatLike ? null : currentKey;
  /** Hand scrolls (wheel/touch) — the audio's follow-along and restoring both yield. */
  const scrolledByHandAt = useRef(0);
  /** While a place is being restored, the scrolls it causes aren't saved. */
  const restoringUntil = useRef(0);
  /** Where they are in the item now, as a card and a distance into it. */
  const liveAnchor = useRef<ScrollAnchor | undefined>(undefined);
  const shellReady = state !== null && loadingShown;

  // Once the app is up, the loading screen fades (styles.css) and goes.
  useEffect(() => {
    if (!shellReady) {
      return undefined;
    }

    const id = window.setTimeout(() => setLoadingGone(true), LOADING_FADE_MS);

    return () => window.clearTimeout(id);
  }, [shellReady]);

  useEffect(() => {
    const element = scrollRef.current;

    if (element === null || chatLike) {
      return undefined;
    }

    const saved = currentKey === null ? undefined : loadPlace(currentKey);
    const top = saved?.scrollTop ?? 0;
    liveAnchor.current = saved?.anchor;
    // The card can still be laying out (its versions, times, images): keep
    // putting them back on their card until it has held still a few frames, or
    // they scroll themselves. Pixels only when there's no card to go by.
    const startedAt = Date.now();
    restoringUntil.current = startedAt + RESTORE_MS;
    const frame = { id: 0 };
    const still = { frames: 0, at: -1 };
    const place = (): void => {
      const late = Date.now() - startedAt > RESTORE_MS;
      const found =
        saved?.anchor !== undefined && scrollToAnchor(element, saved.anchor);

      if (!found && (saved?.anchor === undefined || late)) {
        element.scrollTop = top;
      }

      still.frames = element.scrollTop === still.at ? still.frames + 1 : 0;
      still.at = element.scrollTop;

      if (still.frames >= 3 || scrolledByHandAt.current > startedAt || late) {
        restoringUntil.current = 0;

        return;
      }

      frame.id = requestAnimationFrame(place);
    };
    place();

    return () => {
      cancelAnimationFrame(frame.id);
      restoringUntil.current = 0;

      // Leaving it (Next item, Auto…): keep where they were now, even if they
      // scrolled a moment ago and the delayed save hasn't run.
      if (
        currentKey !== null &&
        !chatLike &&
        liveAnchor.current !== undefined
      ) {
        savePlace(currentKey, { anchor: liveAnchor.current });
      }
    };
    // `rail`: the Plan rail opening again comes back to the same place.
  }, [currentKey, chatLike, view, rails.rail, shellReady]);

  // A new version of the card on screen (or anything else that reflows it)
  // keeps them on the same card, the same distance in, before it's painted.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const anchor = liveAnchor.current;

    if (element === null || chatLike || anchor === undefined) {
      return;
    }

    if (Date.now() >= restoringUntil.current) {
      scrollToAnchor(element, anchor);
    }
  }, [shownCard, chatLike]);

  // Anything that changes the plan's height while they're reading — a version
  // arriving, version marks or times filling in, an image loading — keeps them
  // on their card. (Not while they're scrolling themselves.)
  useEffect(() => {
    const element = scrollRef.current;

    if (element === null) {
      return undefined;
    }

    const hold = new ResizeObserver(() => {
      const anchor = liveAnchor.current;

      if (
        placeKey.current === null ||
        anchor === undefined ||
        Date.now() - scrolledByHandAt.current < 400
      ) {
        return;
      }

      scrollToAnchor(element, anchor);
    });
    const watchAll = (): void => {
      hold.disconnect();
      [...element.children].forEach((child) => hold.observe(child));
    };
    watchAll();
    const added = new MutationObserver(watchAll);
    added.observe(element, { childList: true });

    return () => {
      hold.disconnect();
      added.disconnect();
    };
  }, [shellReady]);

  // A chat-like view follows its newest message. (A question card must NOT
  // jump to the top on every thread change — that yanks the owner mid-listen.)
  useEffect(() => {
    const element = scrollRef.current;

    if (element !== null && chatLike) {
      element.scrollTop = element.scrollHeight;
    }
  }, [currentKey, chatLike, threadLength, view]);

  // Follow the audio: each new section scrolls up to near the top — unless
  // The owner scrolled by hand in the last few seconds (don't fight them).

  useEffect(() => {
    const element = scrollRef.current;

    if (element === null) {
      return undefined;
    }

    const mark = (): void => {
      scrolledByHandAt.current = Date.now();
    };
    const saving = { timer: 0 };
    const track = (): void => {
      nearBottom.current =
        element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      const key = placeKey.current;

      if (key === null || Date.now() < restoringUntil.current) {
        return;
      }

      liveAnchor.current = anchorAt(element);
      window.clearTimeout(saving.timer);
      saving.timer = window.setTimeout(() => {
        if (placeKey.current === key && Date.now() >= restoringUntil.current) {
          savePlace(key, {
            scrollTop: element.scrollTop,
            anchor: anchorAt(element),
          });
        }
      }, 300);
    };
    element.addEventListener('wheel', mark, { passive: true });
    element.addEventListener('touchmove', mark, { passive: true });
    element.addEventListener('scroll', track, { passive: true });

    return () => {
      element.removeEventListener('wheel', mark);
      element.removeEventListener('touchmove', mark);
      element.removeEventListener('scroll', track);
      window.clearTimeout(saving.timer);
    };
  }, [shellReady]);

  // Live conversation: stay pinned to the newest message while the owner is at
  // the bottom (a reply, or the thinking dots, arriving). Scrolled up to
  // reread? Leave them there. Starting a conversation takes them down.
  const nearBottom = useRef(true);
  const liveChatLength =
    inConversation && question !== null && detailMatches
      ? itemChat(detail.thread, question.id).length
      : 0;

  useEffect(() => {
    const element = scrollRef.current;

    if (element !== null && inConversation) {
      element.scrollTop = element.scrollHeight;
      nearBottom.current = true;
    }
  }, [inConversation]);

  useEffect(() => {
    const element = scrollRef.current;

    if (element !== null && inConversation && nearBottom.current) {
      element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
    }
  }, [liveChatLength, inConversation]);

  // Active planning time: credited to what's on screen; listening to audio or
  // waiting on a live reply counts as active even without input.
  const awaitingLiveReply =
    inConversation &&
    question !== null &&
    detailMatches &&
    itemChat(detail.thread, question.id).at(-1)?.from === 'human';
  /**
   * The card inside the item that has their attention, asked each second by the
   * timer: the one being read aloud, or else the one taking up the most of the
   * Plan rail. None when the rail isn't showing the item, or no card is in view.
   */
  const cardAt = (): string | undefined => {
    const box = scrollRef.current;

    if (versionOnScreen === undefined || box === null) {
      return undefined;
    }

    const reading =
      player.playing && player.activeKey !== null
        ? box
            .querySelector(`[data-section="${CSS.escape(player.activeKey)}"]`)
            ?.closest<HTMLElement>('[data-card]')?.dataset.card
        : undefined;

    if (reading !== undefined) {
      return reading;
    }

    const view = box.getBoundingClientRect();
    const [best] = [...box.querySelectorAll<HTMLElement>('[data-card]')]
      .map((card) => {
        const rect = card.getBoundingClientRect();

        return {
          key: card.dataset.card,
          visible:
            Math.max(
              0,
              Math.min(rect.bottom, view.bottom) - Math.max(rect.top, view.top)
            ) *
            Math.max(
              0,
              Math.min(rect.right, view.right) - Math.max(rect.left, view.left)
            ),
        };
      })
      .filter((card) => card.visible > 0)
      .sort((a, b) => b.visible - a.visible);

    return best?.key;
  };
  const time = useActiveTime({
    cardAt,
    scope:
      current !== null
        ? {
            podId: current.podId,
            qid: current.qid,
            version: current.qid === cardQid ? versionOnScreen : undefined,
          }
        : view !== null
        ? { podId: view }
        : {},
    busy: player.playing || awaitingLiveReply,
    summary: state?.time,
    // Looking at your own stats isn't planning, and neither is an empty inbox
    // (a pod's own page still counts — you can talk to its dev there).
    paused:
      showTime || listPage || (!creating && view === null && current === null),
  });

  /** Scroll the Plan rail so this section of the card is at the top. */
  const scrollToSection = (key: string): void => {
    const element = scrollRef.current;
    const target = element?.querySelector(
      `[data-section="${CSS.escape(key)}"]`
    );

    if (element === null || !(target instanceof HTMLElement)) {
      return;
    }

    const offset =
      target.getBoundingClientRect().top - element.getBoundingClientRect().top;
    element.scrollTo({
      top: element.scrollTop + offset - 16,
      behavior: 'smooth',
    });
  };

  // A section step they asked for (A/D, ⇧←/⇧→, ⏮/⏭) always brings the
  // section's top to the top of the rail, even right after a hand scroll.
  const steppedAt = useRef(0);
  const [steps, setSteps] = useState(0);
  const stepSection = (): void => {
    steppedAt.current = Date.now();
    setSteps((count) => count + 1);
  };

  useEffect(() => {
    const key = player.activeKey;
    const asked = Date.now() - steppedAt.current < 1_500;

    if (
      key === null ||
      (!player.playing && !asked) ||
      (!asked && Date.now() - scrolledByHandAt.current < 4_000)
    ) {
      return;
    }

    scrollToSection(key);
    // Keyed on the section (and steps they ask for) only: progress ticks
    // within a section must not re-scroll.
  }, [player.activeKey, steps]);

  // An item coming up opens the Plan rail — unless they're watching the agents
  // or working the player; then the Plan icon gets a dot instead.
  const { rail, setRail, showPod, openIfShut } = rails;
  const podOnScreen = current?.podId ?? view;
  const podOnScreenRecord = state?.pods.find(
    (summary) => summary.pod.id === podOnScreen
  )?.pod;
  const freeform = podOnScreenRecord?.mode === 'freeform';
  // A building pod on its own page (picked in the sidebar), not one whose
  // item is up in the inbox or Auto: that one is in the planning screen.
  const buildingPageShown =
    !otherPage &&
    view !== null &&
    podOnScreen === view &&
    podOnScreenRecord !== undefined &&
    buildingScreenMode(podOnScreenRecord) !== null;
  const firstRail = firstRailOf(podOnScreenRecord, buildingPageShown);
  const podOnScreenKind = podOnScreenRecord?.kind;
  // A Lambda just started isn't in the state yet: wait to learn its mode.
  const podKnown =
    podOnScreen === null ||
    state?.pods.some((summary) => summary.pod.id === podOnScreen) === true;

  // Each Lambda keeps its own rail: a structured one opens on Plan the first
  // time, a freeform chat starts shut. Before the effects below, so an item
  // coming up opens the rail of the Lambda it belongs to. A building pod has
  // other rails on its own page than in the planning screen.
  useLayoutEffect(() => {
    if (podKnown) {
      showPod(
        podOnScreen,
        firstRail,
        buildingPageShown ? BUILDING_RAILS : planningRailsOf(podOnScreenKind)
      );
    }
  }, [podOnScreen, firstRail, podKnown, buildingPageShown, podOnScreenKind]);

  // A proposal to start structured planning opens the Plan rail: the pitch
  // and its Start planning button live there.
  const structureUp = current?.kind === 'structure';

  useEffect(() => {
    if (structureUp && rail !== 'plan') {
      setRail('plan');
    }
    // Keyed on the item coming up only: closing the rail after is their call.
  }, [structureUp, currentKey]);

  // A freeform chat has no plan to show — each reply is a new item, so
  // opening it there would pop the rail every turn.
  useEffect(() => {
    if (currentKey !== null && !freeform) {
      openIfShut('plan');
    }
    // Only when the item itself changes — closing the rail stays closed.
  }, [currentKey]);

  // ── actions ─────────────────────────────────────────────────────────────
  const advance = useCallback(() => {
    if (currentKey !== null) {
      setHidden((previous) => new Set([...previous, currentKey]));
      // Sent: its draft is done with.
      saveDraft(currentKey, '');
    }

    setPinned(null);
    setTrail([]);
    setDraft('');
    player.stop();

    // Following the queue (Auto): let go of this pod's chat, so all caught
    // up shows when nothing else is waiting. (A picked pod keeps its page.)
    if (view === null) {
      setLastPod(null);
    }
  }, [currentKey, player, view]);

  /** Where the item on screen sits in the queue (Auto mode's "2 of 3"). */
  const queueIndex =
    currentKey === null
      ? -1
      : queue.findIndex((entry) => keyOf(entry) === currentKey);

  /** Bring a waiting item up (‹ ›, "Go to it"): the queue itself is unchanged. */
  const goTo = useCallback(
    (entry: InboxEntry | undefined) => {
      if (entry === undefined || inConversation) {
        return;
      }

      setPinned(null);
      setTrail([]);
      setHeld(keyOf(entry));
      setDraft('');
      player.stop();
    },
    [inConversation, player]
  );

  /** ‹ › (P / N): step through the waiting items in priority order. */
  const browse = useCallback(
    (step: 1 | -1) => goTo(queue[queueIndex + step]),
    [goTo, queue, queueIndex]
  );

  // The hotkey handler is installed once; it reads the latest from here.
  const browseRef = useRef(browse);
  browseRef.current = browse;

  /** Follow a link to another item of the same pod (open or closed). */
  const openItem = useCallback(
    (podId: string, qid: string) => {
      pushNext.current = true;
      setTrail((previous) => [...previous, { podId, qid }]);
      setDraft('');
      player.stop();
    },
    [player]
  );

  const back = (): void => {
    setTrail((previous) => previous.slice(0, -1));
    setDraft('');
    player.stop();
  };

  const onDraftChange = (value: string): void => {
    setDraft(value);
    saveDraft(currentKey, value);
  };

  /** "Done — carry on": stop the back-and-forth; the pod proceeds on its own. */
  const carryOn = (): void => {
    if (current?.kind !== 'reply') {
      return;
    }

    api.carryOn(current.podId).catch(fail);
    advance();
  };

  const nudge = (): void => {
    if (current?.kind !== 'stalled') {
      return;
    }

    api.nudge(current.podId).catch(fail);
    advance();
  };

  const acceptRec = (): void => {
    if (
      question === null ||
      question.recommendation === undefined ||
      inConversation
    ) {
      return;
    }

    api.acceptRec(question.podId, question.id).catch(fail);
    advance();
  };

  /** They've said something to this pod since the item came up. */
  const discussed =
    question !== null &&
    detailMatches &&
    detail.thread.some(
      (message) =>
        message.from === 'human' &&
        message.text.trim() !== '' &&
        message.createdAt > question.createdAt
    );

  /** The option Done goes with: the one they clicked, else the recommendation. */
  const pickedOption =
    question === null || question.options.length === 0
      ? undefined
      : pick !== null && pick.key === currentKey
      ? pick.optionId
      : question.recommendation?.optionId;

  /** Send words to the dev as their last word on an item, kept for "Put it back". */
  const lastWord = (podId: string, text: string): Promise<unknown> => {
    if (text === '') {
      return Promise.resolve();
    }

    recordSent(podId, currentKey, text);

    return api.chat(podId, text);
  };

  /**
   * ⌘⏎, or the Plan rail's Done: finished with the item that's up. What's
   * typed goes along as the last word. A question is answered with what was
   * said (nothing said: the recommendation); a checkpoint is approved; "Your
   * turn" carries on; a stalled pod is nudged. With nothing up, it just sends.
   */
  const done = (typed: string): void => {
    const text = typed.trim();

    // An earlier version is for reading: Done takes them back to the current
    // one rather than approving something they aren't looking at (anything they
    // typed still goes to the chat).
    if (oldCard !== null) {
      setViewingVersion(null);

      if (text !== '') {
        sendToChat(oldCard.id, text);
      }

      return;
    }

    if (current === null || otherPage) {
      if (text !== '') {
        sendToChat(null, text);
      }

      return;
    }

    if (current.kind === 'stalled') {
      lastWord(current.podId, text).catch(fail);
      nudge();

      return;
    }

    // Start structured planning, as the dev proposed (with their last word).
    if (current.kind === 'structure') {
      const { podId } = current;
      (text === '' ? Promise.resolve() : lastWord(podId, text))
        .then(() => api.structure(podId))
        .catch(fail);
      advance();

      return;
    }

    if (current.kind === 'reply') {
      if (text === '') {
        carryOn();

        return;
      }

      lastWord(current.podId, text).catch(fail);
      advance();

      return;
    }

    if (question === null || question.status !== 'open') {
      if (text !== '') {
        sendToChat(null, text);
      }

      return;
    }

    const { checkpoint } = question;

    if (question.kind === 'checkpoint' && checkpoint !== undefined) {
      const { podId } = question;
      lastWord(podId, text)
        .then(() => api.checkpointComplete(podId, checkpoint.cp))
        .catch(fail);
      advance();

      return;
    }

    // An item with options: go with the one picked (the rec by default).
    if (pickedOption !== undefined) {
      if (text === '' && pickedOption === question.recommendation?.optionId) {
        acceptRec();

        return;
      }

      recordSent(question.podId, currentKey, text);
      api
        .answer(
          question.podId,
          question.id,
          [`Go with ${pickedOption}.`, text]
            .filter((part) => part !== '')
            .join('\n\n')
        )
        .catch(fail);
      advance();

      return;
    }

    if (text === '' && !discussed) {
      return;
    }

    recordSent(question.podId, currentKey, text);
    api
      .answer(
        question.podId,
        question.id,
        text === '' ? 'Done — go with what we just discussed.' : text
      )
      .catch(fail);
    advance();
  };

  /**
   * "Back when done" is offered while the dev owes them something on this
   * item: they've said something since it came up, and the dev is mid-turn.
   */
  const itemWait =
    current !== null &&
    openedEntry === null &&
    // A question: once they've written on it. Start planning and Your turn
    // have no question behind them, so the dev's turn alone is enough.
    (question === null || (question.status === 'open' && discussed)) &&
    // Mid-turn: the server's turn state, else (an older server) their last
    // message still unanswered. Never the pod's status — a pod with an item
    // waiting reads "Needs you" even while its dev works.
    (podSummary?.devBusy === true ||
      (detailMatches && owesReply(detail.thread)));
  /**
   * A chat on screen with no item behind it (their reply answered the item —
   * every freeform turn): its dev is working on what they said, so they can step
   * away from the chat itself.
   */
  const chatWait =
    current === null &&
    detailPodId !== null &&
    (state?.pods.find((summary) => summary.pod.id === detailPodId)?.devBusy ===
      true ||
      (detail !== null &&
        detail.pod.id === detailPodId &&
        owesReply(detail.thread)));
  const canWait = itemWait || chatWait;

  /** Something else is waiting, for "Next item" to go to. */
  const othersWaiting = stops.some((entry) => keyOf(entry) !== currentKey);

  /** Set the item aside until the dev's turn ends; the queue moves on. */
  const later = (): void => {
    // The item they're on, else the chat they're in (no item: keyed on the pod).
    const podId = current?.podId ?? detailPodId;
    const key = currentKey ?? (podId === null ? null : `${podId}/chat`);

    if (!canWait || podId === null || key === null) {
      return;
    }

    setAside((previous) => [
      ...previous.filter((item) => item.key !== key),
      { key, podId, at: Date.now() },
    ]);
    setReturned((previous) =>
      previous.filter((candidate) => candidate !== key)
    );
    setPinned(null);
    setTrail([]);
    setHeld(null);
    setDraft('');
    player.stop();
    // Done with this one for now: follow the queue to whatever's next, and
    // let go of its chat so all-caught-up is what shows if nothing is.
    setView(null, 'later');
    setLastPod(null);
  };

  const laterRef = useRef(later);
  laterRef.current = later;
  const toggleSidebarRef = useRef(() => toggleSidebar(!sidebarCollapsed));
  toggleSidebarRef.current = () => toggleSidebar(!sidebarCollapsed);
  const toggleRailRef = useRef(rails.toggleRail);
  toggleRailRef.current = rails.toggleRail;
  const toggleExpandedRef = useRef(rails.toggleExpanded);
  toggleExpandedRef.current = rails.toggleExpanded;

  const sendChat = (): void => {
    const text = chatDraft.trim();

    if (detailPodId === null || text === '') {
      return;
    }

    recordSent(detailPodId, null, text);
    api.chat(detailPodId, text).catch(fail);
    setChatDraft('');
  };

  /**
   * Sent from this browser but never saved in the pod's thread (checked once
   * it's had ARRIVAL_GRACE_MS to get there), for the current pod's page/item.
   */
  const lostHere = useMemo(() => {
    const podId = current?.podId ?? view;

    if (podId === null || detail === null || detail.pod.id !== podId) {
      return [];
    }

    const arrived = detail.thread.filter((message) => message.from === 'human');

    return sentLog.filter(
      (message) =>
        message.podId === podId &&
        message.dismissed !== true &&
        Date.now() - message.at > ARRIVAL_GRACE_MS &&
        !arrived.some(
          (entry) =>
            entry.text.trim() === message.text &&
            Date.parse(entry.createdAt) >= message.at - 60_000
        )
    );
  }, [sentLog, detail, current, view]);

  /** Put a lost message back where it was typed, so it can be sent again. */
  const restoreSent = (message: SentMessage): void => {
    // Same item: back in its box. The pod's own page: its chat box.
    // Anywhere else: the clipboard — never into the wrong item's box.
    if (message.itemKey !== null && message.itemKey === currentKey) {
      setDraft(message.text);
      saveDraft(currentKey, message.text);
    } else if (message.itemKey === null && current === null && view !== null) {
      setChatDraft(message.text);
    } else {
      navigator.clipboard
        .writeText(message.text)
        .then(() =>
          setError('Copied the lost message — paste it on the item it was for.')
        )
        .catch(() => setError(`Lost message: ${message.text}`));
    }

    dismissSent(message.id);
  };

  // Esc in a text field leaves it (after the field's own Esc, e.g. Search
  // clearing itself), so the single-key shortcuts work again.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const field = document.activeElement;

      if (
        event.key === 'Escape' &&
        field instanceof HTMLElement &&
        (field instanceof HTMLInputElement ||
          field instanceof HTMLTextAreaElement ||
          field.isContentEditable)
      ) {
        field.blur();
      }
    };
    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Playback shortcuts — only when not typing, and not while a prototype or
  // picture is open over the inbox (it has its own keys).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (
        isTypingTarget(event.target) ||
        document.body.classList.contains('viewer-open')
      ) {
        return;
      }

      if (event.key === ' ') {
        event.preventDefault();

        // A focused button (▶, a 🔊…) would also "click" on Space.
        if (event.target instanceof HTMLElement) {
          event.target.blur();
        }

        player.toggle();

        return;
      }

      // ←/→ ±5 s; ⇧←/⇧→ previous / next section.
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        const forward = event.key === 'ArrowRight';

        // Shift: jump a whole section; plain: 5 seconds.
        if (event.shiftKey) {
          stepSection();

          if (forward) {
            player.next();

            return;
          }

          player.previous();

          return;
        }

        player.skip(forward ? 5 : -5);

        return;
      }

      // WASD (no modifiers — ⌘S etc. stay the browser's): W/S speed,
      // A/D previous / next section.
      const letter =
        event.metaKey || event.ctrlKey || event.altKey
          ? ''
          : event.key.toLowerCase();

      if (letter === 'w' || letter === 's') {
        event.preventDefault();
        player.setRate(player.rate + (letter === 'w' ? 0.25 : -0.25));

        return;
      }

      // N / P: the next / previous waiting item (the queue doesn't change).
      if (letter === 'n' || letter === 'p') {
        event.preventDefault();
        browseRef.current(letter === 'n' ? 1 : -1);

        return;
      }

      // L: "Back when done", when it's offered.
      if (letter === 'l') {
        event.preventDefault();
        laterRef.current();

        return;
      }

      if (letter === 'a' || letter === 'd') {
        event.preventDefault();

        stepSection();

        if (letter === 'd') {
          player.next();

          return;
        }

        player.previous();

        return;
      }

      // ↑/↓: speed up / slow down by 0.25×.
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        player.setRate(player.rate + (event.key === 'ArrowUp' ? 0.25 : -0.25));

        return;
      }

      // M: maximize the right rail, or shrink it back.
      if (letter === 'm') {
        event.preventDefault();
        toggleExpandedRef.current();

        return;
      }

      // [ / ]: hide or bring back the sidebar / the right rail.
      if (letter === '[') {
        event.preventDefault();
        toggleSidebarRef.current();

        return;
      }

      if (letter === ']') {
        event.preventDefault();
        toggleRailRef.current();
      }
    };
    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [player]);

  // ── render ──────────────────────────────────────────────────────────────
  // The loading screen sits over the app and fades out once it's ready; it
  // is the same element (first child) before and after, so its λ doesn't
  // restart mid-breath.
  const loadingScreen = loadingGone ? null : (
    <div
      className={`loading${shellReady ? ' loading--out' : ''}`}
      role="status"
      aria-label="Loading"
    >
      <svg
        className="loading__lambda"
        viewBox="0 0 32 32"
        width="64"
        height="64"
        aria-hidden="true"
      >
        <path d="M9 6.5c3 0 4.2 1.6 5.4 4.4L21 25.5h3" />
        <path d="M15.4 14.2L8.5 25.5" />
      </svg>
    </div>
  );

  if (state === null || !loadingShown) {
    return <>{loadingScreen}</>;
  }

  const forkTabs = (detail?.windows ?? []).filter((window) =>
    window.startsWith('fork-')
  );
  const tabs = ['dev', 'manager', ...forkTabs];
  const activeTab = tabs.includes(rightTab) ? rightTab : 'dev';
  const viewPod =
    view === null
      ? null
      : state.pods.find((summary) => summary.pod.id === view);
  /** Waiting across every pod (the Auto count while a pod is picked). */
  const waitingCount = stops.length;
  const position =
    current === null
      ? ''
      : `${Math.max(
          1,
          queue.findIndex((entry) => keyOf(entry) === currentKey) + 1
        )}/${queue.length}`;
  /**
   * The Up-next strip: what's come up since this item did — anything back
   * from "Back when done" first (it was already their turn), then arrivals.
   */
  // Not the Lambda they're on: its other items are already in front of them.
  const backReady = returned.flatMap((key) =>
    key === currentKey
      ? []
      : queue.filter(
          (entry) => keyOf(entry) === key && entry.podId !== current?.podId
        )
  );
  // A "Your turn" from the pod whose chat is on screen is already in front
  // of them (it's the dev's latest message): not news.
  const announce = freshHere.filter(
    (entry) => !(entry.kind === 'reply' && entry.podId === detailPodId)
  );
  const [firstFresh] = [...backReady, ...announce];
  const nameOfPod = (podId: string): string => {
    const found = state.pods.find((summary) => summary.pod.id === podId);

    return found === undefined ? podId : podName(found.pod);
  };
  const freshNames = [
    ...new Set(announce.map((entry) => nameOfPod(entry.podId))),
  ];
  const freshLabel = (entry: InboxEntry): string => {
    const question =
      entry.qid === undefined
        ? undefined
        : state.questions[entry.podId]?.find(
            (candidate) => candidate.id === entry.qid
          );

    if (entry.kind === 'reply') {
      return 'Your turn';
    }

    if (entry.kind === 'stalled') {
      return 'Stalled';
    }

    if (entry.kind === 'structure') {
      return 'Structured planning';
    }

    return question === undefined ? 'An item' : itemTitle(question);
  };
  const attention =
    current !== null &&
    (current.kind === 'reply' ||
      current.kind === 'stalled' ||
      current.kind === 'structure');

  const titlePodId = current?.podId ?? view ?? detailPodId;
  const titlePod =
    titlePodId === null
      ? undefined
      : state.pods.find((summary) => summary.pod.id === titlePodId);
  const centerTitle = creating
    ? ''
    : showTime
    ? 'Planning time'
    : showTickets
    ? 'Tickets'
    : page === 'projects'
    ? 'Projects'
    : page === 'views'
    ? 'Views'
    : accountPage !== null
    ? ACCOUNT_PAGE_TITLES[accountPage]
    : titlePod === undefined
    ? 'All caught up'
    : withProjectTag(podName(titlePod.pod), titlePod.pod.id, state.lambda);
  const detailLabel =
    detail !== null && detail.pod.id === detailPodId
      ? podName(detail.pod)
      : 'this Lambda';
  const answering =
    !otherPage &&
    !attention &&
    question !== null &&
    current !== null &&
    question.status === 'open';
  const replying = !otherPage && current !== null && current.kind === 'reply';
  const audioTrouble =
    player.needsGesture ||
    player.audioError !== null ||
    state.tts?.overBudget === true;
  /** What the audio needs them to know (in the Plan rail's player drawer). */
  const audioNotices =
    player.audioError !== null ||
    (player.source === 'unavailable' && current !== null) ||
    state.tts?.overBudget === true ? (
      <div className="audio-chips">
        {player.audioError !== null && (
          <button
            type="button"
            className="chip"
            title="Dismiss"
            onClick={player.dismissAudioError}
          >
            {player.audioError} ✕
          </button>
        )}
        {player.source === 'unavailable' && current !== null && (
          <span className="chip">{audioUnavailableReason(current.audio)}</span>
        )}
        {state.tts?.overBudget === true && (
          <span className="chip">
            Out of ElevenLabs audio (about ${state.tts.usd.toFixed(2)} used this
            month) — no audio until your credits renew
          </span>
        )}
      </div>
    ) : null;

  /** The chat's box while an item is up: typed text answers it. */
  const isCheckpoint =
    answering && question !== null && question.kind === 'checkpoint';
  const loneSplit =
    isCheckpoint &&
    question?.checkpoint !== undefined &&
    offersKeepOne(question.checkpoint.cp, pod ?? undefined);
  /** What ⌘⏎ (and the Plan rail's Done) does right now. */
  const doneLabel =
    otherPage || current === null
      ? null
      : current.kind === 'stalled'
      ? 'Nudge'
      : current.kind === 'structure'
      ? 'Start planning'
      : replying
      ? 'Done — carry on'
      : !answering || question === null
      ? null
      : isCheckpoint && question.checkpoint !== undefined
      ? loneSplit
        ? 'Accept the split'
        : `Approve checkpoint ${question.checkpoint.cp}`
      : pickedOption !== undefined
      ? `Go with ${pickedOption}`
      : 'Done';
  const detailSummary = state.pods.find(
    (summary) => summary.pod.id === detailPodId
  );
  const devBusy = detailSummary !== undefined && isWorking(detailSummary);
  const chatContext = devBusy ? (
    <>Lambda is working — it&apos;ll read this when its turn ends.</>
  ) : undefined;

  /** The text in the chat box: the item's draft, or the pod's. */
  const boxDraft = current === null ? podDraft : draft;
  const setBoxDraft = current === null ? setPodDraft : onDraftChange;

  /**
   * The Plan rail's footer: Done (the same as ⌘⏎, with what's in the box),
   * plus the other ways to finish — Go with the rec once they've talked it
   * through, and Keep it one ticket on a lone ticket's split proposal.
   */
  const planActions =
    doneLabel === null ? null : (
      <>
        {loneSplit && question?.checkpoint !== undefined && (
          <button
            type="button"
            className="ghost"
            onClick={() => {
              api
                .checkpointComplete(
                  question.podId,
                  question.checkpoint?.cp ?? 3,
                  true
                )
                .catch(fail);
              advance();
            }}
          >
            Keep it one ticket
          </button>
        )}
        <button
          type="button"
          className="primary done"
          disabled={oldCard !== null}
          title={
            oldCard === null
              ? undefined
              : 'You are looking at an earlier version — go back to the current one to approve (⌘⏎)'
          }
          onClick={() => {
            done(boxDraft);
            setBoxDraft('');
          }}
        >
          <span className="done__label">{doneLabel}</span>
          <span className="kbd">⌘⏎</span>
        </button>
      </>
    );

  // The New pod and Time pages have no item: the Plan rail steps aside for
  // them (and comes back after); the other rails stay useful there.
  // So does all caught up: that page is the whole view.
  const caughtUp = !otherPage && detailPodId === null;
  const autoOn = view === null && !creating;
  const detailPodKind = state.pods.find(
    (summary) => summary.pod.id === detailPodId
  )?.pod.kind;
  // The Tickets screen is a page of its own, Linear's way: no rail beside it.
  const shownRail = listPage
    ? null
    : planningRailOf(rail, {
        offPod: otherPage || caughtUp,
        buildingPod: detailPodKind === 'building',
      });
  /** A building pod picked in the sidebar: it has its own page. */
  const buildingView =
    otherPage || view === null
      ? undefined
      : state.pods.find(
          (summary) =>
            summary.pod.id === view && buildingScreenMode(summary.pod) !== null
        );
  const sidebarWidth = sidebarNarrow ? '56px' : '288px';
  const expanded = rails.expanded && shownRail !== null;

  /** A ticket's page, on the Tickets screen. */
  const openTicketPage = (projectId: string, ticketId: string): void => {
    setOpenTicket({ projectId, ticketId });
    showPage('tickets');
  };

  /** A pod's own page (a planning chat, a computer): Auto goes off. */
  const openPod = (podId: string, why: string): void => {
    showPage(null);
    setLambdaOpen(null);
    setView(podId, why);
    setPinned(null);
    setTrail([]);
  };

  /**
   * A Lambda's row: still planning (or a plan or chat that made no
   * tickets), its planning chat; past that, its own page.
   */
  const openLambda = (lambda: Lambda): void => {
    if (
      lambda.planningPodId !== null &&
      (lambda.phase === 'planning' || lambda.phase === 'done')
    ) {
      openPod(lambda.planningPodId, 'sidebar-lambda');

      return;
    }

    const anchor = anchorOf(lambda);

    if (anchor === null) {
      return;
    }

    showPage(null);
    setView(anchor, 'sidebar-lambda');
    setLambdaOpen({ key: lambda.key, podId: anchor });
    setPinned(null);
    setTrail([]);
  };

  /** The Tickets list, scoped: all of it, a project's, or a view's. */
  const openTicketsScope = (scope: TicketsScope): void => {
    setOpenTicket(null);
    setTicketsScope(scope);
    setTicketsFilter(undefined);
    showPage('tickets');
  };

  // The sidebar's Favorites, each named and drawn as what it stars.
  const listUp = showTickets && openTicket === null;
  const favoriteRows: FavoriteRow[] = workspace.favorites.flatMap(
    (favorite): FavoriteRow[] => {
      const { id, kind, ref } = favorite;

      if (kind === 'view') {
        const saved = workspace.views?.find((one) => one.id === ref);

        return saved === undefined
          ? []
          : [
              {
                id,
                kind,
                ref,
                label: saved.name,
                emoji: iconEmoji(saved.icon),
                color: null,
                active:
                  listUp &&
                  ticketsScope.kind === 'view' &&
                  ticketsScope.viewId === ref,
              },
            ];
      }

      if (kind === 'lambda') {
        const starred = lambdas.find((one) => one.key === ref);

        return starred === undefined
          ? []
          : [
              {
                id,
                kind,
                ref,
                label: starred.title,
                emoji: null,
                color: null,
                active: lambdaShown?.key === ref,
              },
            ];
      }

      const { codebaseId, name } = splitFavoriteRef(ref);

      if (kind === 'project') {
        const tracked = workspace
          .projectsOf(codebaseId)
          .find((one) => one.name === name);

        return [
          {
            id,
            kind,
            ref,
            label: name,
            emoji: iconEmoji(tracked?.icon),
            color: tracked?.color ?? null,
            active:
              listUp &&
              ticketsScope.kind === 'project' &&
              favoriteRef(ticketsScope.codebaseId, ticketsScope.name) === ref,
          },
        ];
      }

      return [
        {
          id,
          kind,
          ref,
          label:
            favorite.label ??
            lambdas
              .flatMap((one) => one.tickets)
              .find((ticket) => ticket.id === name)?.title ??
            name,
          emoji: null,
          color: null,
          active:
            showTickets &&
            openTicket?.projectId === codebaseId &&
            openTicket.ticketId === name,
        },
      ];
    }
  );
  const openFavorite = (favorite: FavoriteRow): void => {
    player.stop();

    if (favorite.kind === 'view') {
      openTicketsScope({ kind: 'view', viewId: favorite.ref });

      return;
    }

    if (favorite.kind === 'lambda') {
      const starred = lambdas.find((one) => one.key === favorite.ref);

      if (starred !== undefined) {
        openLambda(starred);
      }

      return;
    }

    const { codebaseId, name } = splitFavoriteRef(favorite.ref);

    if (favorite.kind === 'project') {
      openTicketsScope({ kind: 'project', codebaseId, name });

      return;
    }

    openTicketPage(codebaseId, name);
  };

  const toggleAuto = (on: boolean): void => {
    showPage(null);
    setLambdaOpen(null);
    setPinned(null);
    setTrail([]);

    // On: straight to the top of the queue. Off: stay on the pod that's on
    // screen, now picked. On also lets go of the last pod's chat, so all
    // caught up shows if nothing's waiting.
    if (on) {
      setHeld(null);
      setLastPod(null);
    }

    setView(
      on
        ? null
        : current?.podId ??
            detailPodId ??
            // All caught up: back to the pod they were last on, else the top of
            // the sidebar.
            (state.pods.some(
              (summary) => summary.pod.id === lastSeenPod.current
            )
              ? lastSeenPod.current
              : orderPods(state.pods, state.priority)[0]?.pod.id ?? null),
      on ? 'auto-on' : 'auto-off'
    );
  };

  return (
    <>
      {loadingScreen}
      <div
        className={`layout${expanded ? ' layout--expanded' : ''}${
          sidebarSlide === null ? '' : ` layout--sidebar-${sidebarSlide}`
        }`}
        style={{ gridTemplateColumns: `${sidebarWidth} minmax(0, 1fr)` }}
      >
        <Sidebar
          pods={state.pods.map((summary) => {
            // The badge counts the stops they'll make, not the server's raw items.
            const counted = {
              ...summary,
              needsYou: stops.filter(
                (entry) =>
                  entry.podId === summary.pod.id && entry.kind !== 'stalled'
              ).length,
            };

            return holdingNow.has(summary.pod.id)
              ? {
                  ...counted,
                  chatHold: true,
                  status:
                    summary.status === 'needs-you' ? 'working' : summary.status,
                }
              : counted;
          })}
          priority={state.priority}
          activePodId={otherPage ? null : view ?? current?.podId ?? detailPodId}
          auto={{
            // Starting a new Lambda steps out of the queue: Auto reads off
            // there, and turning it on goes to what's waiting (or caught up).
            on: autoOn,
            index: autoOn ? queueIndex : -1,
            total: autoOn ? queue.length : waitingCount,
            onToggle: toggleAuto,
            onPrev: () => browse(-1),
            onNext: () => browse(1),
          }}
          asidePods={new Set(aside.map((item) => item.podId))}
          // Picking a pod turns Auto off.
          onSelectPod={(podId, via) => openPod(podId, `sidebar-${via}`)}
          sections={lambdaSections}
          activeLambdaKey={
            lambdaShown?.key ??
            lambdas.find(
              (one) =>
                one.planningPodId !== null &&
                one.planningPodId === (current?.podId ?? view)
            )?.key ??
            null
          }
          onSelectLambda={openLambda}
          onMoveTicket={(moving, after) => {
            if (
              moving.projectId === null ||
              moving.ticketId === null ||
              after.ticketId === null
            ) {
              return;
            }

            api
              .moveTicket(moving.projectId, moving.ticketId, after.ticketId)
              .then(() => setTick((value) => value + 1))
              .catch(fail);
          }}
          onOpenComputer={(podId) => openPod(podId, 'sidebar-computer')}
          checkpointOf={(entry) => cpOf(entry) ?? null}
          onReorder={(order) => {
            setState({ ...state, priority: order });
            api.priority(order).catch(fail);
          }}
          onNewPod={() => {
            setNewProjectId(null);
            showPage('new');
          }}
          onPauseBuilding={(podId, pause) => {
            (pause ? api.pause(podId) : api.resume(podId)).catch(fail);
          }}
          onOpenTerminal={(podId) => {
            openPod(podId, 'sidebar-click');
            rails.setRail('agents');
          }}
          onRename={(podId, title) => {
            // Optimistic: show the new name now; the server's state confirms it.
            setState({
              ...state,
              pods: state.pods.map((summary) =>
                summary.pod.id === podId
                  ? { ...summary, pod: { ...summary.pod, title } }
                  : summary
              ),
            });
            api.rename(podId, title).catch(fail);
          }}
          onDelete={(podId) => {
            // Optimistic: it leaves the sidebar now; the server's state confirms.
            if (view === podId) {
              setView(null, 'pod-deleted');
            }

            setState({
              ...state,
              pods: state.pods.filter((summary) => summary.pod.id !== podId),
            });
            api.deletePod(podId).catch(fail);
          }}
          freshPods={freshPods}
          page={page}
          collapsed={sidebarCollapsed}
          closing={sidebarSlide === 'closing'}
          onCollapse={toggleSidebar}
          onOpenTickets={() => {
            // The nav's Tickets is the whole list, never the last ticket page.
            openTicketsScope({ kind: 'all' });
          }}
          onOpenProjects={() => {
            showPage('projects');
            player.stop();
          }}
          onOpenViews={() => {
            showPage('views');
            player.stop();
          }}
          ticketsScoped={ticketsScope.kind !== 'all'}
          favorites={favoriteRows}
          onOpenFavorite={openFavorite}
          onUnfavorite={(favorite) =>
            workspace.setFavorite(favorite.kind, favorite.ref, false)
          }
          onReorderFavorites={(ids) =>
            workspace.orderFavorites([
              ...ids,
              ...workspace.favorites
                .map((one) => one.id)
                .filter((one) => !ids.includes(one)),
            ])
          }
          onOpenTime={() => {
            showPage('time');
            player.stop();
          }}
          lambda={state.lambda}
          onOpenAccountPage={(opened) => {
            showPage(opened);
            player.stop();
          }}
          onSignOut={() => {
            api
              .signOut()
              .then(() => window.location.assign('/'))
              .catch(fail);
          }}
          stopwatch={{
            ticking: time.ticking,
            today: formatDuration(time.todayMs),
          }}
        />

        {lambdaShown !== undefined ? (
          <Lazy
            fallback={<p className="muted">Loading…</p>}
            resetKey={lambdaShown.key}
          >
            <LambdaScreen
              key={lambdaShown.key}
              lambda={lambdaShown}
              state={state}
              rails={rails}
              tick={tick}
              starred={workspace.isFavorite('lambda', lambdaShown.key)}
              onStar={() =>
                workspace.setFavorite(
                  'lambda',
                  lambdaShown.key,
                  !workspace.isFavorite('lambda', lambdaShown.key)
                )
              }
              onOpenPod={(podId) => openPod(podId, 'lambda-page')}
              onOpenTicket={(projectId, ticketId) => {
                setOpenTicket({ projectId, ticketId });
                showPage('tickets');
              }}
              onPlanNew={(projectId, text) => {
                startNewDraft(text);
                setNewProjectId(projectId);
                showPage('new');
              }}
              onRename={(podId, title) => {
                setState({
                  ...state,
                  pods: state.pods.map((summary) =>
                    summary.pod.id === podId
                      ? { ...summary, pod: { ...summary.pod, title } }
                      : summary
                  ),
                });
                api.rename(podId, title).catch(fail);
              }}
              onDelete={(podId) => {
                setLambdaOpen(null);
                setView(null, 'pod-deleted');
                setState({
                  ...state,
                  pods: state.pods.filter(
                    (summary) => summary.pod.id !== podId
                  ),
                });
                api.deletePod(podId).catch(fail);
              }}
            />
          </Lazy>
        ) : buildingView !== undefined ? (
          <Lazy
            fallback={<p className="muted">Loading…</p>}
            resetKey={view ?? undefined}
          >
            <BuildingPodScreen
              // One pod's page, state and all: switching pods starts afresh
              // rather than showing the last pod's thread under this header.
              key={buildingView.pod.id}
              summary={buildingView}
              lambda={state.lambda}
              rails={rails}
              tick={tick}
              onOpenTicket={(projectId, ticketId) => {
                setOpenTicket({ projectId, ticketId });
                showPage('tickets');
              }}
            />
          </Lazy>
        ) : (
          <ViewerProvider
            podId={detailPodId}
            refreshKey={
              detail !== null && detail.pod.id === detailPodId
                ? detail.thread.length
                : 0
            }
            onAddToChat={(text) =>
              setBoxDraft(
                boxDraft.trim() === '' ? `${text}\n` : `${boxDraft}\n${text}\n`
              )
            }
          >
            {/* The chat and its rail share one white card, as in Claude Code. */}
            <div
              className="workspace"
              style={{
                gridTemplateColumns:
                  shownRail === null || expanded
                    ? 'minmax(0, 1fr)'
                    : `minmax(${MIN_CHAT}px, 1fr) ${rails.width}px`,
              }}
            >
              <main
                className={`main${listPage ? ' main--tickets' : ''}`}
                hidden={expanded}
              >
                <div className="toolbar" hidden={listPage}>
                  <h1 className="toolbar__title">
                    {centerTitle}
                    {!otherPage &&
                      detailLambda?.ticketId !== null &&
                      detailLambda?.ticketId !== undefined &&
                      detailLambda.projectId !== null && (
                        <button
                          type="button"
                          className="toolbar__ticket"
                          title="Open the ticket"
                          onClick={() => {
                            if (
                              detailLambda.projectId !== null &&
                              detailLambda.ticketId !== null
                            ) {
                              openTicketPage(
                                detailLambda.projectId,
                                detailLambda.ticketId
                              );
                            }
                          }}
                        >
                          {detailLambda.ticketId}
                        </button>
                      )}
                  </h1>
                  <div className="toolbar__right">
                    {shownRail !== 'plan' && <MiniPlayer player={player} />}
                    <RailSwitcher
                      rails={rails}
                      shown={shownRail}
                      badges={{
                        plan: current !== null || audioTrouble,
                      }}
                      ids={planningRailsOf(detailPodKind)}
                    />
                  </div>
                </div>

                {!otherPage &&
                  detailPodId !== null &&
                  detailPodKind !== 'building' && (
                    <div className="lambda-page__strip">
                      <PhaseStrip at="planning" qaOn={false} />
                    </div>
                  )}

                {error !== null && (
                  <button
                    type="button"
                    className="error"
                    onClick={() => setError(null)}
                  >
                    {error} (dismiss)
                  </button>
                )}

                {otherPage && (
                  <div className="main__scroll">
                    <Lazy
                      fallback={<p className="muted">Loading…</p>}
                      resetKey={page ?? undefined}
                    >
                      {showTickets && (
                        <TicketsPage
                          state={state}
                          tick={tick}
                          open={openTicket}
                          onOpen={setOpenTicket}
                          onPlan={(projectId, text) => {
                            startNewDraft(text);
                            setNewProjectId(projectId);
                            showPage('new');
                          }}
                          onOpenPod={(podId) => openPod(podId, 'tickets')}
                          onOpenLambda={openLambda}
                          onChatAbout={(projectId, ticket) => {
                            startNewAbout(ticket);
                            setNewProjectId(projectId);
                            showPage('new');
                          }}
                          scope={ticketsScope}
                          filter={ticketsFilter}
                          onFilter={setTicketsFilter}
                          workspace={workspace}
                          onOpenProjects={() => showPage('projects')}
                          onOpenViews={() => showPage('views')}
                          onOpenView={(viewId) =>
                            openTicketsScope({ kind: 'view', viewId })
                          }
                        />
                      )}

                      {page === 'projects' && (
                        <ProjectsPage
                          workspace={workspace}
                          onOpenProject={(codebaseId, name) =>
                            openTicketsScope({
                              kind: 'project',
                              codebaseId,
                              name,
                            })
                          }
                        />
                      )}

                      {page === 'views' && (
                        <ViewsPage
                          workspace={workspace}
                          ownerName={state.lambda?.owner.name ?? 'You'}
                          onOpenView={(viewId) =>
                            openTicketsScope({ kind: 'view', viewId })
                          }
                        />
                      )}

                      {showTime && (
                        <TimePage
                          time={state.time}
                          todayMs={time.todayMs}
                          pods={state.pods}
                          questions={state.questions}
                          onClose={() => showPage(null)}
                          onOpenItem={(podId, qid) => {
                            showPage(null);
                            openItem(podId, qid);
                          }}
                        />
                      )}

                      {accountPage === 'computers' && (
                        <ComputersPage tick={tick} />
                      )}
                      {accountPage === 'analytics' && (
                        <AnalyticsPage lambda={state.lambda} tick={tick} />
                      )}
                      {(accountPage === 'settings/devices' ||
                        accountPage === 'settings/process' ||
                        accountPage === 'settings/design-system') && (
                        <SettingsPage
                          tab={settingsTabOf(accountPage)}
                          onTab={(tab) => showPage(`settings/${tab}`)}
                          lambda={state.lambda}
                          tick={tick}
                        />
                      )}
                    </Lazy>

                    {creating && (
                      <NewPodForm
                        lambda={state.lambda}
                        startProjectId={newProjectId}
                        onProjectsChanged={() => setTick((value) => value + 1)}
                        onStarted={openCreated}
                        onCreate={async (request) => {
                          try {
                            const podId = await api.newPod(request);
                            clearNewDraft();
                            openCreated(podId);
                          } catch (caught) {
                            fail(caught);
                          }
                        }}
                      />
                    )}
                  </div>
                )}

                {!otherPage && detailPodId !== null && (
                  <Lazy fallback={null} resetKey={detailPodId ?? undefined}>
                    <ChatPanel
                      podLabel={detailLabel}
                      thread={
                        detail !== null && detail.pod.id === detailPodId
                          ? detail.thread
                          : []
                      }
                      questions={state.questions[detailPodId] ?? []}
                      pending={chatPending.filter(
                        (sent) => sent.podId === detailPodId
                      )}
                      draft={boxDraft}
                      onDraftChange={setBoxDraft}
                      onSend={(text) =>
                        sendToChat(
                          current !== null && current.podId === detailPodId
                            ? current.qid ?? null
                            : null,
                          text
                        )
                      }
                      onDone={done}
                      onRetry={retryChat}
                      context={chatContext}
                      whileWaiting={
                        canWait ? (
                          <div className="while-waiting">
                            <LambdaMark working />
                            {othersWaiting ? (
                              <p>
                                <strong>Lambda is working on this.</strong> You
                                don&apos;t need to wait. It comes back to you,
                                first in line, as soon as Lambda&apos;s done.
                              </p>
                            ) : (
                              <p>
                                <strong>Lambda is working on this.</strong>{' '}
                                Nothing else needs you right now. Step away and
                                this will chime when Lambda&apos;s done.
                              </p>
                            )}
                            <button
                              type="button"
                              className="ghost"
                              onClick={later}
                            >
                              {othersWaiting ? 'Next item →' : 'Step away'}
                              <span className="kbd">L</span>
                            </button>
                          </div>
                        ) : undefined
                      }
                      listening={player.chat}
                      onListen={(msgId, tracks) =>
                        player.playChat(detailPodId, msgId, tracks)
                      }
                    />
                  </Lazy>
                )}

                {!otherPage && detailPodId === null && (
                  <CaughtUp
                    line={caughtUpLine(lambdas)}
                    items={launchItems(
                      lambdas,
                      state.lambda,
                      state.pods,
                      Date.now()
                    )}
                    working={state.pods.some(
                      (summary) =>
                        summary.devBusy === true ||
                        // An older server doesn't say: an item set aside with
                        // "Next item" is waiting on its dev, so that pod is busy.
                        (summary.devBusy === undefined &&
                          aside.some((item) => item.podId === summary.pod.id))
                    )}
                    onNew={() => showPage('new')}
                    onPlan={(titles) => {
                      startNewDraft(
                        `Plan these Ready tickets: ${titles.join(', ')}`
                      );
                      setNewProjectId(null);
                      showPage('new');
                    }}
                    onResume={(podId) => api.resume(podId).catch(fail)}
                    onReassign={() => {
                      setOpenTicket(null);
                      showPage('tickets');
                    }}
                  />
                )}
              </main>

              {/* Plan stays mounted (hidden when another rail is up), so the item keeps
          its scroll position and the audio's follow-along keeps its anchor. */}
              <RailHost
                rails={rails}
                title="Plan"
                hidden={shownRail !== 'plan'}
              >
                <div className="rail__scroll" ref={scrollRef}>
                  <Lazy fallback={null}>
                    {/* A message sent from here that never reached the pod. */}
                    {!otherPage &&
                      lostHere.map((message) => (
                        <div
                          key={message.id}
                          className="lost-message"
                          role="alert"
                        >
                          <span>
                            ⚠ A message you sent at{' '}
                            {new Date(message.at).toLocaleTimeString([], {
                              hour: 'numeric',
                              minute: '2-digit',
                            })}{' '}
                            never arrived: “{message.text.slice(0, 120)}
                            {message.text.length > 120 ? '…' : ''}”
                          </span>
                          <button
                            type="button"
                            className="primary"
                            onClick={() => restoreSent(message)}
                          >
                            Put it back
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => dismissSent(message.id)}
                          >
                            Dismiss
                          </button>
                        </div>
                      ))}

                    {/* The Up-next strip: what's ready since this item came up. */}
                    {!otherPage && current !== null && openedEntry === null && (
                      <div className="queue-bar">
                        {firstFresh !== undefined && (
                          <div className="up-next" role="status">
                            <span className="up-next__dot" aria-hidden="true" />
                            <span className="up-next__text">
                              {backReady.includes(firstFresh)
                                ? `Ready again · ${nameOfPod(
                                    firstFresh.podId
                                  )} · ${freshLabel(firstFresh)}`
                                : announce.length === 1
                                ? `New · ${nameOfPod(
                                    firstFresh.podId
                                  )} · ${freshLabel(firstFresh)}`
                                : `${announce.length} new · ${freshNames.join(
                                    ', '
                                  )}`}
                            </span>
                            <button
                              type="button"
                              className="ghost"
                              title="Open it now — the item on screen stays in the queue"
                              onClick={() => goTo(firstFresh)}
                            >
                              Go to it
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    {!otherPage &&
                      attention &&
                      current !== null &&
                      pod !== null &&
                      (current.kind === 'structure' ? (
                        pod.structureProposal === undefined ? null : (
                          <StructureCard
                            pod={pod}
                            proposal={pod.structureProposal}
                          />
                        )
                      ) : current.kind === 'reply' ? (
                        <YourTurnCard
                          pod={pod}
                          open={(state.questions[current.podId] ?? []).filter(
                            (candidate) => candidate.status === 'open'
                          )}
                          onOpen={(qid) => openItem(current.podId, qid)}
                        />
                      ) : (
                        <StalledCard
                          pod={pod}
                          running={podSummary?.running ?? false}
                          reason={current.reason}
                          position={position}
                        />
                      ))}

                    {!otherPage &&
                    !attention &&
                    question !== null &&
                    pod !== null &&
                    current !== null ? (
                      <>
                        {opened !== null && (
                          <button
                            type="button"
                            className="link-button back"
                            onClick={back}
                          >
                            ← Back
                          </button>
                        )}
                        <QuestionCard
                          // Another version is a different card, not an edit to
                          // highlight as it arrives.
                          key={
                            oldCard === null
                              ? question.id
                              : `${question.id}/v${
                                  oldCard.checkpoint?.version ?? 1
                                }`
                          }
                          pod={pod}
                          question={shownCard ?? question}
                          readOnly={oldCard !== null}
                          notice={
                            oldCard === null ? undefined : (
                              <OldVersionNote
                                version={oldCard.checkpoint?.version ?? 1}
                                of={cardVersion}
                                onBack={() => viewVersion(null)}
                              />
                            )
                          }
                          times={time.itemTime(question.podId, question.id)}
                          versions={
                            cardQid === question.id
                              ? {
                                  timeline,
                                  viewing: shownCard?.checkpoint?.version ?? 1,
                                  onView: viewVersion,
                                }
                              : undefined
                          }
                          timeNote={
                            cardQid === question.id ? (
                              <VersionMenu
                                timeline={timeline}
                                viewing={shownCard?.checkpoint?.version ?? 1}
                                onView={(version) => viewVersion(version)}
                                itemMs={
                                  time.itemTime(question.podId, question.id)
                                    .itemMs
                                }
                                versionMs={
                                  time.itemTime(question.podId, question.id)
                                    .versionMs
                                }
                                cp={question.checkpoint?.cp}
                              />
                            ) : undefined
                          }
                          extra={player.extra}
                          onPlayExtra={player.playExtra}
                          pickedOption={pickedOption}
                          onPickOption={(optionId) =>
                            oldCard === null &&
                            currentKey !== null &&
                            question.status === 'open' &&
                            setPick({ key: currentKey, optionId })
                          }
                          onKeepJudgements={(indices) =>
                            oldCard === null &&
                            api
                              .keepJudgements(
                                question.podId,
                                question.id,
                                indices
                              )
                              .then(() => setTick((value) => value + 1))
                              .catch(fail)
                          }
                          discussed={
                            detailMatches
                              ? detail.thread.filter(
                                  (message) =>
                                    (message.qid === question.id ||
                                      message.about === question.id) &&
                                    message.text.trim() !== '' &&
                                    message.progress !== true &&
                                    (message.from === 'human' ||
                                      (message.from !== 'system' &&
                                        message.target === undefined))
                                ).length
                              : 0
                          }
                          onShowInChat={() =>
                            document
                              .querySelector(
                                `.center-chat [data-topic="${CSS.escape(
                                  question.id
                                )}"]`
                              )
                              ?.scrollIntoView({
                                block: 'start',
                                behavior: 'smooth',
                              })
                          }
                          // The rail's title carries the position.
                          position=""
                          playing={player.activeKey}
                          onPlaySection={player.seekSection}
                          thread={detailMatches ? detail.thread : []}
                          questions={state.questions[current.podId] ?? []}
                          // An earlier version lists its decisions as they were.
                          decisions={
                            oldCard?.checkpoint?.decisionSnapshot ??
                            liveDecisions
                          }
                          onOpenItem={(qid) => openItem(current.podId, qid)}
                          status={
                            opened === null
                              ? undefined
                              : itemStatus(
                                  question,
                                  state.questions[current.podId] ?? [],
                                  detailMatches ? detail.thread : []
                                )
                          }
                        />
                      </>
                    ) : null}

                    {/* A pod's own page: its whole thread, unless an item of its is up. */}
                    {!otherPage &&
                      view !== null &&
                      detail !== null &&
                      current === null && (
                        <PodIdle
                          key={detail.pod.id}
                          summary={viewPod ?? null}
                          answering={aside.some((item) => item.podId === view)}
                          onAuto={() => toggleAuto(true)}
                        />
                      )}
                  </Lazy>
                </div>

                {!otherPage && current !== null && (
                  <footer className="rail__actions">
                    <Lazy fallback={null}>
                      <PlanPlayer
                        player={player}
                        notices={audioNotices}
                        actions={planActions}
                        onSeekSection={scrollToSection}
                        onStep={stepSection}
                      />
                    </Lazy>
                  </footer>
                )}
              </RailHost>

              {shownRail === 'workflow' && (
                <RailHost rails={rails} title="Workflow">
                  <div className="rail__scroll rail__scroll--workflow">
                    <Lazy fallback={null} resetKey={detailPodId ?? undefined}>
                      <WorkflowPanel
                        podLabel={
                          detail !== null && detail.pod.id === detailPodId
                            ? podName(detail.pod)
                            : null
                        }
                        view={
                          detail !== null && detail.pod.id === detailPodId
                            ? detail.workflow
                            : null
                        }
                        onSkip={(stageId, label, writesLinear) => {
                          if (detailPodId === null) {
                            return;
                          }

                          const ok = window.confirm(
                            writesLinear
                              ? `Skip "${label}"? This stage writes to your tickets (new tickets or labels) — skipping it means that work is NOT done in them.`
                              : `Skip "${label}"? This Lambda passes it by; a skipped checkpoint counts as closed.`
                          );

                          if (ok) {
                            api
                              .skip(detailPodId, stageId)
                              .then(() => setTick((value) => value + 1))
                              .catch(fail);
                          }
                        }}
                        onStructure={() => {
                          if (detailPodId === null) {
                            return;
                          }

                          if (
                            window.confirm(
                              'Switch to the structured flow? The pipeline starts from this conversation. (There is no switching back.)'
                            )
                          ) {
                            api
                              .structure(detailPodId)
                              .then(() => setTick((value) => value + 1))
                              .catch(fail);
                          }
                        }}
                        onRenderMode={(mode) => {
                          if (detailPodId === null) {
                            return;
                          }

                          api
                            .renderMode(detailPodId, mode)
                            .then(() => setTick((value) => value + 1))
                            .catch(fail);
                        }}
                      />
                    </Lazy>
                  </div>
                </RailHost>
              )}

              {rail === 'agents' && (
                <RailHost rails={rails} title={`Agents · ${detailLabel}`} dark>
                  {detailPodId === null ? (
                    <p className="rail__empty">Nothing on screen.</p>
                  ) : (
                    <>
                      <Lazy fallback={null} resetKey={detailPodId ?? undefined}>
                        <WindowPicker
                          podId={detailPodId}
                          project={detail?.pod.projectId ?? detailLabel}
                          agents={tabs}
                          labelOf={planningWindowName}
                          fallback="dev"
                          onError={fail}
                          onChosen={setRightTab}
                        />
                      </Lazy>
                      {activeTab === 'dev' && (
                        <footer className="rail__dev-compose">
                          <ImageDrop value={chatDraft} onChange={setChatDraft}>
                            <textarea
                              rows={2}
                              value={wordsOf(chatDraft)}
                              placeholder="Message the dev directly — it interrupts its work · ⏎ send · drop images here"
                              onChange={(event) =>
                                setChatDraft(
                                  withWords(chatDraft, event.target.value)
                                )
                              }
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' && !event.shiftKey) {
                                  event.preventDefault();
                                  sendChat();
                                }
                              }}
                            />
                          </ImageDrop>
                        </footer>
                      )}
                    </>
                  )}
                </RailHost>
              )}

              {shownRail === 'tickets' && (
                <RailHost rails={rails} title="Tickets">
                  <div className="rail__scroll">
                    <LambdaTicketsRail
                      lambda={detailLambda}
                      onOpenTicket={openTicketPage}
                    />
                  </div>
                </RailHost>
              )}

              {rail === 'made' && (
                <RailHost rails={rails} title={`Made here · ${detailLabel}`}>
                  <Lazy fallback={null} resetKey={detailPodId ?? undefined}>
                    <MadeRail
                      thread={
                        detail !== null && detail.pod.id === detailPodId
                          ? detail.thread
                          : []
                      }
                    />
                  </Lazy>
                </RailHost>
              )}
            </div>
          </ViewerProvider>
        )}
      </div>
    </>
  );
};
