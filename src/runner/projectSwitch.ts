import type { PodActivity } from '../app/shared/snapshot';

/**
 * The idle project switch. A runner works on one project at a time; when it
 * has been idle for 5 minutes and another project it holds has a pod
 * waiting, it stops the current project and starts the waiting one. The
 * decision is pure (the mothership makes it from what runners push); the
 * switch itself runs on the runner (`runSwitch`).
 */

export const IDLE_MS = 5 * 60_000;

export interface WaitingFor {
  projectId: string;
  /** When the pod was asked for, ms. */
  createdAt: number;
}

export interface SwitchInput {
  now: number;
  /** The current project's pods. */
  activity: PodActivity[];
  /**
   * When the runner arrived on its current project, ms (its `runner-state`
   * `arrivedAt`). A project with no pods counts as idle from then.
   */
  arrivedAt?: number;
  /** Waiting pods in the other projects this runner holds. */
  waiting: WaitingFor[];
}

/**
 * When the runner went idle, or `null` while busy: an agent mid-turn, or a
 * work request queued or working. Never before it arrived on the project, so
 * one with no pods isn't idle forever.
 */
export const idleSince = (
  activity: PodActivity[],
  arrivedAt = 0
): number | null =>
  activity.some((pod) => pod.midTurn || pod.openRequest)
    ? null
    : Math.max(arrivedAt, ...activity.map((pod) => pod.lastActivityAt));

/**
 * The project to switch to, or `null`: only when idle for 5 minutes with
 * another project waiting — the one whose oldest waiting pod is oldest.
 */
export const decideSwitch = (input: SwitchInput): string | null => {
  const since = idleSince(input.activity, input.arrivedAt);

  if (
    since === null ||
    input.now - since < IDLE_MS ||
    input.waiting.length === 0
  ) {
    return null;
  }

  const [oldest] = [...input.waiting].sort((a, b) => a.createdAt - b.createdAt);

  return oldest?.projectId ?? null;
};

export interface SwitchSteps<Intake = unknown> {
  /** `lambda stop` on a folder (never --all: the runner keeps running). */
  stop: (folder: string) => Promise<void>;
  /** `lambda start` on a folder; it ends with `lambda pod resume-all`. */
  start: (folder: string) => Promise<void>;
  /** `lambda pod new` with a waiting pod's intake; answers its id. */
  newPod: (folder: string, intake: Intake) => Promise<string>;
  /** Tell the mothership (runner-state). */
  report: (state: { folder: string | null; switching: string | null }) => void;
}

/**
 * Move from `from` to `to`, then start each waiting pod there. Stop comes
 * before start; stop leaves the old project's pods `active`, so switching
 * back resumes them.
 */
export const runSwitch = async <Intake>(
  steps: SwitchSteps<Intake>,
  from: string | null,
  to: string,
  intakes: Intake[]
): Promise<string[]> => {
  steps.report({ folder: from, switching: to });
  // Where the runner is so far: a failed step reports that, never `to`.
  const at: { folder: string | null } = { folder: from };

  try {
    if (from !== null && from !== to) {
      await steps.stop(from);
      at.folder = null;
    }

    if (from !== to) {
      await steps.start(to);
    }

    at.folder = to;

    // One at a time, in the order they were asked for.
    return await intakes.reduce<Promise<string[]>>(
      async (done, intake) => [...(await done), await steps.newPod(to, intake)],
      Promise.resolve([])
    );
  } finally {
    steps.report({ folder: at.folder, switching: null });
  }
};
