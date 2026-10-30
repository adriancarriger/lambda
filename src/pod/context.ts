import * as path from 'path';

import { podSession } from '../commands/tmux';
import { lambdaHome, loadMachineConfig } from '../config/machineConfig';
import {
  type Project,
  loadProjectConfig,
  resolvePodsRoot,
} from '../config/projectConfig';
import { type Pod } from '../pod-store/schemas';
import { type PodStore, createPodStore } from '../pod-store/store';
import { openTicketSource } from '../tickets/context';
import { type TicketSource } from '../tickets/source';

type Env = Record<string, string | undefined>;

/** The project the current folder belongs to; refused when there is none. */
export const currentProject = (cwd: string = process.cwd()): Project => {
  const project = loadProjectConfig(cwd);

  if (project === null) {
    throw new Error('No codebase here: run lambda init first.');
  }

  return project;
};

/**
 * Where pod state lives: `LAMBDA_PODS_ROOT`, else lambda.json `pods.root`,
 * else `<project>/.lambda/pods`. Agents run inside their pod's worktree, so
 * every agent is launched with LAMBDA_PODS_ROOT pointing back at this one.
 */
export const podsRootFor = (project: Project, env: Env = process.env): string =>
  resolvePodsRoot(project, env);

export const podsRoot = (env: Env = process.env): string => {
  const fromEnv = env.LAMBDA_PODS_ROOT;

  return fromEnv === undefined || fromEnv === ''
    ? podsRootFor(currentProject(), env)
    : path.resolve(fromEnv);
};

/**
 * Where a project's pod worktrees go: `LAMBDA_POD_WORKTREES`, else
 * `<LAMBDA_HOME>/worktrees/<project folder name>`.
 *
 * Worktrees live OUTSIDE the project. Claude Code loads every CLAUDE.md from
 * the cwd up to `/`, so a worktree nested in the project would also load the
 * main checkout's CLAUDE.md, from whatever branch it has checked out, which
 * is exactly what the worktree exists to avoid.
 */
export const worktreeRoot = (
  project: Project,
  env: Env = process.env
): string => {
  const fromEnv = env.LAMBDA_POD_WORKTREES;

  return fromEnv === undefined || fromEnv === ''
    ? path.join(lambdaHome(env), 'worktrees', path.basename(project.root))
    : path.resolve(fromEnv);
};

/** The project's tickets, through whatever tracker it uses. */
export const openTickets = (
  project: Project = currentProject()
): TicketSource => openTicketSource(project, loadMachineConfig());

/** The pod this process belongs to (set for every pod agent at launch). */
export const callerPodId = (): string | undefined => process.env.POD_ID;

/** `manager`, `dev` or `fork-<qid>` for pod agents; undefined for a person. */
export const callerAgent = (): string | undefined => process.env.POD_AGENT;

/**
 * Agents get a store scoped to their own pod, so a dev can never edit another
 * pod's questions. A person (no POD_ID) sees every pod.
 */
export const openStore = (): PodStore =>
  createPodStore(podsRoot(), { scopePodId: callerPodId() });

/** The pod for a pod-scoped command: explicit --pod, else the caller's POD_ID. */
export const resolvePodId = (explicit: string | undefined): string => {
  const podId = explicit ?? callerPodId();

  if (podId === undefined) {
    throw new Error(
      'No pod given. Pass --pod <id> (agents get POD_ID automatically).'
    );
  }

  return podId;
};

/**
 * A pod's tmux session: `lambda-pod-<id>`, never confused with another
 * tool's own sessions — except a building pod in the project's explicit
 * lambda.json `tmux.session`, whose windows sit beside the project's own.
 */
export const podSessionOf = (pod: Pick<Pod, 'id' | 'tmuxSession'>): string =>
  pod.tmuxSession ?? podSession(pod.id);

/**
 * The pods root for `sessionName`: null only when there is no project here
 * (and no LAMBDA_PODS_ROOT), where a pod can only have its own session.
 */
const podsRootIfAny = (): string | null => {
  const fromEnv = process.env.LAMBDA_PODS_ROOT;

  if (fromEnv !== undefined && fromEnv !== '') {
    return path.resolve(fromEnv);
  }

  const project = loadProjectConfig(process.cwd());

  return project === null ? null : podsRootFor(project);
};

/**
 * The session of the pod with this id (read from `store`, else this
 * project's). No project or no record: its own session's name. A record that
 * can't be read is an error, never a guess at the wrong session.
 */
export const sessionName = (podId: string, store?: PodStore): string => {
  const pod = podRecordIfAny(podId, store);

  return pod === null ? podSession(podId) : podSessionOf(pod);
};

/** The pod's record, or null when there is no project or no record. */
const podRecordIfAny = (podId: string, store?: PodStore): Pod | null => {
  const root = store?.root ?? podsRootIfAny();

  if (root === null) {
    return null;
  }

  try {
    return (store ?? createPodStore(root)).readPod(podId);
  } catch (error) {
    throw new Error(
      `Couldn't read pod ${podId} under ${root}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
};

/**
 * The tmux window an agent runs in: its own name, except a building pod's
 * Engineering manager, whose window is `manager` (the window a project's
 * session has always had first: manager, qa, dev).
 */
export const agentWindow = (
  pod: Pick<Pod, 'kind'> | null,
  agent: string
): string =>
  pod?.kind === 'building' && agent === 'engineering-manager'
    ? 'manager'
    : agent;

/** `agentWindow` for the pod with this id. */
export const agentWindowOf = (
  podId: string,
  agent: string,
  store?: PodStore
): string => agentWindow(podRecordIfAny(podId, store), agent);

export const paneTarget = (
  podId: string,
  agent: string,
  store?: PodStore
): string => {
  const pod = podRecordIfAny(podId, store);

  return `${pod === null ? podSession(podId) : podSessionOf(pod)}:${agentWindow(
    pod,
    agent
  )}`;
};
