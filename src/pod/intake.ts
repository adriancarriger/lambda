import { type TicketsConfig } from '../config/projectConfig';
import { type Pod, newId, nowIso, stagesFor } from '../pod-store';
import { findEpic } from '../tickets/epic';
import { type TicketSource, unknownTicketMessage } from '../tickets/source';
import { callerAgent, openStore, openTickets } from './context';
import { sendMessage } from './messaging';
import { ownerForAgent, ownerStartForAgent, ownersForAgent } from './owner';
import { podTicketIds, startPlanning } from './planningStatus';

/**
 * "+ New pod" is one text box: the owner types or pastes anything — an idea,
 * a ticket, an epic, a list of bugs — and the pod works out what it is. Ticket
 * ids are read here, not by an agent, so the track is right from the start:
 *   - no id → a new idea;
 *   - one id → that epic (it has children) or lone ticket;
 *   - several → a batch, one ticket each (unless `single`: then the first is
 *     the subject and the rest are context in the owner's words).
 *
 * Ids are kept exactly as the ticket interface returns them: a markdown id is
 * a file name, so changing its case would lose the file on a case-sensitive
 * disk.
 */
export interface Intake {
  source: NonNullable<Pod['source']>;
  epicId?: string;
  tickets?: string[];
  /** A first name for the pod, until the dev names it properly. */
  title: string;
  /** For the pod id: short and readable. */
  slug: string;
}

/**
 * `PAWNEE-12`, `dog-park-3`: words joined by `-`, ending in a number, and a
 * sub-ticket's `PAWNEE-2a`.
 */
const TICKET_ID = /\b([A-Za-z][A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*-\d+[a-z]?)\b/g;

/** The ids in the text, in order, each once (ignoring case). */
export const ticketIds = (text: string): string[] =>
  Array.from(text.matchAll(TICKET_ID), (match) => match[1] ?? '').filter(
    (id, index, all) =>
      all.findIndex((other) => other.toLowerCase() === id.toLowerCase()) ===
      index
  );

export const ticketNotFound = (id: string): Error =>
  new Error(`ticket ${id} not found. Nothing was created.`);

/** `PAWNEE-12` and `PAWNEE-2a` → `PAWNEE`, `dog-park-3` → `dog-park`: the id without its number. */
const stemOf = (id: string): string => id.replace(/-\d+[a-z]?$/, '');

/** The keys the project's tracker writes its ids with: prefix, team, project. */
export const configuredTicketKeys = (
  tickets: Pick<TicketsConfig, 'prefix' | 'team' | 'project'> | undefined
): string[] =>
  [tickets?.prefix, tickets?.team, tickets?.project].filter(
    (key): key is string => key !== undefined && key !== ''
  );

/**
 * Which of the id-shaped words in the box are meant as ticket ids. The shape
 * alone can't tell: `Windows-11`, `x86-64` and `follow-up-2` look like ids.
 * The decision: a word is an id when the part before its number is one of the
 * project's own keys — the configured `prefix`, or the tracker's `team` or
 * `project` key (any case), or, when none is configured, the stem of a ticket the
 * project has (`dog-park` from `dog-park-3`). So an id that looks like the
 * project's but doesn't exist (`PAWNEE-99`, `dog-park-99`) still fails loudly
 * before anything is created, and ordinary words stay part of the idea. The
 * cost: with no key configured, a typo in a stem (`dog-prak-3`) is read as
 * words, not refused. `--ticket` and `--epic` are always looked up as given.
 */
const meantAsIds = async (
  candidates: string[],
  source: TicketSource,
  keys: string[]
): Promise<string[]> => {
  if (candidates.length === 0) {
    return [];
  }

  const stems =
    keys.length > 0
      ? keys
      : (await source.list()).map((ticket) => stemOf(ticket.id));
  const known = new Set(stems.map((stem) => stem.toLowerCase()));

  return candidates.filter((id) => known.has(stemOf(id).toLowerCase()));
};

/**
 * One ticket and its children, read through the ticket interface's epic
 * lookup, or `ticket <id> not found. Nothing was created.`
 */
export const lookUpTicket = async (
  source: TicketSource,
  id: string
): Promise<{ id: string; title: string; children: string[] }> => {
  try {
    return await findEpic(source, id.trim());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (
      message === unknownTicketMessage(id.trim()) ||
      message.includes("isn't a ticket id")
    ) {
      throw ticketNotFound(id.trim());
    }

    throw error;
  }
};

/** Images the owner attached arrive as `[Image: /path]` lines — not words. */
const withoutImages = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !/^\[Image: \S+\]$/.test(line.trim()))
    .join('\n');

/** The first few words of the idea, for its name until the dev renames it. */
const firstWords = (text: string): string => {
  const words = withoutImages(text)
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 6);

  return words.join(' ') || 'New pod';
};

