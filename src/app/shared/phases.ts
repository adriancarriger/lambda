/**
 * What each pipeline phase is for, in plain words — shown as a tooltip
 * wherever the UI names a phase or checkpoint. Display only: never read aloud.
 * Keep in step with the package's `instructions/planning/pod-phase.md`.
 */
export const PHASES: Record<number, { name: string; purpose: string }> = {
  1: {
    name: 'Shape',
    purpose:
      'A conversation with you to pin down the idea, then the epic is written (or an existing epic is read). Ends at checkpoint 1.',
  },
  2: {
    name: 'Epic review',
    purpose:
      'The epic is checked against the real code for wrong assumptions and gaps (red-flags, up to 2 passes). Ends at checkpoint 2.',
  },
  3: {
    name: 'Split',
    purpose:
      'The epic is split into numbered child tickets, each gets a UX sketch, all are checked together for red flags (up to 3 passes), and anything only you can do goes into a step-0 ticket. Ends at checkpoint 3 (the tickets), then checkpoint 4 (the UX review: every screen before and after, with its edge cases).',
  },
  4: {
    name: 'Fill',
    purpose:
      'Each child gets its E2E test plan and a quality review. New test files need your OK. No checkpoint.',
  },
  5: {
    name: 'Reconcile',
    purpose:
      'All the tickets are read fresh for contradictions with each other, and checked again for anything only you can do. Ends at checkpoint 5, then the tickets move to Ready: the build queue.',
  },
};

/**
 * Pipeline 2 (pods created from 2026-10-07): phase 3 is research, the split
 * proposal, the tickets and the UX review; an existing epic or lone ticket
 * has no CP1/CP2. Pods without `pipeline` keep the original wording above.
 */
const PHASES_2: Record<number, { name: string; purpose: string }> = {
  1: {
    name: 'Shape',
    purpose:
      'A conversation with you to pin down the idea, then the epic is written — or an existing epic or lone ticket is read. A new idea ends at checkpoint 1; an existing epic or ticket has no checkpoint here.',
  },
  2: {
    name: 'Review',
    purpose:
      'The epic (or ticket) is checked against the real code for wrong assumptions and gaps (red-flags, up to 2 passes). A new idea ends at checkpoint 2; an existing epic or ticket has no checkpoint here.',
  },
  3: {
    name: 'Research & tickets',
    purpose:
      'Deep research grounds the work in the codebase; when there is something to split you approve a proposed split (checkpoint 3: the tickets, where in the code, and the E2E structure) before any ticket is written. Then the tickets are written, sketched and checked, and you review every screen (checkpoint 4, the UX review).',
  },
  4: PHASES[4] ?? { name: 'Fill', purpose: '' },
  5: {
    name: 'Reconcile',
    purpose:
      'All the tickets are read fresh for contradictions, checked again for anything only you can do, and checked the way the build pipeline will check them. Ends at checkpoint 5, then the tickets move to Ready: the build queue.',
  },
};

/** What `trackOf` (pod-store) needs, without importing the store into the client. */
export interface PodTrack {
  pipeline?: number;
  source?: 'idea' | 'epic' | 'ticket' | 'batch';
  mode?: 'freeform' | 'structured';
}

/** A batch's phase 2 is the triage, not an epic review. */
const BATCH_TRIAGE = {
  name: 'Triage',
  purpose:
    'Each ticket is read against the code: plan it, already fixed, a duplicate, too big, or the wrong lane. You settle it at checkpoint 2, then the survivors get a red-flags review each.',
};

const isCurrent = (pod: PodTrack | undefined): boolean =>
  pod?.pipeline !== undefined;

const phasesFor = (pod: PodTrack | undefined) =>
  !isCurrent(pod)
    ? PHASES
    : pod?.source === 'batch'
    ? { ...PHASES_2, 2: BATCH_TRIAGE }
    : PHASES_2;

const CHECKPOINT_PHASE: Record<number, number> = {
  1: 1,
  2: 2,
  3: 3,
  4: 3,
  5: 5,
};

export const phaseName = (phase: number, pod?: PodTrack): string =>
  phasesFor(pod)[phase]?.name ?? '';

