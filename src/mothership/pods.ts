import type { PodIntake, PodSnapshot } from '../app/shared/snapshot';
import type {
  AppState,
  InboxEntry,
  PodSummary,
  TimeSummary,
  TtsStatus,
  WaitingPod,
} from '../app/shared/types';
import type { Question } from '../pod-store';
import { randomId } from './crypto';
import type { Db } from './db';
import type { Owner } from './owner';
import {
  type ProjectRow,
  getRunner,
  holdings,
  lastUsedProject,
  listProjects,
  listRunners,
  projectOfFolder,
} from './registry';
import { computerIdentities } from './trackers';

/**
 * The mothership's `pods` table: each pod's latest snapshot from its runner,
 * and pods waiting for a computer. `GET /api/state` is built from it, so the
 * inbox shows even while a runner is offline.
 */

interface WaitingState {
  waiting: {
    intake: PodIntake;
    title: string;
    createdAt: string;
    /** Its last start failed: not tried again before then (epoch ms). */
    retryAt?: number;
    /** Why its last start failed. */
    error?: string;
  };
}

type StoredState = PodSnapshot | WaitingState;

interface PodRow {
  id: string;
  project_id: string | null;
  runner_id: string | null;
  state_json: string;
  updated_at: number;
  /** When a runner claimed this waiting row; NULL once it started. */
  claimed_at: number | null;
}

/** A row with its state parsed: each read parses a row once. */
interface StoredPod {
  row: PodRow;
  state: StoredState;
}

const isWaiting = (state: StoredState): state is WaitingState =>
  'waiting' in state;

/** Every row, or one runner's (`pods_runner`), oldest change first. */
const readPods = (db: Db, runnerId?: string): StoredPod[] =>
  (runnerId === undefined
    ? db.prepare<[], PodRow>('SELECT * FROM pods ORDER BY updated_at').all()
    : db
        .prepare<[string], PodRow>(
          'SELECT * FROM pods WHERE runner_id = ? ORDER BY updated_at'
        )
        .all(runnerId)
  ).map((row) => ({ row, state: JSON.parse(row.state_json) }));

/** Store a runner's pushed snapshots for one of its folders. */
export const storeSnapshots = (
  db: Db,
  runnerId: string,
  folder: string,
  pods: PodSnapshot[],
  removed: string[],
  now: number,
  all?: string[]
): void => {
  const projectId = projectOfFolder(db, runnerId, folder);

  db.transaction(() => {
    pods.forEach((snapshot) =>
      db
        .prepare(
          `INSERT INTO pods (id, project_id, runner_id, state_json, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET project_id = excluded.project_id, runner_id = excluded.runner_id,
             state_json = excluded.state_json, updated_at = excluded.updated_at`
        )
        .run(snapshot.podId, projectId, runnerId, JSON.stringify(snapshot), now)
    );
    removed.forEach((podId) =>
      db
        .prepare('DELETE FROM pods WHERE id = ? AND runner_id = ?')
        .run(podId, runnerId)
    );

    if (all !== undefined && projectId !== null) {
      // A waiting row this runner has claimed isn't one of its pods yet.
      readPods(db, runnerId)
        .filter(
          ({ row, state }) =>
            row.project_id === projectId &&
            !all.includes(row.id) &&
            !isWaiting(state)
        )
        .forEach(({ row }) =>
          db.prepare('DELETE FROM pods WHERE id = ?').run(row.id)
        );
    }
  })();
};

export interface PodLocation {
  podId: string;
  runnerId: string;
  projectId: string;
  /** The project's folder on that runner. */
  folder: string;
}

/**
 * Which runner has the pod, and in which folder. `null` for a pod the
 * mothership has never seen (or one still waiting for a computer).
 */
export const locatePod = (db: Db, podId: string): PodLocation | null => {
  const row = db
    .prepare<
      [string],
      { id: string; project_id: string; runner_id: string; folder: string }
    >(
      `SELECT pods.id, pods.project_id, pods.runner_id, runner_projects.folder FROM pods
       JOIN runner_projects ON runner_projects.runner_id = pods.runner_id AND runner_projects.project_id = pods.project_id
       WHERE pods.id = ?`
    )
    .get(podId);

  return row === undefined
    ? null
    : {
        podId: row.id,
        runnerId: row.runner_id,
        projectId: row.project_id,
        folder: row.folder,
      };
};

