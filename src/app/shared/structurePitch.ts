import type { Pod } from '../../pod-store';

/**
 * The pitch for structured planning, when a freeform pod's dev proposes it
 * (Pod.structureProposal): what it would plan, and — kept short, like an ad —
 * what happens next. The checkpoints follow the pod's source (see phases.ts:
 * an existing epic or ticket has no checkpoints 1 and 2; a batch's 2 is the
 * triage).
 */

export type StructureProposal = NonNullable<Pod['structureProposal']>;

export const structureWhat = (
  proposal: StructureProposal,
  podLabel: string
): string => {
  if (proposal.source === 'batch') {
    const tickets = proposal.tickets ?? [];

    return `These ${tickets.length} tickets as a batch: ${tickets.join(', ')}`;
  }

  if (proposal.source === 'epic') {
    return `${podLabel}, as the epic ${proposal.epicId ?? ''}`.trim();
  }

  if (proposal.source === 'ticket') {
    return `${podLabel}, as the ticket ${proposal.epicId ?? ''}`.trim();
  }

  return `${podLabel}, as a new idea`;
};

/** Where they step in, in order. */
export const structureCheckpoints = (proposal: StructureProposal): string[] => {
  const rest = [
    'Every screen, before and after',
    'The final plan — then the tickets are marked Planned',
  ];

  if (proposal.source === 'batch') {
    return ['Which tickets stay, merge or leave', ...rest];
  }

  if (proposal.source === 'ticket') {
    return ['Split it, or keep it one ticket', ...rest];
  }

  if (proposal.source === 'epic') {
    return ['The tickets', ...rest];
  }

  return [
    "What it's for",
    'The epic, checked against the code',
    'The tickets',
    ...rest,
  ];
};

export const STRUCTURE_BETWEEN =
  'In between, Lambda does the work: it researches the code, writes the tickets and draws every screen that changes. It brings you each checkpoint when it is ready, and this conversation comes along.';

/** Read aloud, and the card's opening line. */
export const structureSpoken = (
  proposal: StructureProposal,
  podLabel: string
): string =>
  `Ready for structured planning: ${structureWhat(proposal, podLabel)}. ${
    proposal.why
  } You step in at ${
    structureCheckpoints(proposal).length
  } checkpoints to approve or steer. ${STRUCTURE_BETWEEN}`;
