import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';

import { api } from './api';
import { toHexBytes } from './keys';
import { terminalErrors } from './terminalErrors';

/**
 * A live view of one agent's tmux pane, for dropping in when something looks
 * off. It polls `tmux capture-pane -e` and redraws; typing goes back as raw
 * bytes via `tmux send-keys -H`, so it works for any agent CLI.
 */
export const TerminalView = ({
  podId,
  window: windowName,
  onError,
  readOnly = false,
}: {
  podId: string;
  window: string;
  /** The page's error line: an offline computer is said, not swallowed. */
  onError: (caught: unknown) => void;
  /** A window that isn't an agent's: watched, never typed into. */
  readOnly?: boolean;
}) => {
  const host = useRef<HTMLDivElement>(null);
  // Through a ref: a new handler mustn't rebuild the terminal.
  const report = useRef(onError);
  report.current = onError;

  useEffect(() => {
    const element = host.current;

    if (element === null) {
      return undefined;
    }

    const terminal = new Terminal({
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: {
        background: '#262624',
        foreground: '#faf9f5',
        cursor: '#faf9f5',
      },
      cols: 120,
      rows: 45,
      // A mirror, not a shell: each frame is the whole pane, so nothing may
      // ever scroll into history (that is what stacked repeated headers).
      scrollback: 0,
      disableStdin: readOnly,
    });
    terminal.open(element);
    const errors = terminalErrors((caught) => report.current(caught));
    // One request per keystroke, strictly in order — concurrent requests can
    // land out of order and submit a half-typed line.
    const queue = { tail: Promise.resolve() };
    const subscription = terminal.onData((data) => {
      if (readOnly) {
        return;
      }

      queue.tail = queue.tail
        .then(() => api.termKeys(podId, windowName, toHexBytes(data)))
        .then(() => undefined)
        .catch(errors.keys);
    });

    const state = { last: '', cols: 0, rows: 0, stopped: false };

    /** The font that fits the pane's width into the panel's. */
    const fitFont = (): void => {
      if (state.cols === 0) {
        return;
      }

      terminal.options.fontSize = Math.max(
        7,
        Math.min(13, Math.floor(element.clientWidth / (state.cols * 0.62)))
      );
    };

    /** Match the pane's size, and shrink the font so its width fits the panel. */
    const fit = (cols: number, rows: number): void => {
      if (cols === state.cols && rows === state.rows) {
        return;
      }

      state.cols = cols;
      state.rows = rows;
      terminal.resize(cols, rows);
      fitFont();
    };

    // The rail is resizable and can expand: refit when it changes width.
    const resized = new ResizeObserver(fitFont);
    resized.observe(element);

    const poll = async (): Promise<void> => {
      if (state.stopped) {
        return;
      }

      try {
        const { screen, cols, rows } = await api.term(podId, windowName);
        errors.polled();
        fit(cols, rows);

        if (screen !== state.last) {
          state.last = screen;
          const lines = screen.replace(/\n$/, '').split('\n').slice(0, rows);
          // Each line is placed on its own row with autowrap off, so a frame
          // can never scroll — the old "same line repeated down the panel".
          const frame = lines
            .map((line, row) => `\x1b[${row + 1};1H\x1b[2K${line}\x1b[0m`)
            .join('');
          terminal.write(`\x1b[?7l\x1b[H\x1b[2J${frame}`);
        }
      } catch (caught) {
        // Window gone (fork closed, pod paused): keep the last frame. A
        // computer gone offline is said (terminalErrors).
        if (!state.stopped) {
          errors.poll(caught);
        }
      }

      setTimeout(() => {
        poll().catch(() => undefined);
      }, 700);
    };
    poll().catch(() => undefined);

    return () => {
      state.stopped = true;
      resized.disconnect();
      subscription.dispose();
      terminal.dispose();
    };
  }, [podId, windowName, readOnly]);

  return <div className="terminal" ref={host} />;
};
