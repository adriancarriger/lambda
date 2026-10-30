import * as fs from 'fs';

import { ID_PATTERN } from '../../pod-store';
import type { PodTime, TimeSummary } from '../shared/types';

/**
 * How long the owner actively spends planning — counted by the page (scrolling,
 * typing, listening; never just having it open) and reported here in small
 * batches. Kept per day, per pod, per item and per version of a card in
 * `<pods root>/_time.json`.
 */

interface TimeLog {
  days: Record<string, number>;
  pods: Record<string, PodTime>;
}

export interface TimeEntry {
  podId?: string;
  qid?: string;
  /** The version of the card on screen (only while the Plan rail shows it). */
  version?: number;
  /** The card inside it that had their attention (see cardHistory.ts). */
  card?: string;
  ms: number;
}

const plus = (
  totals: Record<string, number> | undefined,
  key: string,
  ms: number
): Record<string, number> => ({ ...totals, [key]: (totals?.[key] ?? 0) + ms });

/** A card key is a title; anything longer than this isn't one. */
const MAX_CARD_KEY = 300;

/**
 * A batch can't credit more than this, all its entries together (the page
 * reports every ~15 s).
 */
const MAX_BATCH_MS = 5 * 60_000;

/** A pod or item id: what the store names them, never a path or a guess. */
const MAX_ID = 100;
const isId = (value: string | undefined): boolean =>
  value === undefined || (value.length <= MAX_ID && ID_PATTERN.test(value));

/** Told where an unreadable log was moved; the count starts again. */
export type OnUnreadable = (movedTo: string, error: string) => void;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const numbers = (value: unknown): Record<string, number> =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, number] => typeof entry[1] === 'number'
        )
      )
    : {};

const EMPTY: TimeLog = { days: {}, pods: {} };

/** Throws on anything that isn't a time log (so it's moved aside, not lost). */
const parseLog = (parsed: unknown): TimeLog => {
  if (!isRecord(parsed)) {
    throw new Error('it is not a time log');
  }

  const pods = isRecord(parsed.pods) ? parsed.pods : {};

  return {
    days: numbers(parsed.days),
    pods: Object.fromEntries(
      Object.entries(pods).map(([podId, pod]) => [
        podId,
        {
          totalMs:
            isRecord(pod) && typeof pod.totalMs === 'number' ? pod.totalMs : 0,
          items: isRecord(pod) ? numbers(pod.items) : {},
          cards:
            isRecord(pod) && isRecord(pod.cards)
              ? Object.fromEntries(
                  Object.entries(pod.cards).map(([qid, byCard]) => [
                    qid,
                    isRecord(byCard)
                      ? Object.fromEntries(
                          Object.entries(byCard).map(([card, byVersion]) => [
                            card,
                            numbers(byVersion),
                          ])
                        )
                      : {},
                  ])
                )
              : {},
          versions:
            isRecord(pod) && isRecord(pod.versions)
              ? Object.fromEntries(
                  Object.entries(pod.versions).map(([qid, byVersion]) => [
                    qid,
                    numbers(byVersion),
                  ])
                )
              : {},
        },
      ])
    ),
  };
};

/**
 * The log, or empty when there's none yet. One that can't be read is moved
 * aside (kept, not written over) and `onUnreadable` told where.
 */
const read = (file: string, onUnreadable?: OnUnreadable): TimeLog => {
  const text = (() => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return null;
      }

      throw error;
    }
  })();

  if (text === null) {
    return EMPTY;
  }

  try {
    return parseLog(JSON.parse(text));
  } catch (error) {
    const movedTo = `${file}.unreadable-${Date.now()}`;
    fs.renameSync(file, movedTo);
    onUnreadable?.(
      movedTo,
      error instanceof Error ? error.message : String(error)
    );

    return EMPTY;
  }
};

/** Today in the server's (= the owner's machine's) local time. */
export const localDay = (now: Date = new Date()): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`;

/** The entries a batch may credit: real ids, and 5 minutes in all. */
const creditable = (entries: TimeEntry[]): TimeEntry[] =>
  entries
    .filter((entry) => entry.ms > 0 && isId(entry.podId) && isId(entry.qid))
    .map((entry) =>
      entry.card !== undefined && entry.card.length > MAX_CARD_KEY
        ? { ...entry, card: undefined }
        : entry
    )
    .reduce<{ left: number; kept: TimeEntry[] }>(
      ({ left, kept }, entry) => {
        const ms = Math.min(left, entry.ms);

        return ms > 0
          ? { left: left - ms, kept: [...kept, { ...entry, ms }] }
          : { left, kept };
      },
      { left: MAX_BATCH_MS, kept: [] }
    ).kept;

export const addTime = (
  file: string,
  entries: TimeEntry[],
  day: string = localDay(),
  onUnreadable?: OnUnreadable
): void => {
  const valid = creditable(entries);

  if (valid.length === 0) {
    return;
  }

  const log = valid.reduce<TimeLog>((current, entry) => {
    const days = plus(current.days, day, entry.ms);

    if (entry.podId === undefined) {
      return { ...current, days };
    }

    const pod = current.pods[entry.podId] ?? { totalMs: 0, items: {} };
    const { qid, version, card, ms } = entry;
    const shown = version ?? 1;

    return {
      days,
      pods: {
        ...current.pods,
        [entry.podId]: {
          totalMs: pod.totalMs + ms,
          items: qid === undefined ? pod.items : plus(pod.items, qid, ms),
          versions:
            qid === undefined || version === undefined
              ? pod.versions ?? {}
              : {
                  ...pod.versions,
                  [qid]: plus(pod.versions?.[qid], String(version), ms),
                },
          cards:
            qid === undefined || card === undefined
              ? pod.cards ?? {}
              : {
                  ...pod.cards,
                  [qid]: {
                    ...pod.cards?.[qid],
                    [card]: plus(pod.cards?.[qid]?.[card], String(shown), ms),
                  },
                },
        },
      },
    };
  }, read(file, onUnreadable));

  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(log, null, 2)}\n`);
  fs.renameSync(tmp, file);
};

export const timeSummary = (
  file: string,
  day: string = localDay(),
  onUnreadable?: OnUnreadable
): TimeSummary => {
  const log = read(file, onUnreadable);

  return { day, todayMs: log.days[day] ?? 0, days: log.days, pods: log.pods };
};
