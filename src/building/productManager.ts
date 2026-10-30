import * as fs from 'fs';
import * as path from 'path';

import { stepDisplayName } from '../app/shared/buildTimeline';
import { currentRun } from '../app/shared/building';
import {
  type Pod,
  type PodStore,
  nowIso,
  podKindOf,
  releaseLock,
  sessionOf,
  tryLock,
  writeJsonAtomic,
} from '../pod-store';
import { openStore, sessionName } from '../pod/context';
import { PRODUCT_MANAGER_SETTINGS, launchAgent } from '../pod/launch';
import { sendMessage } from '../pod/messaging';
import { ownerForAgent } from '../pod/owner';
import { hasWindow, killWindow } from '../pod/tmux';
import { lambdaPackageDir } from '../process/workflow-file';
import { buildingSteps } from './workflow';

/**
 * A building pod's Product manager: the owner's one conversation with the
 * pod. It reads everything and changes nothing (its settings), asks the
 * Engineering manager or the dev through read-only forks (`lambda pod
 * ask`), and relays the owner's calls (`lambda pod relay`). It starts on the
 * owner's first chat message, briefed with where the pod is; after 30 quiet
 * minutes it sleeps (its window closed, its Claude session kept) and the
 * next message resumes it.
 */

export const PM_IDLE_MS = 30 * 60_000;

export const PRODUCT_MANAGER = 'product-manager';

export const productManagerInstructions = (): string =>
  path.join(
    lambdaPackageDir(),
    'instructions',
    'building',
    'product-manager.md'
  );

/**
 * The settings a Product manager outside any pod runs with (a ticket's
 * summary, written on the runner): `<pods root>/_product-manager/settings.json`.
 */
export const writeProductManagerSettings = (podsRoot: string): string => {
  const file = path.join(podsRoot, '_product-manager', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, PRODUCT_MANAGER_SETTINGS);

  return file;
};

/** "✓ Pick up → ✓ Build → ● Test · attempt 2 → ○ Ship". */
const workflowLine = (store: PodStore, pod: Pod): string => {
  const run = currentRun(store.readBuilding(pod.id));
  const steps = buildingSteps(pod.devCwd);
  const at =
    run === null ? -1 : steps.findIndex((step) => step.id === run.step);

  return steps
    .map((step, index) => {
      const name = stepDisplayName(step.id);

      if (run === null || index > at) {
        return `○ ${name}`;
      }

      return index < at
        ? `✓ ${name}`
        : `● ${name}${run.attempt > 1 ? ` · attempt ${run.attempt}` : ''}`;
    })
    .join(' → ');
};

export const productManagerBrief = (store: PodStore, pod: Pod): string => {
  const state = store.readBuilding(pod.id);
  const run = currentRun(state);
  const notes = store
    .readThread(pod.id)
    .filter((message) => message.from === 'engineering-manager')
    .slice(-10)
    .map((message) => `- ${message.text.replace(/\s+/g, ' ').trim()}`);
  const owner = ownerForAgent();

  return [
    `You are the PRODUCT MANAGER of building pod ${
      pod.id
    }. Read ${productManagerInstructions()} now and follow it for the rest of this session; where it says {owner}, that is ${owner}.`,
    '',
    run === null
      ? `Current ticket: none${
          state.idleReason === undefined ? '' : ` (${state.idleReason})`
        }.`
      : `Current ticket: ${run.id} ${run.title} — ${stepDisplayName(
          run.step
        )}, attempt ${run.attempt}.`,
    `Workflow: ${workflowLine(store, pod)}`,
    `Up next: ${
      state.upNext.length === 0
        ? 'nothing'
        : state.upNext
            .map((ticket) => `${ticket.id} ${ticket.title}`)
            .join(', ')
    }`,
    '',
    "The Engineering manager's last 10 messages:",
    ...(notes.length === 0 ? ['- (none yet)'] : notes),
  ].join('\n');
};

/**
 * One message at a time wakes and briefs the Product manager. Starting it
 * takes seconds (its window waits for Claude to be ready), and two messages
 * close together (a chat and "Talk about this ticket", each its own process)
 * once opened two windows on one Claude session. So a lock file in the pod
 * folder, held from the window check to the delivered message: the one that
 * waits then finds it awake and started.
 */
