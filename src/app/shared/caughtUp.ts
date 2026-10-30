import { computerRows } from './computersFooter';
import type { Lambda } from './lambdas';
import type { LambdaInfo, PodSummary } from './types';

/**
 * All caught up: nothing waits on the owner. One line of where things
 * stand, and only optional things they could do: plan something new, plan
 * Ready tickets nobody planned, resume a paused computer with work waiting,
 * reassign an offline one's tickets. Pure: the client bundles it.
 */

export type LaunchItem =
  | { kind: 'new' }
  | { kind: 'unplanned'; tickets: Lambda[] }
  | { kind: 'paused'; computer: string; podId: string; waiting: number }
  | { kind: 'offline'; computer: string; assigned: number };

const count = (n: number, what: string): string => `${n} ${what}`;

/** "2 planning · 11 building · 4 queued", leaving out the zeros. */
export const caughtUpLine = (lambdas: Lambda[]): string => {
  const of = (phases: Lambda['phase'][]): number =>
    lambdas.filter((lambda) => phases.includes(lambda.phase)).length;
  const parts = [
    count(of(['planning']), 'planning'),
    count(of(['building', 'qa']), 'building'),
    count(of(['queued']), 'queued'),
  ].filter((part) => !part.startsWith('0 '));

  return parts.length === 0 ? 'Nothing is in flight.' : parts.join(' · ');
};

export const launchItems = (
  lambdas: Lambda[],
  lambda: LambdaInfo | undefined,
  pods: PodSummary[],
  now: number
): LaunchItem[] => {
  const unplanned = lambdas.filter(
    (one) => one.planningPodId === null && one.phase === 'queued'
  );
  const rows = computerRows(lambda, pods, now);
  // Tickets queued on an offline computer are what it would strand.
  const queuedOn = (computer: string): number =>
    lambdas
      .flatMap((one) => one.tickets)
      .filter(
        (ticket) =>
          ticket.where.kind === 'queued' && ticket.where.computer === computer
      ).length;

  const planThem: LaunchItem[] =
    unplanned.length === 0 ? [] : [{ kind: 'unplanned', tickets: unplanned }];

  return [
    { kind: 'new' },
    ...planThem,
    ...rows.flatMap((row): LaunchItem[] =>
      row.state === 'paused' && row.waiting > 0 && row.podId !== null
        ? [
            {
              kind: 'paused',
              computer: row.name,
              podId: row.podId,
              waiting: row.waiting,
            },
          ]
        : row.state === 'offline' && queuedOn(row.name) > 0
        ? [
            {
              kind: 'offline',
              computer: row.name,
              assigned: queuedOn(row.name),
            },
          ]
        : []
    ),
  ];
};
