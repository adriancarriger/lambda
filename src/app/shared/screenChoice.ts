import type { Pod } from '../../pod-store';
import type { PodSummary } from './types';

/**
 * Small choices the app shell makes about what's on screen. Pure: the
 * client bundles this file.
 */

/**
 * The rail a Lambda opens on the first time it's on screen. A building pod
 * on its own page opens on Workflow. Anywhere else (an item of it in the
 * inbox, or Auto) it's in the planning screen, whose Workflow rail is a
 * planning pod's, so it opens on Plan, where its item is. A structured
 * planning pod opens on Plan; a freeform chat starts shut.
 */
export const firstRailOf = (
  pod: Partial<Pick<Pod, 'kind' | 'mode'>> | undefined,
  ownPage: boolean
): 'workflow' | 'plan' | null => {
  if (pod?.kind === 'building') {
    return ownPage ? 'workflow' : 'plan';
  }

  return pod?.mode === 'freeform' ? null : 'plan';
};

/**
 * The planning screen's rail, of the one open: Tickets (the Lambda's
 * tickets) and Plan need a pod (not another page or all caught up); and the
 * Workflow rail is a planning pod's, with Skip buttons that would skip a
 * building pod's stages, so never for a building pod. Tickets is a planning
 * pod's there too: a building pod's own page has its own.
 */
export const planningRailOf = <Rail extends string>(
  rail: Rail | null,
  on: { offPod: boolean; buildingPod: boolean }
): Rail | null => {
  if (rail === 'tickets' && (on.offPod || on.buildingPod)) {
    return null;
  }

  if (rail === 'plan' && on.offPod) {
    return null;
  }

  return rail === 'workflow' && on.buildingPod ? null : rail;
};

/**
 * The rail buttons the planning screen offers, for the kind of pod in it.
 * A building pod there (an item of it in the inbox, or Auto) gets no
 * Workflow button: that rail is a planning pod's, so it would show nothing.
 */
export const planningRailsOf = (
  kind: Pod['kind'] | undefined
): ('plan' | 'tickets' | 'workflow' | 'made' | 'agents')[] =>
  kind === 'building'
    ? ['plan', 'made', 'agents']
    : ['plan', 'tickets', 'workflow', 'made', 'agents'];

/**
 * A Lambda's rails past planning, by phase: Ready shows its place in the
 * queue (Tickets), building its Workflow, QA adds Review, merged adds
 * Summary. Plan, Made and Agents are always there.
 */
export const lambdaRailsOf = (
  phase: 'queued' | 'building' | 'qa' | 'shipped' | 'done'
): (
  | 'plan'
  | 'tickets'
  | 'workflow'
  | 'review'
  | 'summary'
  | 'made'
  | 'agents'
)[] => {
  switch (phase) {
    case 'queued':
      return ['plan', 'tickets', 'made', 'agents'];
    case 'qa':
      return ['plan', 'workflow', 'review', 'made', 'agents'];
    case 'shipped':
      return ['plan', 'workflow', 'summary', 'made', 'agents'];
    default:
      return ['plan', 'workflow', 'made', 'agents'];
  }
};

/** The rail a Lambda's page opens on in each phase. */
export const lambdaDefaultRail = (
  phase: 'queued' | 'building' | 'qa' | 'shipped' | 'done'
): 'tickets' | 'workflow' | 'review' | 'summary' | 'plan' =>
  phase === 'queued'
    ? 'tickets'
    : phase === 'building'
    ? 'workflow'
    : phase === 'qa'
    ? 'review'
    : phase === 'shipped'
    ? 'summary'
    : 'plan';

/**
 * The rail a Lambda comes back to on a screen with `available` rails:
 * `stored` is the one left open on it ('' = shut, undefined = never seen).
 * A rail this screen doesn't have (Plan, left open in the planning screen,
 * on a building pod's own page) gives way to the screen's first rail.
 */
export const railFor = <Rail extends string>(
  stored: string | undefined,
  available: readonly Rail[],
  first: Rail | null
): Rail | null => {
  if (stored === '') {
    return null;
  }

  return available.find((rail) => rail === stored) ?? first;
};

/** A sidebar row's mark while its pod has an inbox item (a Blocked one too). */
export const sideRowNeedsYou = (
  summary: Pick<PodSummary, 'needsYou'>
): string => (summary.needsYou > 0 ? ' side-row--needs-you' : '');