const START_LOCK = 'pm-start.lock';
const START_LOCK_STALE_MS = 10 * 60_000;
const START_LOCK_WAIT_MS = 2 * 60_000;
const START_LOCK_POLL_MS = 250;

/**
 * A stale lock is moved aside atomically, so of two messages that both found
 * it stale only one takes it; and each lets go of its own lock only.
 */
const takeStartLock = (
  store: PodStore,
  podId: string
): (() => void) | undefined => {
  const lock = store.file(podId, START_LOCK);
  const token = tryLock(lock, START_LOCK_STALE_MS);

  return token === false ? undefined : () => releaseLock(lock, token);
};

export const withStartLock = async (
  store: PodStore,
  podId: string,
  work: () => Promise<void>
): Promise<void> => {
  const since = Date.now();
  const take = async (): Promise<() => void> => {
    const release = takeStartLock(store, podId);

    if (release !== undefined) {
      return release;
    }

    if (Date.now() - since > START_LOCK_WAIT_MS) {
      throw new Error(
        `The Product manager of ${podId} is still starting. Try again in a minute.`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, START_LOCK_POLL_MS));

    return take();
  };
  const release = await take();

  try {
    await work();
  } finally {
    release();
  }
};

/**
 * The owner's chat message to the Product manager: woken first if it's
 * asleep (or started, the first time, with its brief), then delivered.
 */
export const runPmChat = async (
  podId: string,
  text: string,
  options: {
    store?: PodStore;
    /** What a fresh Product manager is told first (default: the pod's state). */
    brief?: string;
  } = {}
): Promise<void> => {
  const store = options.store ?? openStore();
  const pod = store.requirePod(podId);

  if (podKindOf(pod) !== 'building') {
    throw new Error(`${podId} isn't a building pod. Use lambda pod chat.`);
  }

  if (text.trim() === '') {
    throw new Error('Say something to the Product manager.');
  }

  await withStartLock(store, podId, async () => {
    // Read under the lock: a message that waited finds it awake and started.
    const startedBefore =
      store.readBuilding(podId).productManager !== undefined;
    const awake = hasWindow(sessionName(podId, store), PRODUCT_MANAGER);

    if (!awake) {
      await launchAgent({
        pod,
        store,
        agent: PRODUCT_MANAGER,
        cwd: pod.devCwd,
        mode: {
          kind: startedBefore ? 'resume' : 'fresh',
          sessionId: sessionOf(pod, PRODUCT_MANAGER),
        },
      });
    }

    await sendMessage(store, {
      podId,
      target: PRODUCT_MANAGER,
      command: '',
      text,
      wireText: startedBefore
        ? text
        : `${
            options.brief ?? productManagerBrief(store, pod)
          }\n\n${ownerForAgent()} says: ${text}`,
      mode: 'sync',
      from: 'human',
    });
    store.updateBuilding(podId, (state) => ({
      ...state,
      productManager: { awake: true, lastActivityAt: nowIso() },
    }));
  });
};

/**
 * 30 quiet minutes: close its window, keep its session. Whether it slept.
 * Under the start lock, with the state read inside it: a message waking it
 * holds the lock from the window check to its `awake: true`, so this never
 * closes a window just opened or writes `awake: false` over it. While a
 * message holds the lock it isn't idle, and the next watch tries again.
 */
export const sleepIdleProductManager = (
  store: PodStore,
  podId: string,
  now: number = Date.now()
): boolean => {
  const release = takeStartLock(store, podId);

  if (release === undefined) {
    return false;
  }

  try {
    const pm = store.readBuilding(podId).productManager;

    if (
      pm === undefined ||
      !pm.awake ||
      now - Date.parse(pm.lastActivityAt) < PM_IDLE_MS
    ) {
      return false;
    }

    killWindow(`=${sessionName(podId, store)}:=${PRODUCT_MANAGER}`);
    store.updateBuilding(podId, (state) => ({
      ...state,
      productManager: { awake: false, lastActivityAt: pm.lastActivityAt },
    }));

    return true;
  } finally {
    release();
  }
};
