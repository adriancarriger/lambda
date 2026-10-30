/**
 * Waiting for a section's clip. No timeout and no other voice (see
 * usePlayer.ts): wait as long as the render takes, and when a clip comes back
 * unavailable — a failed render, a Kokoro worker that restarted — ask again
 * `retries` more times, `gapMs` apart. Null means it really can't be had.
 */
export const waitForClip = async <T>(
  first: Promise<T | null>,
  args: {
    again: () => Promise<T | null>;
    retries: number;
    gapMs: number;
    sleep: (ms: number) => Promise<unknown>;
    /** The listener moved on (stop, seek, another item): stop asking. */
    cancelled: () => boolean;
  }
): Promise<T | null> => {
  const ready = await first;

  if (ready !== null || args.retries === 0 || args.cancelled()) {
    return ready;
  }

  await args.sleep(args.gapMs);

  if (args.cancelled()) {
    return null;
  }

  return waitForClip(args.again(), { ...args, retries: args.retries - 1 });
};
