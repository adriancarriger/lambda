/**
 * Saving as you type, Linear's way: a save goes out once typing has paused,
 * and once more on leaving the box; never two at once, and never a save of
 * what was already saved. Pure: the client bundles this file, and the timer
 * is handed in.
 */

export const AUTOSAVE_PAUSE_MS = 800;

export interface AutosaveTimer {
  set: (run: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

export interface Autosave {
  /** The text now: saved once typing pauses. */
  changed: (text: string) => void;
  /** Leaving the box (or the page): save now if anything is waiting. */
  flush: () => void;
  /** What the server has: a later `changed` back to it saves nothing. */
  saved: (text: string) => void;
  /** Saving or waiting to: the page doesn't overwrite the box meanwhile. */
  busy: () => boolean;
}

export const createAutosave = (
  initial: string,
  save: (text: string) => Promise<void>,
  timer: AutosaveTimer
): Autosave => {
  const state: {
    last: string;
    pending: string | null;
    handle: unknown;
    inFlight: boolean;
  } = { last: initial, pending: null, handle: null, inFlight: false };

  const send = (): void => {
    state.handle = null;
    const text = state.pending;

    if (text === null || state.inFlight) {
      return;
    }

    state.pending = null;

    if (text === state.last) {
      return;
    }

    state.inFlight = true;
    save(text)
      .then(() => {
        state.last = text;

        // Typed while that save was out: send what's newest now.
        return true;
      })
      .catch(() => {
        // Kept for the next pause or leave; never retried in a loop.
        state.pending = state.pending ?? text;

        return false;
      })
      .then((ok) => {
        state.inFlight = false;

        if (ok && state.pending !== null && state.handle === null) {
          send();
        }
      });
  };

  return {
    changed: (text) => {
      state.pending = text;

      if (state.handle !== null) {
        timer.clear(state.handle);
      }

      state.handle = timer.set(send, AUTOSAVE_PAUSE_MS);
    },
    flush: () => {
      if (state.handle !== null) {
        timer.clear(state.handle);
        state.handle = null;
      }

      send();
    },
    saved: (text) => {
      state.last = text;
    },
    busy: () => state.inFlight || state.pending !== null,
  };
};

/**
 * The editor's Markdown, put back the way a person writes it: a bare link or
 * email stays bare (not `[x](x)` or `[x](mailto:x)`), and blocks are one
 * blank line apart.
 */
export const tidyMarkdown = (markdown: string): string =>
  markdown
    .replace(
      /\[([^\]\n]+)\]\((?:mailto:)?([^)\s]+)\)/g,
      (whole, text: string, href: string) => (text === href ? text : whole)
    )
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