export const phaseTip = (phase: number, pod?: PodTrack): string => {
  const entry = phasesFor(pod)[phase];

  return entry === undefined
    ? ''
    : `Phase ${phase} — ${entry.name}: ${entry.purpose}`;
};

export const checkpointTip = (cp: number, pod?: PodTrack): string => {
  if (cp === 2 && pod?.source === 'batch') {
    return 'Checkpoint 2 is the triage: one row per ticket with what the dev proposes — plan it, already fixed (you close those yourself), merge a duplicate, pull it out, or change its lane. Say which rows to change, then close it.';
  }

  if (cp === 3 && isCurrent(pod)) {
    return 'Checkpoint 3 is the split proposal: the proposed tickets before any is written — what each changes, where in the code, and the E2E structure (how many new spec files). Approve or change it; then the tickets are written.';
  }

  if (cp === 4) {
    return isCurrent(pod)
      ? 'Checkpoint 4 is the UX review: every screen that changes, before and after — opening with what the dev understood you want and what changed since the split. Settled before the test plans are written.'
      : 'Checkpoint 4 is the UX review: every screen that changes, before and after, with its states and edge cases — settled before the test plans are written.';
  }

  if (cp === 5 && isCurrent(pod)) {
    return 'Checkpoint 5 is the final check before the tickets move to Ready — opening with what changed since the UX review (when there was one).';
  }

  const phase = CHECKPOINT_PHASE[cp];

  return phase === undefined
    ? ''
    : `Checkpoint ${cp} closes phase ${phase} (${phaseName(phase, pod)}). ${
        phasesFor(pod)[phase]?.purpose ?? ''
      }`;
};

/** A lone ticket's split proposal closes two ways: the split, or one ticket. */
export const offersKeepOne = (cp: number, pod?: PodTrack): boolean =>
  cp === 3 && pod?.source === 'ticket';

export interface CheckpointGoal {
  /** What this checkpoint is for — and what it is not for yet. */
  goal: string;
  /** What closing it approves ("the ticket structure"). */
  approves: string;
}

/**
 * The goal banner at the top of a checkpoint (read aloud first) and what its
 * approve button says. So the owner knows what to judge here — and what to leave
 * for later (a batch's CP2 is triage, not "decide each ticket").
 */
export const checkpointGoal = (cp: number, pod?: PodTrack): CheckpointGoal => {
  if (cp === 2 && pod?.source === 'batch') {
    return {
      goal: "Triage only — the shape of the batch: which tickets stay, which merge, which leave for their own pod, and which change lane. Don't judge how to fix them yet: the dev hasn't researched them, and those questions come after research.",
      approves: 'the ticket structure',
    };
  }

  if (cp === 1) {
    return {
      goal: "What this work is for — the problem, who it's for, and what's out of scope. Not the tickets yet.",
      approves: "the epic's intent",
    };
  }

  if (cp === 2) {
    return {
      goal: 'The epic itself — its scope and the questions it raised. The tickets come next.',
      approves: 'the epic',
    };
  }

  if (offersKeepOne(cp, pod)) {
    return {
      goal: 'Whether to split this ticket. Accept the proposed split, and the ticket becomes an epic with these tickets under it; or keep it one ticket and the proposal is dropped.',
      approves: 'the split',
    };
  }

  if (cp === 3) {
    return {
      goal: 'The split — which tickets, what each one changes, and the E2E structure. Not the detail inside each ticket: that is written next.',
      approves: 'the split',
    };
  }

  if (cp === 4) {
    return {
      goal: 'How each screen changes, before and after, with its states. Not the wording of every ticket.',
      approves: 'the UX',
    };
  }

  return {
    goal: 'The final plan, as written in the tickets — everything you approved so far. Closing it moves them to Ready.',
    approves: 'the final plan',
  };
};

export const approveLabel = (cp: number, pod?: PodTrack): string =>
  offersKeepOne(cp, pod)
    ? `Accept the split — close checkpoint ${cp}`
    : `Approve ${checkpointGoal(cp, pod).approves} — close checkpoint ${cp}`;
