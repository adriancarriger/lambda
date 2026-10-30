/** Reconnect delays: 1 s, doubling, at most 30 s. */
export const FIRST_DELAY_MS = 1000;
export const MAX_DELAY_MS = 30_000;

/** The delay before reconnect number `attempt` (0 for the first). */
export const reconnectDelay = (attempt: number): number =>
  Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** attempt);

/**
 * The drops-in-a-row counter: each drop moves it on, a connect that
 * completes its handshake resets it.
 */
export const createBackoff = () => {
  const state = { attempt: 0 };

  return {
    /** The delay for this drop, and move on. */
    next: (): number => {
      const delay = reconnectDelay(state.attempt);
      state.attempt += 1;

      return delay;
    },
    reset: (): void => {
      state.attempt = 0;
    },
  };
};
