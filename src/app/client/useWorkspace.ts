import { useCallback, useEffect, useRef, useState } from 'react';

import type { TrackerProject } from '../../tickets/source';
import type { TrackerProjectsResponse } from '../shared/building';
import type { Favorite, FavoriteKind, SavedView } from '../shared/savedViews';
import { api } from './api';

/**
 * Saved views, favorites and the trackers' projects, as the whole app shares
 * them: the sidebar draws the favorites, Tickets scopes to a view or project.
 * Views and favorites are the mothership's own (cheap), read again on each
 * tick; the trackers' projects ask every codebase's tracker, so they're read
 * once a minute at most, or when asked.
 */

const PROJECTS_REFRESH_MS = 60_000;

export interface Workspace {
  views: SavedView[] | null;
  favorites: Favorite[];
  trackerProjects: TrackerProjectsResponse | null;
  /** A codebase's tracker projects (none while loading or offline). */
  projectsOf: (codebaseId: string) => TrackerProject[];
  isFavorite: (kind: FavoriteKind, ref: string) => boolean;
  /** Star or unstar: shown at once, the mothership's answer kept. */
  setFavorite: (
    kind: FavoriteKind,
    ref: string,
    on: boolean,
    /** Its name for the sidebar, when the mothership can't know it. */
    label?: string
  ) => void;
  orderFavorites: (ids: string[]) => void;
  /** Read views (and favorites) again: after a save, a delete, an import. */
  reloadViews: () => Promise<void>;
  reloadProjects: () => void;
}

export const useWorkspace = (
  tick: number,
  fail: (caught: unknown) => void
): Workspace => {
  const [views, setViews] = useState<SavedView[] | null>(null);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [trackerProjects, setTrackerProjects] =
    useState<TrackerProjectsResponse | null>(null);
  const projectsAt = useRef<number | null>(null);

  const reloadViews = useCallback(
    () =>
      Promise.all([api.views(), api.favorites()]).then(
        ([nextViews, nextFavorites]) => {
          setViews(nextViews);
          setFavorites(nextFavorites);
        }
      ),
    []
  );

  const reloadProjects = useCallback(() => {
    projectsAt.current = Date.now();
    api
      .trackerProjects()
      .then(setTrackerProjects)
      .catch(() => {
        // A tracker that's away: its projects come with the next read.
        projectsAt.current = null;
      });
  }, []);

  useEffect(() => {
    // A failed read is retried on the next tick; nothing to show meanwhile.
    reloadViews().catch(() => undefined);

    if (
      projectsAt.current === null ||
      Date.now() - projectsAt.current > PROJECTS_REFRESH_MS
    ) {
      reloadProjects();
    }
  }, [tick, reloadViews, reloadProjects]);

  const projectsOf = (codebaseId: string): TrackerProject[] => {
    const codebase = trackerProjects?.codebases.find(
      (one) => one.projectId === codebaseId
    );

    return codebase !== undefined && 'projects' in codebase
      ? codebase.projects
      : [];
  };

  return {
    views,
    favorites,
    trackerProjects,
    projectsOf,
    isFavorite: (kind, ref) =>
      favorites.some((one) => one.kind === kind && one.ref === ref),
    setFavorite: (kind, ref, on, label) => {
      setFavorites((now) =>
        on
          ? [
              ...now.filter((one) => one.kind !== kind || one.ref !== ref),
              {
                id: `pending:${kind}:${ref}`,
                kind,
                ref,
                position: Number.MAX_SAFE_INTEGER,
                label: label ?? null,
              },
            ]
          : now.filter((one) => one.kind !== kind || one.ref !== ref)
      );
      api.favorite(kind, ref, on, label).then(setFavorites).catch(fail);
    },
    orderFavorites: (ids) => {
      setFavorites((now) =>
        ids.flatMap((id) => now.filter((one) => one.id === id))
      );
      api.orderFavorites(ids).then(setFavorites).catch(fail);
    },
    reloadViews,
    reloadProjects,
  };
};