/** A project's running pods' snapshots, each with the runner it is on. */
export const projectSnapshots = (
  db: Db,
  projectId: string
): { runnerId: string; snapshot: PodSnapshot }[] =>
  db
    .prepare<[string], PodRow>(
      'SELECT * FROM pods WHERE project_id = ? AND runner_id IS NOT NULL ORDER BY updated_at'
    )
    .all(projectId)
    .flatMap((row) => {
      const state: StoredState = JSON.parse(row.state_json);

      return isWaiting(state) || row.runner_id === null
        ? []
        : [{ runnerId: row.runner_id, snapshot: state }];
    });

/**
 * One runner's snapshots, each with its pod's project: what the idle switch
 * and the Computers screen read.
 */
export const snapshotsOf = (
  db: Db,
  runnerId: string
): { projectId: string | null; snapshot: PodSnapshot }[] =>
  readPods(db, runnerId).flatMap(({ row, state }) =>
    isWaiting(state) ? [] : [{ projectId: row.project_id, snapshot: state }]
  );

export const titleOf = (text: string): string => {
  const line = text.trim().split('\n')[0] ?? '';

  return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'New Lambda';
};

/** Keep a pod for later: no runner of its project is on it yet. */
export const addWaitingPod = (
  db: Db,
  projectId: string,
  intake: PodIntake,
  now: number
): string => {
  const id = randomId('wait');
  const state: WaitingState = {
    waiting: {
      intake,
      title: titleOf(intake.text),
      createdAt: new Date(now).toISOString(),
    },
  };
  db.prepare(
    'INSERT INTO pods (id, project_id, runner_id, state_json, updated_at) VALUES (?, ?, NULL, ?, ?)'
  ).run(id, projectId, JSON.stringify(state), now);

  return id;
};

export interface WaitingRow {
  id: string;
  projectId: string;
  intake: PodIntake;
  title: string;
  createdAt: number;
  /** Set once a runner has claimed it: it waits only for its first state. */
  runnerId: string | null;
  /** After a failed start: not tried again before this (epoch ms). */
  retryAt: number | null;
  /** Why its last start failed. */
  error: string | null;
}

const waitingOf = (pods: StoredPod[]): WaitingRow[] =>
  pods.flatMap(({ row, state }) =>
    isWaiting(state) && row.project_id !== null
      ? [
          {
            id: row.id,
            projectId: row.project_id,
            intake: state.waiting.intake,
            title: state.waiting.title,
            createdAt: Date.parse(state.waiting.createdAt),
            runnerId: row.runner_id,
            retryAt: state.waiting.retryAt ?? null,
            error: state.waiting.error ?? null,
          },
        ]
      : []
  );

/** Every waiting row, started or not: what the sidebar shows. */
export const waitingPods = (db: Db): WaitingRow[] => waitingOf(readPods(db));

/**
 * The waiting rows no runner has claimed, past any retry delay: what the idle
 * switch starts.
 */
export const unstartedWaitingPods = (db: Db, now: number): WaitingRow[] =>
  waitingPods(db).filter(
    (row) =>
      row.runnerId === null && (row.retryAt === null || row.retryAt <= now)
  );

/**
 * Claim waiting rows for one runner before it's asked to start them, so two
 * idle runners holding the project can't both start the same pod. Answers
 * the ids this runner got.
 */
export const claimWaitingPods = (
  db: Db,
  runnerId: string,
  ids: string[],
  now: number
): string[] =>
  db.transaction(() =>
    ids.filter(
      (id) =>
        db
          .prepare(
            'UPDATE pods SET runner_id = ?, claimed_at = ? WHERE id = ? AND runner_id IS NULL'
          )
          .run(runnerId, now, id).changes === 1
    )
  )();

/**
 * A claimed row its runner didn't start: it waits again, and isn't tried
 * before `retryAt` (a start that timed out may still have made the pod).
 */
