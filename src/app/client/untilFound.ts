import { ServerError } from './api';

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * A pod just made isn't known to the server until its runner reports it, so
 * its page first gets a 404. That is "not yet": ask again for a few seconds
 * before it is an error worth a banner. Any other failure is one at once.
 */
export const untilFound = async <T>(
  get: () => Promise<T>,
  options: { tries?: number; waitMs?: number; wait?: typeof pause } = {}
): Promise<T> => {
  const { tries = 10, waitMs = 500, wait = pause } = options;

  try {
    return await get();
  } catch (error) {
    if (!(error instanceof ServerError) || error.status !== 404 || tries <= 1) {
      throw error;
    }

    await wait(waitMs);

    return untilFound(get, { tries: tries - 1, waitMs, wait });
  }
};
