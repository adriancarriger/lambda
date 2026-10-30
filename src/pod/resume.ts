import * as path from 'path';

import {
  type Pod,
  type PodStore,
  nowIso,
  podKindOf,
  writeJsonAtomic,
} from '../pod-store';
import { openStore, podsRoot } from './context';
import { runForkRecover } from './fork';
import { agentsHealthy, ensurePodRunning } from './lifecycle';
import { sleep } from './tmux';

/**
 * Restart survival. `lambda pod resume-all` brings back every active pod in
 * this project's pods root, oldest first, staggered, and re-sends whatever
 * its agents never took in. It works right here in the terminal it was run
 * from, opens no tmux window outside the pods' own `lambda-pod-<id>`
 * sessions, and only writes a report file — no app, no notification.
 */

export interface ResumeReport {
  at: string;
  pods: { id: string; result: string }[];
  redelivered: string[];
  recoveredForks: string[];
  errors: string[];
}

export type PodKind = ReturnType<typeof podKindOf>;

/**
 * Building pods first, then the rest oldest first; `only`: just that kind
 * (the boot brings a building pod's agents back on its own, at once).
 */
const podsToResume = (store: PodStore, only?: PodKind): Pod[] => {
  const pods = store
    .listPodIds()
    .map((podId) => store.requirePod(podId))
    .filter((pod) => only === undefined || podKindOf(pod) === only)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return [
    ...pods.filter((pod) => podKindOf(pod) === 'building'),
    ...pods.filter((pod) => podKindOf(pod) !== 'building'),
  ];
};

export const resumeForeground = async (
  staggerSec: number,
  only?: PodKind
): Promise<ResumeReport> => {
  const store = openStore();
  const pods = podsToResume(store, only);

  // Each start re-sends what that pod's agents never took in (lifecycle.ts).
  const results = await pods.reduce<
    Promise<
      { id: string; result: string; resent: string[]; errors: string[] }[]
    >
  >(async (previousPromise, pod) => {
    const previous = await previousPromise;
    // A building pod's agent windows are always there, paused or not (pause
    // only stops it taking tickets): its agents come back either way.
    const building = podKindOf(pod) === 'building';

    if (pod.status !== 'active' && !(building && pod.status === 'paused')) {
      return [
        ...previous,
        {
          id: pod.id,
          result: `skipped (${pod.status})`,
          resent: [],
          errors: [],
        },
      ];
    }

    // A planning pod's windows; a building pod's are checked by
    // ensurePodRunning, which knows a shell in its window from its agent.
    if (!building && agentsHealthy(pod.id)) {
      return [
        ...previous,
        { id: pod.id, result: 'already running', resent: [], errors: [] },
      ];
    }

    try {
      // The stagger spaces out planning pods; a building pod's agents never
      // wait for it (its windows are already there, in front of you).
      const plannedBefore = previous.some(
        (entry) =>
          entry.result === 'resumed' &&
          !pods.some(
            (other) => other.id === entry.id && podKindOf(other) === 'building'
          )
      );

      if (!building && plannedBefore) {
        await sleep(staggerSec * 1000);
      }

      const outcome = await ensurePodRunning(store, pod);

      return [
        ...previous,
        {
          id: pod.id,
          result:
            outcome.result === 'started'
              ? pod.status === 'paused'
                ? 'agents back (paused)'
                : 'resumed'
              : outcome.result === 'starting'
              ? 'already being started'
              : 'already running',
          resent: outcome.resent.map((msgId) => `${pod.id}/${msgId}`),
          errors: outcome.errors,
        },
      ];
    } catch (error) {
      return [
        ...previous,
        {
          id: pod.id,
          result: `error: ${String(error)}`,
          resent: [],
          errors: [],
        },
      ];
    }
  }, Promise.resolve([]));

  const liveForks = pods
    .filter((pod) => pod.status === 'active')
    .flatMap((pod) =>
      store
        .listForks(pod.id)
        .filter((fork) => fork.state !== 'resolved' && fork.state !== 'dead')
    );

  // Each fork on its own: one that can't be recovered goes in the report's
  // errors, and the rest — and the report itself — still happen.
  const forks = await liveForks.reduce<
    Promise<{ recovered: string[]; errors: string[] }>
  >(async (previousPromise, fork) => {
    const previous = await previousPromise;
    const name = `${fork.podId}/${fork.qid}`;

    try {
      await runForkRecover(fork.podId, fork.qid);

      return { ...previous, recovered: [...previous.recovered, name] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return {
        ...previous,
        errors: [...previous.errors, `fork ${name} not recovered: ${message}`],
      };
    }
  }, Promise.resolve({ recovered: [], errors: [] }));

  return {
    at: nowIso(),
    pods: results.map(({ id, result }) => ({ id, result })),
    redelivered: results.flatMap((entry) => entry.resent),
    recoveredForks: forks.recovered,
    errors: [...results.flatMap((entry) => entry.errors), ...forks.errors],
  };
};

const resumeLine = (
  pod: { id: string; result: string },
  report: ResumeReport
): string => {
  const resent = report.redelivered.filter((entry) =>
    entry.startsWith(`${pod.id}/`)
  ).length;
  const forks = report.recoveredForks
    .filter((entry) => entry.startsWith(`${pod.id}/`))
    .map((entry) => entry.slice(pod.id.length + 1));
  const extras = [
    ...(resent === 0
      ? []
      : [`${resent} message${resent === 1 ? '' : 's'} re-sent`]),
    ...forks.map((qid) => `fork "${qid}" recovered`),
  ];

  return `  ${pod.id.padEnd(24)}${pod.result}${
    extras.length === 0 ? '' : `   ${extras.join(', ')}`
  }`;
};

export const runResumeAll = async (options: {
  stagger?: string;
  only?: string;
}): Promise<void> => {
  const { only } = options;

  if (only !== undefined && only !== 'building' && only !== 'planning') {
    throw new Error(`--only takes building or planning (got "${only}").`);
  }

  const staggerSec =
    options.stagger === undefined ? 30 : Number(options.stagger);

  if (!Number.isFinite(staggerSec) || staggerSec < 0) {
    throw new Error(
      `--stagger must be a number of seconds (got "${options.stagger}").`
    );
  }

  const active = podsToResume(openStore(), only).filter(
    (pod) => pod.status === 'active'
  );
  console.log(
    `Resuming ${active.length} Lambda${
      active.length === 1 ? '' : 's'
    } (stagger ${staggerSec}s)…`
  );

  const report = await resumeForeground(staggerSec, only);
  const file = path.join(podsRoot(), '_last-resume.json');
  writeJsonAtomic(file, report);

  report.pods.forEach((pod) => console.log(resumeLine(pod, report)));
  report.errors.forEach((error) => console.warn(`⚠ ${error}`));
  console.log(`Report: ${file}`);
};
