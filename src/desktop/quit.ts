/**
 * How the Mac app ends. Closing the window only hides it (the runner keeps
 * working). Quit stops Lambda (`lambda stop --all`) and then quits the
 * ordinary way, so electron-updater can install a downloaded update on the
 * way out. Restart to update stops Lambda the same way, then hands over to
 * `quitAndInstall`, which closes the window and quits: neither is held back.
 * Nor is a shut-down, restart or log-out.
 */

export interface PreventableEvent {
  preventDefault: () => void;
}

export interface QuitDeps {
  /** `lambda stop --all`. */
  stopLambda: () => Promise<void>;
  /** Electron's `app.quit()`: the normal quit, `before-quit` and all. */
  quit: () => void;
  /** electron-updater's `quitAndInstall()`. */
  install: () => void;
}

export interface QuitController {
  /** The window's `close`: hidden unless the app is on its way out. */
  windowClose: (event: PreventableEvent) => 'hide' | 'close';
  /** `app`'s `before-quit` (Cmd-Q, the Dock, a log-out). */
  beforeQuit: (event: PreventableEvent) => void;
  /** Quit Lambda, from the menu. */
  quit: () => Promise<void>;
  /** Restart to update, from the menu. */
  restartToUpdate: () => Promise<void>;
  /** electron-updater's `before-quit-for-update`. */
  quittingForUpdate: () => void;
  /** `powerMonitor`'s `shutdown` (shutting down, restarting, logging out). */
  shutdown: () => void;
}

export const createQuitController = (deps: QuitDeps): QuitController => {
  const state: {
    leaving: boolean;
    stopped: boolean;
    stopping: Promise<void> | null;
  } = { leaving: false, stopped: false, stopping: null };

  // One `lambda stop --all`, however many quits arrive while it runs.
  const stopOnce = async (): Promise<void> => {
    state.leaving = true;
    state.stopping ??= deps.stopLambda().then(() => {
      state.stopped = true;
    });
    await state.stopping;
  };

  const quit = async (): Promise<void> => {
    await stopOnce();
    deps.quit();
  };

  return {
    windowClose: (event) => {
      if (state.leaving) {
        return 'close';
      }

      event.preventDefault();

      return 'hide';
    },
    beforeQuit: (event) => {
      if (state.stopped) {
        return;
      }

      // Lambda stops first; quitting carries on once it has.
      event.preventDefault();
      void quit();
    },
    quit,
    restartToUpdate: async () => {
      await stopOnce();
      deps.install();
    },
    quittingForUpdate: () => {
      state.leaving = true;
    },
    // Holding back a shut-down's quit cancels the shut-down, and the system
    // ends Lambda's processes itself.
    shutdown: () => {
      state.leaving = true;
      state.stopped = true;
    },
  };
};
