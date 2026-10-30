import { ServerError } from './api';

/**
 * What the terminal says when it can't reach the pane. A keystroke that
 * didn't land is always said ("Leslie's Mac mini is offline."), or typing
 * would vanish into a pane that looks alive. A poll the server refused is
 * said once, until a frame lands again (it polls every 700 ms). The runner's
 * own refusal (400: the window is gone, the fork closed, the pod paused) and
 * a request that died on the way stay quiet: the last frame stays up.
 */
export const terminalErrors = (report: (caught: unknown) => void) => {
  const state = { said: false };

  return {
    keys: (caught: unknown): void => report(caught),
    poll: (caught: unknown): void => {
      if (
        state.said ||
        !(caught instanceof ServerError) ||
        caught.status === 400
      ) {
        return;
      }

      state.said = true;
      report(caught);
    },
    /** A frame landed: the next refusal is news again. */
    polled: (): void => {
      state.said = false;
    },
  };
};
