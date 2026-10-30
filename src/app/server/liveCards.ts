import type { PodStore } from '../../pod-store';

/**
 * Cards edited like a doc: an open checkpoint records the files its card was
 * built from (`checkpoint.sources`). When one of them is newer than the card's
 * last read, the card is stale — the server runs `lambda pod checkpoint refresh`,
 * which re-reads them with the same checks as posting and updates the card in
 * place (or records why the edit didn't take).
 */

export interface StaleCard {
  podId: string;
  cp: number;
  /** The newest of its files: refreshing for this edit once is enough. */
  mtime: number;
}

const SOURCE_FILES = [
  'planFile',
  'screensFile',
  'proposalFile',
  'changesFile',
  'judgementsFile',
] as const;

/**
 * Open checkpoints whose files changed after the card was last read.
 * `tried`: the newest edit already refreshed for (by "podId/cp"), so an edit
 * that failed its checks isn't re-run until the file changes again.
 */
export const staleCards = (
  store: PodStore,
  mtimeOf: (file: string) => number | null,
  tried: ReadonlyMap<string, number>
): StaleCard[] =>
  store.listPodIds().flatMap((podId) =>
    store.listQuestions(podId).flatMap((question): StaleCard[] => {
      const { checkpoint } = question;
      const sources = checkpoint?.sources;

      if (
        question.kind !== 'checkpoint' ||
        question.status !== 'open' ||
        checkpoint === undefined ||
        sources === undefined
      ) {
        return [];
      }

      const newest = Math.max(
        0,
        ...SOURCE_FILES.flatMap((key) => {
          const file = sources[key];
          const mtime = file === undefined ? null : mtimeOf(file);

          return mtime === null ? [] : [mtime];
        })
      );
      const readAt = Date.parse(checkpoint.refreshedAt ?? question.createdAt);
      const key = `${podId}/${checkpoint.cp}`;

      return newest > readAt && newest !== tried.get(key)
        ? [{ podId, cp: checkpoint.cp, mtime: newest }]
        : [];
    })
  );

/**
 * One pass of the re-read: `lambda pod checkpoint refresh` (`refresh`) for
 * each stale card not already being refreshed. Answers once they're done.
 */
export const refreshStaleCards = (deps: {
  store: PodStore;
  mtimeOf: (file: string) => number | null;
  tried: Map<string, number>;
  refreshing: Set<string>;
  refresh: (card: StaleCard) => Promise<unknown>;
  log: (line: string) => void;
}): Promise<void> =>
  Promise.all(
    staleCards(deps.store, deps.mtimeOf, deps.tried).map(async (card) => {
      const key = `${card.podId}/${card.cp}`;

      if (deps.refreshing.has(key)) {
        return;
      }

      deps.refreshing.add(key);
      deps.tried.set(key, card.mtime);

      await deps
        .refresh(card)
        .catch((error: unknown) =>
          deps.log(
            `Couldn't refresh checkpoint ${card.cp} of ${card.podId}: ${
              error instanceof Error ? error.message : String(error)
            }. It's tried again when its files change.`
          )
        )
        .finally(() => deps.refreshing.delete(key));
    })
  ).then(() => undefined);