/**
 * What the one box is about. Every id in it (see `meantAsIds`) is read
 * before anything is created, so an id that isn't a real ticket fails here.
 * `keys`: the project's id keys (`configuredTicketKeys`).
 */
export const readIntake = async (
  text: string,
  single: boolean,
  source: TicketSource,
  keys: string[] = []
): Promise<Intake> => {
  const ids = await meantAsIds(ticketIds(withoutImages(text)), source, keys);
  const found = await ids.reduce<
    Promise<Array<{ id: string; title: string; children: string[] }>>
  >(async (previousPromise, id) => {
    const previous = await previousPromise;

    return [...previous, await lookUpTicket(source, id)];
  }, Promise.resolve([]));
  const tickets = found.filter(
    (ticket, index) =>
      found.findIndex((other) => other.id === ticket.id) === index
  );

  if (tickets.length > 1 && !single) {
    return {
      source: 'batch',
      tickets: tickets.map((ticket) => ticket.id),
      title: `Batch of ${tickets.length} tickets`,
      slug: `batch-${tickets.length}`,
    };
  }

  const [first] = tickets;

  if (first === undefined) {
    return { source: 'idea', title: firstWords(text), slug: firstWords(text) };
  }

  return {
    source: first.children.length > 0 ? 'epic' : 'ticket',
    epicId: first.id,
    title: first.title,
    slug: first.id,
  };
};

/** What the dev is told first, in the owner's words plus what was read. */
export const openingMessage = (pod: Pod, text: string): string => {
  const words = text.trim();
  const theirs = words === '' ? '' : `\n\nWhat I wrote: ${words}`;

  if (pod.mode === 'freeform') {
    return words;
  }

  if (pod.source === 'batch') {
    return `Please plan these ${
      pod.tickets?.length ?? 0
    } existing tickets as a batch — each one a lone ticket, no epic, nothing split: ${(
      pod.tickets ?? []
    ).join(', ')}.${theirs}`;
  }

  if (pod.source === 'ticket') {
    return `Please plan the existing ticket ${
      pod.epicId ?? ''
    } — a lone ticket: don't create a new epic. Propose a split anyway (the split proposal, CP3); I'll choose between keeping one ticket and the split.${theirs}`;
  }

  if (pod.source === 'epic') {
    return `Please plan the existing epic ${
      pod.epicId ?? ''
    } — don't create a new one.${theirs}`;
  }

  return words === '' ? '' : `Here is my idea for this pod: ${words}`;
};

// ── freeform → structured ────────────────────────────────────────────────────

/** What --epic / --ticket / --batch name, if any. */
const structureTarget = (options: {
  epic?: string;
  ticket?: string;
  batch?: string;
}): Pick<Pod, 'source' | 'epicId' | 'tickets'> | undefined => {
  const batch = options.batch
    ?.split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');

  if (batch !== undefined) {
    return { source: 'batch', tickets: batch, epicId: undefined };
  }

  if (options.epic !== undefined) {
    return { source: 'epic', epicId: options.epic.trim() };
  }

  return options.ticket === undefined
    ? undefined
    : { source: 'ticket', epicId: options.ticket.trim() };
};

/**
 * The dev of a freeform pod thinks it's ready for the structured flow: it
 * says how (an epic, a lone ticket, a batch, or a new idea) and why, and the
 * proposal comes up in the owner's inbox. Only the owner starts it. Proposing
 * again replaces the last proposal.
 */
export const runProposeStructure = async (
  podId: string,
  options: { epic?: string; ticket?: string; batch?: string; why: string }
): Promise<void> => {
  const store = openStore();
  const pod = store.requirePod(podId);

  if (pod.mode !== 'freeform') {
    throw new Error(`Pod ${podId} is already on the structured flow.`);
  }

  if (
    [options.epic, options.ticket, options.batch].filter(
      (value) => value !== undefined
    ).length > 1
  ) {
    throw new Error('Pass one of --epic, --ticket or --batch.');
  }

  const why = options.why.trim();

  if (why === '') {
    throw new Error('--why: say in a sentence or two why it is ready now.');
  }

  const target = structureTarget(options);
  store.updatePod(podId, (current) => ({
    ...current,
    structureProposal: {
      source: target?.source ?? 'idea',
      epicId: target?.epicId,
      tickets: target?.tickets,
      why,
      at: new Date().toISOString(),
    },
  }));
  console.log(
    `Proposed: ${
      target === undefined
        ? 'structured planning of this idea'
        : `structured planning of ${
            target.epicId ?? (target.tickets ?? []).join(', ')
          } (${target.source ?? 'idea'})`
    }. It's in ${ownersForAgent()} inbox; ${ownerForAgent()} starts it, or keeps talking.`
  );
};

