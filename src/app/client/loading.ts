/** An error's own message: "Leslie's Mac mini is offline.", not "Error: …". */
export const errorText = (caught: unknown): string =>
  caught instanceof Error ? caught.message : String(caught);

export interface LoadTarget<T> {
  value: (value: T) => void;
  /** null once a request succeeds: an old error doesn't sit under good data. */
  error: (message: string | null) => void;
}

/**
 * Loads a page's data, keeping only the newest request's answer: switch
 * projects quickly and the first project's slower answer can't land under
 * the second one's picker.
 */
export const latestLoader = <T>(target: LoadTarget<T>) => {
  const count = { latest: 0 };

  return async (request: Promise<T>): Promise<void> => {
    count.latest += 1;
    const mine = count.latest;

    try {
      const value = await request;

      if (mine === count.latest) {
        target.error(null);
        target.value(value);
      }
    } catch (caught) {
      if (mine === count.latest) {
        target.error(errorText(caught));
      }
    }
  };
};
