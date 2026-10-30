import { useEffect, useRef, useState } from 'react';

import type { TimeSummary } from '../shared/types';

/**
 * Active planning time. A second counts only while the owner is actually at it:
 * they scrolled, typed or clicked in the last IDLE_MS with the tab visible — or audio is playing, or a live conversation is waiting on
 * Claude (they're listening/reading for the reply). Merely having the page open
 * counts for nothing.
 *
 * Seconds are credited to what's on screen (an item, a pod's page, or the
 * inbox), batched, and reported to the server every FLUSH_MS (and when the
 * tab is hidden or closed), so totals survive reloads and add up across
 * devices. Until the server's totals include a second, it is added locally.
 */

const IDLE_MS = 15_000;
/** Input this soon after the tab is shown/focused is the switch, not work. */
const SWITCH_GRACE_MS = 1_000;
const MODIFIER_KEYS = new Set([
  'Shift',
  'Control',
  'Meta',
  'Alt',
  'CapsLock',
  'Fn',
  'OS',
]);
const FLUSH_MS = 15_000;

export interface TimeScope {
  podId?: string;
  qid?: string;
  /** The version of the card on screen, while the Plan rail shows it. */
  version?: number;
  /** The card inside it that has their attention (see cardHistory.ts). */
  card?: string;
}

const scopeKey = (scope: TimeScope): string =>
  JSON.stringify([scope.podId, scope.qid, scope.version, scope.card]);

type Batch = Map<string, { scope: TimeScope; ms: number }>;

interface Sent {
  batch: Batch;
  /** The server has saved it — the next state it sends includes it. */
  saved: boolean;
}

const post = (batch: Batch, beacon: boolean): Promise<void> => {
  const body = JSON.stringify({
    entries: [...batch.values()].map(({ scope, ms }) => ({ ...scope, ms })),
  });

  if (beacon && 'sendBeacon' in navigator) {
    navigator.sendBeacon(
      '/api/time',
      new Blob([body], { type: 'application/json' })
    );

    return Promise.resolve();
  }

  return fetch('/api/time', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
  }).then(() => undefined);
};

export interface ItemTimes {
  itemMs: number;
  versionMs: (version: number) => number;
  /** A card's time — on the given versions of the item, or on all of them. */
  cardMs: (card: string, versions?: number[]) => number;
}

const sumOf = (batches: Batch[]): number =>
  batches.reduce(
    (total, batch) =>
      total + [...batch.values()].reduce((sum, entry) => sum + entry.ms, 0),
    0
  );

