import type { AccountPage } from '../shared/route';
import type { LambdaInfo, ProjectInfo, WaitingPod } from '../shared/types';

/**
 * Projects in the app. With one project it looks as it always has: no
 * headings, no tags. With two or more, the sidebar groups Lambdas under
 * project headings and items carry a small project tag.
 */

export const ACCOUNT_PAGE_TITLES: Record<AccountPage, string> = {
  computers: 'Computers',
  analytics: 'Analytics',
  'settings/devices': 'Settings',
  'settings/process': 'Settings',
  'settings/design-system': 'Settings',
};

export const showsProjects = (lambda: LambdaInfo | undefined): boolean =>
  (lambda?.projects.length ?? 0) >= 2;

export const projectOfPod = (
  podId: string,
  lambda: LambdaInfo | undefined
): ProjectInfo | undefined => {
  const projectId = lambda?.podProjects[podId];

  return lambda?.projects.find((project) => project.id === projectId);
};

/** "Dog park map · Pawnee Parks site" with two or more projects; else as it is. */
export const withProjectTag = (
  label: string,
  podId: string,
  lambda: LambdaInfo | undefined
): string => {
  const project = showsProjects(lambda)
    ? projectOfPod(podId, lambda)
    : undefined;

  return project === undefined ? label : `${label} · ${project.name}`;
};

export interface PodGroup<T> {
  /** null: no heading (one project), or the trailing group (`other`). */
  project: ProjectInfo | null;
  /** The pods no project claims, after the project groups. */
  other: boolean;
  pods: T[];
  waiting: WaitingPod[];
}

/**
 * The sidebar's groups: one, unheaded, until there are two projects. Then
 * one per project with pods, plus a trailing group for pods no project
 * claims, so none drops out of sight. With nothing to show there is still
 * one empty group, which says so.
 */
export const groupByProject = <T extends { pod: { id: string } }>(
  pods: T[],
  lambda: LambdaInfo | undefined
): PodGroup<T>[] => {
  const waiting = lambda?.waiting ?? [];

  if (!showsProjects(lambda) || lambda === undefined) {
    return [{ project: null, other: false, pods, waiting }];
  }

  const ids = new Set(lambda.projects.map((project) => project.id));
  const claimed = (projectId: string | undefined): boolean =>
    projectId !== undefined && ids.has(projectId);
  const groups: PodGroup<T>[] = [
    ...lambda.projects.map((project) => ({
      project,
      other: false,
      pods: pods.filter(
        (summary) => lambda.podProjects[summary.pod.id] === project.id
      ),
      waiting: waiting.filter((pod) => pod.projectId === project.id),
    })),
    {
      project: null,
      other: true,
      pods: pods.filter(
        (summary) => !claimed(lambda.podProjects[summary.pod.id])
      ),
      waiting: waiting.filter((pod) => !claimed(pod.projectId)),
    },
  ].filter((group) => group.pods.length > 0 || group.waiting.length > 0);

  return groups.length > 0
    ? groups
    : [{ project: null, other: false, pods: [], waiting: [] }];
};

/** Where a new idea goes: the last project used, else the first. */
export const defaultProjectId = (
  lambda: LambdaInfo | undefined
): string | null => lambda?.lastProjectId ?? lambda?.projects[0]?.id ?? null;

/**
 * The project a page shows: the one picked, while it still exists, else the
 * default. Worked out on every render, so a page opened before any project
 * existed picks one up as soon as it's added.
 */
export const chosenProjectId = (
  chosen: string | null,
  lambda: LambdaInfo | undefined
): string | null =>
  chosen !== null &&
  (lambda?.projects ?? []).some((project) => project.id === chosen)
    ? chosen
    : defaultProjectId(lambda);

/** The ticket shortcut under the box, in the project's own prefix; none without one. */
export const ticketShortcut = (
  prefix: string | null | undefined
): { label: string; fill: string } | null =>
  prefix === null || prefix === undefined || prefix === ''
    ? null
    : { label: `Plan a ticket or epic — ${prefix}-…`, fill: `Plan ${prefix}-` };
