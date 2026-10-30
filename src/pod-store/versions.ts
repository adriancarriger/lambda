import * as fs from 'fs';
import * as path from 'path';

import type { AutonomousDecision, Question } from './schemas';
import type { PodStore } from './store';

/**
 * Versions of a checkpoint card. The card is edited in place (a re-post, or
 * the dev editing its files), so before new content replaces it, the old card
 * is kept as `<pod>/versions/<qid>/<n>.json` and the new one becomes n + 1.
 *
 * Two kinds of change don't make a version:
 *  - an edit that changed nothing the owner would see (a refresh that re-read the
 *    same files) — a re-post always does: it marks when the dev posted again;
 *  - the version being replaced is under QUICK_EDIT_MS old and the owner never
 *    saw it (no active time on it): a burst of quick edits folds into one
 *    version rather than a list of drafts nobody read.
 *
 * Each version carries the wording of the decisions it lists
 * (`decisionSnapshot`), so an earlier one shows them as they were; amending a
 * decision makes a new version of every open checkpoint that lists it.
 */

export type VersionKind = 'posted' | 'reposted' | 'edited';

/** A version younger than this, never looked at, is replaced, not kept. */
export const QUICK_EDIT_MS = 2 * 60_000;

/** What a decision says — not its bookkeeping. */
const decisionContent = (decision: AutonomousDecision) => ({
  id: decision.id,
  decision: decision.decision,
  before: decision.before,
  means: decision.means,
  kind: decision.kind,
  why: decision.why,
  tickets: decision.tickets,
  details: decision.details,
  ux: decision.ux,
  instead: decision.instead,
});

/**
 * Bookkeeping, not content: changes to these alone aren't a new version.
 * `withDecisions: false` — a card saved before decisions were copied in: the
 * first copy isn't a change.
 */
const contentOf = (question: Question, withDecisions = true): string => {
  const { checkpoint, ...rest } = question;

  if (checkpoint === undefined) {
    return JSON.stringify(rest);
  }

  const {
    refreshedAt: _refreshedAt,
    refreshError: _refreshError,
    version: _version,
    versionAt: _versionAt,
    versionKind: _versionKind,
    keptJudgements: _keptJudgements,
    decisionSnapshot,
    ...content
  } = checkpoint;

  return JSON.stringify({
    ...rest,
    checkpoint: content,
    decisions: withDecisions ? decisionSnapshot?.map(decisionContent) : null,
  });
};

/** The card with the current wording of the decisions it lists. */
export const withDecisionSnapshot = (
  store: PodStore,
  card: Question
): Question => {
  const ids = card.checkpoint?.decisionIds;

  if (card.checkpoint === undefined || ids === undefined) {
    return card;
  }

  return {
    ...card,
    checkpoint: {
      ...card.checkpoint,
      decisionSnapshot: store
        .readAutonomousDecisions(card.podId)
        .filter((decision) => ids.includes(decision.id)),
    },
  };
};

export const versionOf = (question: Question): number =>
  question.checkpoint?.version ?? 1;

/**
 * Active ms the owner spent on one version of a card, from the inbox's time log
 * (`<root>/_time.json`, written by the inbox server). 0 when there's none.
 */
export const versionActiveMs = (
  root: string,
  podId: string,
  qid: string,
  version: number
): number => {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const at = (value: unknown, key: string): unknown =>
    isRecord(value) ? value[key] : undefined;

  try {
    const log: unknown = JSON.parse(
      fs.readFileSync(path.join(root, '_time.json'), 'utf8')
    );
    const ms = at(
      at(at(at(at(log, 'pods'), podId), 'versions'), qid),
      String(version)
    );

    return typeof ms === 'number' ? ms : 0;
  } catch {
    return 0;
  }
};

/**
 * The card to write in place of `previous` (undefined: a brand-new card),
 * keeping `previous` as a version first when that's warranted.
 */
export const nextCardVersion = (args: {
  store: PodStore;
  previous: Question | undefined;
  next: Question;
  kind: VersionKind;
  now?: Date;
  /** Active ms on a version (defaults to the inbox's time log). */
  activeMs?: (version: number) => number;
}): Question => {
  const { store, previous, next, kind } = args;
  const now = args.now ?? new Date();
  const stamp = (
    question: Question,
    version: number,
    at: string,
    as: VersionKind
  ): Question =>
    question.checkpoint === undefined
      ? question
      : {
          ...question,
          checkpoint: {
            ...question.checkpoint,
            version,
            versionAt: at,
            versionKind: as,
          },
        };

  if (previous?.checkpoint === undefined) {
    return stamp(next, 1, now.toISOString(), 'posted');
  }

  const version = versionOf(previous);
  const at = previous.checkpoint.versionAt ?? previous.createdAt;
  const was = previous.checkpoint.versionKind ?? 'posted';

  const withDecisions = previous.checkpoint.decisionSnapshot !== undefined;

  if (
    kind !== 'reposted' &&
    contentOf(previous, withDecisions) === contentOf(next, withDecisions)
  ) {
    return stamp(next, version, at, was);
  }

  const seenMs =
    args.activeMs?.(version) ??
    versionActiveMs(store.root, previous.podId, previous.id, version);
  const quick = now.getTime() - Date.parse(at) < QUICK_EDIT_MS && seenMs === 0;

  if (quick) {
    return stamp(next, version, now.toISOString(), was);
  }

  store.writeQuestionVersion(stamp(previous, version, at, was));

  return stamp(next, version + 1, now.toISOString(), kind);
};

/**
 * A decision was amended: every open checkpoint listing it gets a new version
 * with the new wording.
 */
export const reversionForDecision = (
  store: PodStore,
  podId: string,
  decisionId: string
): void =>
  store
    .listQuestions(podId)
    .filter(
      (question) =>
        question.kind === 'checkpoint' &&
        question.status === 'open' &&
        question.checkpoint?.decisionIds.includes(decisionId) === true
    )
    .forEach((question) =>
      store.writeQuestion(
        nextCardVersion({
          store,
          previous: question,
          next: withDecisionSnapshot(store, question),
          kind: 'edited',
        })
      )
    );