export const useActiveTime = (args: {
  scope: TimeScope;
  /** Audio playing, or a live conversation waiting on a reply. */
  busy: boolean;
  summary: TimeSummary | undefined;
  /** Not planning right now (e.g. looking at the Time page): don't count. */
  paused?: boolean;
  /** Which card inside the item has their attention, asked each second. */
  cardAt?: () => string | undefined;
}) => {
  const lastInput = useRef(0);
  const pending = useRef<Batch>(new Map());
  const sent = useRef<Sent[]>([]);
  /**
   * Saved batches whose per-card and per-version split the server doesn't
   * keep (a server from before it did): kept here for this page's life so
   * card and version times don't fall back each time it reports in.
   */
  const unsplit = useRef<Batch[]>([]);
  const [ticking, setTicking] = useState(false);
  /** Re-render once a second while ticking (the refs above hold the counts). */
  const [, setTick] = useState(0);
  const live = useRef(args);
  live.current = args;

  // Real interaction marks the owner as active: scrolling, typing, clicking.
  // NOT pointer movement — just switching to the tab sweeps the pointer across
  // the page (and browsers fire a move on focus). Anything in the first moment
  // after the tab becomes visible is the switch itself, not work. NOR the left
  // sidebar: picking a pod or the inbox is getting somewhere, not planning.
  // And no `scroll` events: the app scrolls itself when a view opens (the chat
  // to its newest message), which fired one — wheel, touch, keys and a
  // scrollbar drag (pointerdown) are the scrolling they do.
  useEffect(() => {
    const shownAt = { at: 0 };
    const mark = (event: Event): void => {
      // Keys: modifiers alone (about to Ctrl+Tab) and Ctrl/⌘/Alt shortcuts
      // are moving around the browser, not planning. Shift+letter is typing.
      if (
        event instanceof KeyboardEvent &&
        (MODIFIER_KEYS.has(event.key) ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey)
      ) {
        return;
      }

      if (
        event.target instanceof Element &&
        event.target.closest('.sidebar') !== null
      ) {
        return;
      }

      if (Date.now() - shownAt.at > SWITCH_GRACE_MS) {
        lastInput.current = Date.now();
      }
    };
    const onShow = (): void => {
      if (document.visibilityState === 'visible') {
        shownAt.at = Date.now();
      }
    };
    const onFocus = (): void => {
      shownAt.at = Date.now();
    };
    // Left for another tab or app: stop now, not 15 s from the last input.
    const onBlur = (): void => {
      lastInput.current = 0;
    };
    const events = ['wheel', 'keydown', 'pointerdown', 'touchmove', 'input'];
    events.forEach((name) =>
      window.addEventListener(name, mark, { passive: true, capture: true })
    );
    document.addEventListener('visibilitychange', onShow);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);

    return () => {
      events.forEach((name) =>
        window.removeEventListener(name, mark, { capture: true })
      );
      document.removeEventListener('visibilitychange', onShow);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // The clock: one tick per second while active.
  useEffect(() => {
    const id = window.setInterval(() => {
      const { busy, paused, cardAt } = live.current;
      const card = cardAt?.();
      const scope =
        card === undefined
          ? live.current.scope
          : { ...live.current.scope, card };
      // Audio / a live reply count even in the background (listening is
      // planning); input counts only while this page has focus.
      const active =
        paused !== true &&
        (busy ||
          (document.visibilityState === 'visible' &&
            document.hasFocus() &&
            Date.now() - lastInput.current < IDLE_MS));
      setTicking(active);

      if (!active) {
        return;
      }

      const key = scopeKey(scope);
      const entry = pending.current.get(key);
      pending.current.set(key, { scope, ms: (entry?.ms ?? 0) + 1_000 });
      setTick((value) => value + 1);
    }, 1_000);

    return () => window.clearInterval(id);
  }, []);

  // Report in batches, and before the tab goes away.
  useEffect(() => {
    const flush = (beacon: boolean): void => {
      const batch = pending.current;

      if (batch.size === 0) {
        return;
      }

      pending.current = new Map();
      const record: Sent = { batch, saved: false };
      sent.current = [...sent.current, record];
      post(batch, beacon)
        .then(() => {
          record.saved = true;
        })
        .catch(() => {
          // Not saved: put it back so the next flush retries it.
          sent.current = sent.current.filter((item) => item !== record);
          batch.forEach((entry, key) => {
            const current = pending.current.get(key);
            pending.current.set(key, {
              scope: entry.scope,
              ms: (current?.ms ?? 0) + entry.ms,
            });
          });
        });
    };
    const id = window.setInterval(() => flush(false), FLUSH_MS);
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') {
        flush(true);
      }
    };
    const onLeave = (): void => flush(true);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onLeave);

    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onLeave);
    };
  }, []);

  // A new state from the server includes every batch saved before it.
  const { summary } = args;

  useEffect(() => {
    const splits = Object.values(summary?.pods ?? {}).some(
      (pod) => pod.cards !== undefined
    );

    if (!splits) {
      unsplit.current = [
        ...unsplit.current,
        ...sent.current.filter((item) => item.saved).map((item) => item.batch),
      ];
    }

    sent.current = sent.current.filter((item) => !item.saved);
  }, [summary]);

  const local = [pending.current, ...sent.current.map((item) => item.batch)];
  /** Seconds not yet in the server's totals, for scopes `match` accepts. */
  const localMs = (
    match: (scope: TimeScope) => boolean,
    batches: Batch[] = local
  ): number =>
    batches.reduce(
      (total, batch) =>
        total +
        [...batch.values()]
          .filter((entry) => match(entry.scope))
          .reduce((sum, entry) => sum + entry.ms, 0),
      0
    );
  const { podId, qid } = args.scope;
  const serverScope =
    podId === undefined
      ? 0
      : qid === undefined
      ? summary?.pods[podId]?.totalMs ?? 0
      : summary?.pods[podId]?.items[qid] ?? 0;

  return {
    ticking,
    todayMs: (summary?.todayMs ?? 0) + sumOf(local),
    // An item's time is the same whichever version of it was on screen.
    scopeMs:
      serverScope +
      localMs(
        (scope) =>
          scope.podId === podId && (qid === undefined || scope.qid === qid)
      ),
    /**
     * One item's active time: all of it, per version of it (while the Plan
     * rail showed that version), and per card inside it.
     */
    itemTime: (itemPodId: string, itemQid: string): ItemTimes => {
      const pod = summary?.pods[itemPodId];
      const ofItem = (scope: TimeScope): boolean =>
        scope.podId === itemPodId && scope.qid === itemQid;

      return {
        itemMs: (pod?.items[itemQid] ?? 0) + localMs(ofItem),
        versionMs: (version) =>
          (pod?.versions?.[itemQid]?.[String(version)] ?? 0) +
          localMs(
            (scope) => ofItem(scope) && scope.version === version,
            [...local, ...unsplit.current]
          ),
        cardMs: (card, versions) => {
          const byVersion = pod?.cards?.[itemQid]?.[card] ?? {};
          const counts = (version: number | undefined): boolean =>
            versions === undefined || versions.includes(version ?? 1);

          return (
            Object.entries(byVersion)
              .filter(([version]) => counts(Number(version)))
              .reduce((total, [, ms]) => total + ms, 0) +
            localMs(
              (scope) =>
                ofItem(scope) && scope.card === card && counts(scope.version),
              [...local, ...unsplit.current]
            )
          );
        },
      };
    },
  };
};

/** 1:05:42 / 12:07 */
export const formatDuration = (ms: number): string => {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
};