export const releaseWaitingPod = (
  db: Db,
  waitingId: string,
  failure: { error: string; retryAt: number },
  now: number
): void => {
  const row = db
    .prepare<[string], { state_json: string }>(
      'SELECT state_json FROM pods WHERE id = ?'
    )
    .get(waitingId);
  const state: StoredState | null =
    row === undefined ? null : JSON.parse(row.state_json);

  if (state === null || !isWaiting(state)) {
    return;
  }

  const next: WaitingState = { waiting: { ...state.waiting, ...failure } };
  db.prepare(
    'UPDATE pods SET runner_id = NULL, claimed_at = NULL, state_json = ?, updated_at = ? WHERE id = ?'
  ).run(JSON.stringify(next), now, waitingId);
};

/**
 * Claims no switch is working on: only the process that claimed a row
 * starts it, so a claim it isn't working on is one a mothership stopped
 * mid-switch left behind, and would hold its pod forever. Each waits again
 * like a failed start (it may have started: its first state still lands).
 * Not by age: a switch starts its pods one after another, each allowed
 * SWITCH_TIMEOUT_MS, so a live claim can be older than that. Answers how
 * many were released.
 */
export const releaseStrandedClaims = (
  db: Db,
  working: (runnerId: string) => boolean,
  failure: { error: string; retryAt: number },
  now: number
): number =>
  db.transaction(() => {
    // Only a claimed, unstarted waiting row has a claimed_at: no parsing.
    const stranded = db
      .prepare<[], { id: string; runner_id: string }>(
        'SELECT id, runner_id FROM pods WHERE claimed_at IS NOT NULL AND runner_id IS NOT NULL'
      )
      .all()
      .filter((row) => !working(row.runner_id));
    stranded.forEach((row) => releaseWaitingPod(db, row.id, failure, now));

    return stranded.length;
  })();

/**
 * A waiting pod has started on a runner as `podId`: the waiting row becomes
 * that pod's row, and takes its state. If the runner's first state for it
 * already arrived (its own row), that state moves into the waiting row and
 * the extra row goes; otherwise the next `pod-state` fills it in. Answers
 * false when the waiting row was no longer there to take.
 */
export const adoptWaitingPod = (
  db: Db,
  waitingId: string,
  podId: string,
  runnerId: string,
  now: number
): boolean =>
  db.transaction(() => {
    // Already taken (or gone): the pod's own row is all it has, so it stays.
    const waiting = db
      .prepare<[string], { id: string }>('SELECT id FROM pods WHERE id = ?')
      .get(waitingId);

    if (waiting === undefined) {
      return false;
    }

    const arrived = db
      .prepare<[string, string], { state_json: string }>(
        'SELECT state_json FROM pods WHERE id = ? AND id <> ?'
      )
      .get(podId, waitingId);

    if (arrived !== undefined) {
      db.prepare('DELETE FROM pods WHERE id = ?').run(podId);
    }

    db.prepare(
      'UPDATE pods SET id = ?, runner_id = ?, claimed_at = NULL, state_json = COALESCE(?, state_json), updated_at = ? WHERE id = ?'
    ).run(podId, runnerId, arrived?.state_json ?? null, now, waitingId);

    return true;
  })();

/** "Waiting: Leslie's MacBook is busy on Pawnee Parks site". */
export const waitingLabel = (
  computer: string | null,
  busyOn: string | null
): string =>
  computer === null
    ? 'Waiting for a computer'
    : busyOn === null
    ? `Waiting: ${computer} is getting ready`
    : `Waiting: ${computer} is busy on ${busyOn}`;

const projectOrder = (projects: ProjectRow[]): Map<string, number> =>
  new Map(projects.map((project, index) => [project.id, index]));

/**
 * Auto's order across every Lambda: a build blocker first (a computer sits
 * idle until it's answered), then a review waiting on the owner, then
 * everything else in the order it came (the sidebar's priority).
 */
export const autoOrder = (entries: InboxEntry[]): InboxEntry[] => {
  const rank = (entry: InboxEntry): number =>
    entry.tag === 'blocked' ? 0 : entry.tag === 'review' ? 1 : 2;

  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
    .map(({ entry }) => entry);
};

