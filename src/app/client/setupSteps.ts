import type { SetupState } from '../../setup/routes';

/** First run's three steps, in order. Small, so the first chunk can ask. */

export type Step = 'claude' | 'project' | 'tickets';

export const STEPS: { step: Step; label: string }[] = [
  { step: 'claude', label: 'Connect Claude' },
  { step: 'project', label: 'Codebase' },
  { step: 'tickets', label: 'Tickets' },
];

export const firstUnfinished = (state: SetupState): Step | null =>
  STEPS.map(({ step }) => step).find((step) => !state.steps[step].done) ?? null;

/**
 * Where a finished step leads: the next step still to do, so redoing one
 * step (Reconnect Claude, Run setup again…) never makes the person redo the
 * others. `null` once nothing is left.
 */
export const stepAfter = (after: Step, state: SetupState): Step | null => {
  const index = STEPS.findIndex(({ step }) => step === after);
  const ahead = STEPS.slice(index + 1).find(
    ({ step }) => !state.steps[step].done
  );

  return ahead?.step ?? firstUnfinished(state);
};

export const setupDone = (state: SetupState): boolean =>
  firstUnfinished(state) === null;
