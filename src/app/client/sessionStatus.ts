import type { Session } from './api';

export type Status =
  | { kind: 'checking' }
  | { kind: 'out' }
  | { kind: 'unreachable' }
  | { kind: 'in'; session: Session };

/**
 * What the session check means for the first screen. A 401 (no session) is
 * the sign-in screen; a failed check (the mothership down, a 500) is not, as
 * a code can't help with that.
 */
export const sessionStatus = (
  outcome: { session: Session | null } | { error: unknown }
): Status => {
  if ('error' in outcome) {
    return { kind: 'unreachable' };
  }

  return outcome.session === null
    ? { kind: 'out' }
    : { kind: 'in', session: outcome.session };
};
