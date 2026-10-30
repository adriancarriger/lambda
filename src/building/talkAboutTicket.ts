import { randomUUID } from 'crypto';
import * as path from 'path';

import { type Pod, type PodStore, nowIso, podKindOf } from '../pod-store';
import { withFileLock } from '../pod-store/store';
import { currentProject, openStore, openTickets } from '../pod/context';
import { writePodSettings } from '../pod/launch';
import { ownerForAgent } from '../pod/owner';
import { runChat } from '../pod/questions';
import { type TicketSource, assertTicketId } from '../tickets/source';
import { freshPodId } from './lifecycle';
import {
  PRODUCT_MANAGER,
  productManagerInstructions,
  runPmChat,
} from './productManager';

/**
 * `lambda pod talk-ticket <ticket-id> -- <text>`, the Tickets screen's "Talk
 * about this ticket": a conversation with the ticket in hand. It goes to the
 * project's building pod's Product manager, or to the planning dev while the
 * ticket is still in planning. With neither, it starts a one-shot Product
 * manager: a pod with only that window, briefed with the ticket, read-only
 * like any Product manager, and asleep after 30 quiet minutes. Nothing is
 * edited from here. Prints `{"podId", "target"}` as its last line.
 */

const isLive = (pod: Pod): boolean => pod.status !== 'done';

/** Is this ticket one this planning pod is planning? */
const plans = (store: PodStore, pod: Pod, ticketId: string): boolean =>
  pod.epicId === ticketId ||
  (pod.tickets ?? []).includes(ticketId) ||
  store
    .listQuestions(pod.id)
    .some((question) =>
      (question.checkpoint?.planTickets ?? []).some(
        (planned) => planned.id === ticketId
      )
    );

const ticketBrief = async (
  source: TicketSource,
  ticketId: string,
  podId: string
): Promise<string> => {
  const ticket = await source.get(ticketId);

  return [
    `You are the PRODUCT MANAGER in a conversation about one ticket (pod ${podId}). Read ${productManagerInstructions()} now and follow it; where it says {owner}, that is ${ownerForAgent()}. No building pod is working on this project, so there is no one to ask or relay to: read, and answer.`,
    '',
    `The ticket: ${ticket.id} ${ticket.title} (${ticket.status})`,
    '',
    ticket.description,
  ].join('\n');
};

/** Long enough to find or write one pod; a dead writer's lock is taken over. */
const TALK_LOCK = { timeoutMs: 10_000, staleMs: 30_000 };

/** `<pods root>/_talk-<ticket>.lock`: held while its talk pod is found or made. */
export const talkLockFile = (store: PodStore, ticketId: string): string =>
  path.join(store.root, `_talk-${assertTicketId(ticketId)}`);

/**
 * A conversation about one ticket, with nobody else in it. Two clicks at
 * once find or make it one at a time, so they share one pod.
 */
const talkPodFor = (
  store: PodStore,
  ticketId: string,
  root: string,
  randomHex?: () => string
): Pod =>
  withFileLock(talkLockFile(store, ticketId), TALK_LOCK, () =>
    findOrMakeTalkPod(store, ticketId, root, randomHex)
  );

const findOrMakeTalkPod = (
  store: PodStore,
  ticketId: string,
  root: string,
  randomHex?: () => string
): Pod => {
  const existing = store
    .listPodIds()
    .map((id) => store.readPod(id))
    .find(
      (pod): pod is Pod =>
        pod !== null && isLive(pod) && pod.talk?.ticketId === ticketId
    );

  if (existing !== undefined) {
    return existing;
  }

  const id = freshPodId(store, 'talk', randomHex);
  const pod: Pod = {
    id,
    slug: 'talk',
    title: `About ${ticketId}`,
    createdAt: nowIso(),
    status: 'active',
    phase: 1,
    completedCheckpoints: [],
    worktreePath: root,
    ownsWorktree: false,
    managerCwd: root,
    devCwd: root,
    agentCommand: 'claude',
    sessions: { [PRODUCT_MANAGER]: randomUUID() },
    kind: 'building',
    talk: { ticketId },
  };
  store.writePod(pod);
  writePodSettings(store, id, { projectRoot: root, cli: undefined });

  return pod;
};

export const runTalkTicket = async (
  ticketId: string,
  text: string,
  deps: {
    store?: PodStore;
    source?: TicketSource;
    print?: (line: string) => void;
    /** The project's checkout: where a one-shot Product manager reads. */
    projectRoot?: string;
    /** A new pod id's random part (default: 4 random hex digits). */
    randomHex?: () => string;
  } = {}
): Promise<void> => {
  const store = deps.store ?? openStore();
  const source = deps.source ?? openTickets();
  const print = deps.print ?? ((line: string) => console.log(line));
  const about = `About ticket ${ticketId}: ${text.trim()}`;
  const pods = store
    .listPodIds()
    .map((id) => store.readPod(id))
    .filter((pod): pod is Pod => pod !== null && isLive(pod));
  // Still in planning: the planning dev has it in hand, building pod or not.
  const planning = pods.find(
    (pod) =>
      podKindOf(pod) === 'planning' &&
      pod.status === 'active' &&
      plans(store, pod, ticketId)
  );

  if (planning !== undefined) {
    await runChat(planning.id, about);
    print(JSON.stringify({ podId: planning.id, target: 'dev' }));

    return;
  }

  const building = pods.find(
    (pod) => podKindOf(pod) === 'building' && pod.talk === undefined
  );

  if (building !== undefined) {
    const ticket = await source.get(ticketId);
    await runPmChat(
      building.id,
      `About ticket ${ticket.id} ${ticket.title}: ${text.trim()}`,
      { store }
    );
    print(JSON.stringify({ podId: building.id, target: PRODUCT_MANAGER }));

    return;
  }

  const pod = talkPodFor(
    store,
    ticketId,
    deps.projectRoot ?? currentProject().root,
    deps.randomHex
  );
  await runPmChat(pod.id, about, {
    store,
    brief: await ticketBrief(source, ticketId, pod.id),
  });
  print(JSON.stringify({ podId: pod.id, target: PRODUCT_MANAGER }));
};