/**
 * "Switch to structured": the conversation so far becomes Shape's starting
 * point. Same dev session, so nothing is lost; the dev writes intent.md from
 * the talk and confirms rather than re-asks. One way only.
 */
export const runStructure = async (
  podId: string,
  options: { epic?: string; ticket?: string; batch?: string }
): Promise<void> => {
  const store = openStore();
  const pod = store.requirePod(podId);

  if (pod.mode !== 'freeform') {
    throw new Error(`Pod ${podId} is already on the structured flow.`);
  }

  const given = [options.epic, options.ticket, options.batch].filter(
    (value) => value !== undefined
  );

  if (given.length > 1) {
    throw new Error('Pass one of --epic, --ticket or --batch.');
  }

  // Nothing named: what the dev proposed, when it did.
  const proposal = pod.structureProposal;
  const target: Pick<Pod, 'source' | 'epicId' | 'tickets'> =
    given.length === 0 && proposal !== undefined
      ? {
          source: proposal.source,
          epicId: proposal.epicId,
          tickets: proposal.tickets,
        }
      : structureTarget(options) ?? {
          source: pod.source,
          epicId: pod.epicId,
          tickets: pod.tickets,
        };

  const updated = store.updatePod(podId, (current) => ({
    ...current,
    ...target,
    source: target.source ?? 'idea',
    mode: 'structured',
    phase: 1,
    structureProposal: undefined,
  }));

  await startPlanning(() => openTickets(), podTicketIds(updated));
  await sendMessage(store, {
    podId,
    target: 'manager',
    command: '/pod-structured',
    text: `${ownerStartForAgent()} switched this pod from a freeform conversation to the structured flow (${
      updated.source ?? 'idea'
    }${
      updated.epicId === undefined && updated.tickets === undefined
        ? ''
        : `: ${updated.epicId ?? (updated.tickets ?? []).join(', ')}`
    }).`,
    mode: 'note',
    from: 'system',
  });
  console.log(
    `Pod ${podId} is on the structured flow now (${updated.source ?? 'idea'}).`
  );
};

// ── skipping a stage ─────────────────────────────────────────────────────────

/**
 * The owner skips a stage (the workflow panel's "Skip", or "skip research"
 * said to the pod — then the dev runs this with the owner's words). Recorded
 * as the owner's decision; the manager passes the stage by, and a skipped
 * checkpoint counts as closed.
 */
export const runSkip = async (
  podId: string,
  stageId: string,
  options: { quote?: string }
): Promise<void> => {
  const store = openStore();
  const pod = store.requirePod(podId);
  const agent = callerAgent();

  if (agent !== undefined && (options.quote ?? '').trim() === '') {
    throw new Error(
      `Only ${ownerForAgent()} skips a stage. Relaying ${ownersForAgent()} words? Pass --quote "<exactly what ${ownerForAgent()} said>".`
    );
  }

  const stage = stagesFor(pod).find((candidate) => candidate.id === stageId);

  if (stage === undefined) {
    throw new Error(
      `No stage "${stageId}" on this pod. Its stages: ${Array.from(
        new Set(stagesFor(pod).map((candidate) => candidate.id))
      ).join(', ')}.`
    );
  }

  if ((pod.skipped ?? []).includes(stageId)) {
    console.log(`${stage.label} is already skipped.`);

    return;
  }

  store.updatePod(podId, (current) => ({
    ...current,
    skipped: [...(current.skipped ?? []), stageId],
  }));
  store.appendHumanDecision({
    id: newId('d'),
    podId,
    decision: `Skip ${stage.label}`,
    quote: options.quote?.trim() || `Skipped "${stage.label}" in the inbox.`,
    createdAt: nowIso(),
  });
  await sendMessage(store, {
    podId,
    target: 'manager',
    command: '/pod-skip',
    text: SKIPPED(stage.label, stageId),
    mode: 'note',
    from: 'system',
  });
  console.log(`Skipped ${stage.label}.`);
};

/** What the manager is told when the owner skips a stage. */
export const SKIPPED = (
  label: string,
  stageId: string,
  name?: string
): string => `${ownerStartForAgent(name)} skipped ${label} (${stageId}).`;

/**
 * A batch's ticket list after the triage: the duplicates merged away and the
 * tickets pulled out into their own pod leave it; the order is the plan's.
 */
export const runSetTickets = (podId: string, ids: string[]): void => {
  const tickets = ids
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value !== '');

  if (tickets.length === 0) {
    throw new Error('A batch needs at least one ticket.');
  }

  const pod = openStore().updatePod(podId, (current) => {
    if (current.source !== 'batch') {
      throw new Error(`Pod ${podId} is not a batch.`);
    }

    return { ...current, tickets };
  });
  console.log(`Pod ${pod.id} plans ${tickets.join(', ')}.`);
};