/**
 * `GET /api/state`: every pod from every runner, grouped by project (in name
 * order), each project's pods in its own priority order. Stalled items come
 * last, as on one machine.
 */
export const buildAppState = (
  db: Db,
  options: {
    owner: Owner;
    time: TimeSummary;
    tts: TtsStatus | undefined;
    /** The connected runner a waiting pod's label names, by project. */
    busyRunnerFor: (projectId: string) => string | null;
    /** Is this runner's socket open? Every runner reads as offline without. */
    isConnected?: (runnerId: string) => boolean;
  }
): AppState => {
  const projects = listProjects(db);
  const held = holdings(db);
  const order = projectOrder(projects);
  const stored = readPods(db);
  const snapshots = stored.flatMap(({ row, state }) =>
    isWaiting(state) ? [] : [{ row, snapshot: state }]
  );
  const sorted = [...snapshots].sort(
    (a, b) =>
      (order.get(a.row.project_id ?? '') ?? projects.length) -
        (order.get(b.row.project_id ?? '') ?? projects.length) ||
      a.snapshot.rank - b.snapshot.rank ||
      a.snapshot.summary.pod.createdAt.localeCompare(
        b.snapshot.summary.pod.createdAt
      )
  );
  const entries: InboxEntry[] = autoOrder(
    sorted.flatMap(({ snapshot }) =>
      snapshot.inbox.filter((entry) => entry.kind !== 'stalled')
    )
  );
  const stalled: InboxEntry[] = sorted.flatMap(({ snapshot }) =>
    snapshot.inbox.filter((entry) => entry.kind === 'stalled')
  );
  const pods: PodSummary[] = sorted.map(({ snapshot }) => snapshot.summary);
  const questions: Record<string, Question[]> = Object.fromEntries(
    sorted.map(({ snapshot }) => [snapshot.podId, snapshot.questions])
  );
  const waiting: WaitingPod[] = waitingOf(stored).map((row) => {
    const runnerId = options.busyRunnerFor(row.projectId);
    const runner = runnerId === null ? null : getRunner(db, runnerId);
    const busyOn =
      runner?.currentProjectId === null ||
      runner?.currentProjectId === undefined
        ? null
        : projects.find((project) => project.id === runner.currentProjectId)
            ?.name ?? null;

    return {
      id: row.id,
      projectId: row.projectId,
      title: row.title,
      label: waitingLabel(runner?.name ?? null, busyOn),
      createdAt: new Date(row.createdAt).toISOString(),
      ...(row.error === null || row.retryAt === null
        ? {}
        : {
            failure: {
              error: row.error,
              retryAt: new Date(row.retryAt).toISOString(),
            },
          }),
    };
  });

  const identities = computerIdentities(db);

  return {
    pods,
    inbox: [...entries, ...stalled],
    questions,
    priority: sorted.map(({ snapshot }) => snapshot.podId),
    ...(options.tts === undefined ? {} : { tts: options.tts }),
    time: options.time,
    lambda: {
      owner: { name: options.owner.name, initials: options.owner.initials },
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        ticketPrefix: project.ticketPrefix,
      })),
      lastProjectId: lastUsedProject(db)?.id ?? null,
      podProjects: Object.fromEntries(
        sorted.flatMap(({ row, snapshot }) =>
          row.project_id === null ? [] : [[snapshot.podId, row.project_id]]
        )
      ),
      podComputers: Object.fromEntries(
        sorted.flatMap(({ row, snapshot }) => {
          const runner =
            row.runner_id === null ? null : getRunner(db, row.runner_id);

          return runner === null ? [] : [[snapshot.podId, runner.name]];
        })
      ),
      waiting,
      computers: listRunners(db).map((runner) => ({
        name: runner.name,
        connected: options.isConnected?.(runner.id) ?? false,
        lastSeenAt: runner.lastSeenAt,
        projectIds: held
          .filter((holding) => holding.runnerId === runner.id)
          .map((holding) => holding.projectId),
        trackers: (
          identities.find((one) => one.runnerId === runner.id)?.identities ?? []
        ).map((identity) => identity.tracker),
      })),
    },
  };
};
