import type { LambdaInfo, PodSummary } from './types';

/**
 * The sidebar's computers line, however many there are: one line of counts
 * ("11 building · 2 idle · 1 paused · 1 offline") that opens a popover,
 * computers needing attention first. Pure: the client bundles it.
 */

export type ComputerState =
  | 'building'
  | 'testing'
  | 'shipping'
  | 'blocked'
  | 'idle'
  | 'paused'
  | 'offline';

export interface ComputerRow {
  name: string;
  state: ComputerState;
  /** Its building pod, when it has one. */
  podId: string | null;
  /** "Bench list · test · 12m", "nothing ready for it", "offline 2h". */
  detail: string;
  /** Tickets in its queue: a paused one with work waiting needs attention. */
  waiting: number;
  /** Paused with work waiting, or offline: shown first. */
  attention: boolean;
}

const minutes = (from: string, now: number): string =>
  `${Math.max(0, Math.round((now - Date.parse(from)) / 60_000))}m`;

const hoursAgo = (then: number, now: number): string => {
  const total = Math.max(0, Math.round((now - then) / 60_000));

  return total < 60 ? `${total}m` : `${Math.floor(total / 60)}h`;
};

export const computerRows = (
  lambda: LambdaInfo | undefined,
  pods: PodSummary[],
  now: number
): ComputerRow[] => {
  const buildingPods = pods.filter(
    (summary) =>
      summary.pod.kind === 'building' &&
      summary.pod.talk === undefined &&
      summary.pod.status !== 'done'
  );

  return (lambda?.computers ?? []).map((computer): ComputerRow => {
    const summary = buildingPods.find(
      (one) => lambda?.podComputers?.[one.pod.id] === computer.name
    );
    const building = summary?.building;
    const waiting = building?.upNext?.length ?? 0;
    const podId = summary?.pod.id ?? null;

    if (!computer.connected) {
      return {
        name: computer.name,
        state: 'offline',
        podId,
        detail: `offline ${hoursAgo(computer.lastSeenAt, now)}`,
        waiting,
        attention: true,
      };
    }

    if (summary?.pod.status === 'paused') {
      return {
        name: computer.name,
        state: 'paused',
        podId,
        detail:
          waiting === 0
            ? 'paused'
            : `paused · ${waiting} ${
                waiting === 1 ? 'ticket' : 'tickets'
              } waiting`,
        waiting,
        attention: waiting > 0,
      };
    }

    const current = building?.current ?? null;
    const run = (building?.runs ?? []).find(
      (one) => one.id === current?.id && one.shippedAt === null
    );

    if (current !== null && building !== undefined) {
      return {
        name: computer.name,
        state: building.state === 'paused' ? 'paused' : building.state,
        podId,
        detail: `${current.title} · ${current.step}${
          run === undefined ? '' : ` · ${minutes(run.startedAt, now)}`
        }`,
        waiting,
        attention: false,
      };
    }

    return {
      name: computer.name,
      state: building?.state === 'blocked' ? 'blocked' : 'idle',
      podId,
      detail: building === undefined ? 'not building' : 'nothing ready for it',
      waiting,
      attention: false,
    };
  });
};

/**
 * A computer's row offers Pause, beside Terminal, while its building pod runs:
 * the same place a paused one offers Resume. Offline, it can't be told to.
 */
export const canPause = (row: ComputerRow): boolean =>
  row.podId !== null && row.state !== 'paused' && row.state !== 'offline';

/** "11 building · 2 idle · 1 paused · 1 offline", leaving out the zeros. */
export const computersCounts = (
  rows: ComputerRow[]
): Array<{ label: string; tone: 'plain' | 'paused' | 'offline' }> => {
  const count = (states: ComputerState[]): number =>
    rows.filter((row) => states.includes(row.state)).length;
  const parts: Array<{
    n: number;
    what: string;
    tone: 'plain' | 'paused' | 'offline';
  }> = [
    {
      n: count(['building', 'testing', 'shipping', 'blocked']),
      what: 'building',
      tone: 'plain',
    },
    { n: count(['idle']), what: 'idle', tone: 'plain' },
    { n: count(['paused']), what: 'paused', tone: 'paused' },
    { n: count(['offline']), what: 'offline', tone: 'offline' },
  ];

  return parts
    .filter((part) => part.n > 0)
    .map(({ n, what, tone }) => ({ label: `${n} ${what}`, tone }));
};
