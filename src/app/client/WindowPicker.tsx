import { useEffect, useState } from 'react';

import type { Panes } from '../shared/types';
import { chosenOption, pickerGroups } from '../shared/windowPicker';
import { TerminalView } from './TerminalView';
import { api } from './api';

/** How often the window list and the working marks are read again. */
const PANES_EVERY_MS = 3000;

/** Per viewer, per project: a convenience, so storage may fail quietly. */
const remembered = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const remember = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private window or blocked storage: it just isn't remembered.
  }
};

/**
 * The Agents panel: one dropdown of the pod's agents (working ● or idle ○),
 * the project's own tmux windows, and, when asked, Lambda's. Only an agent
 * takes typing; the rest are watched. The last pick is kept per project.
 */
export const WindowPicker = ({
  podId,
  project,
  agents,
  labelOf,
  fallback,
  onError,
  onChosen,
}: {
  podId: string;
  /** Whose pick is remembered: the project's id or name. */
  project: string;
  agents: string[];
  labelOf: (window: string) => string;
  /** The agent shown when nothing (still there) was picked. */
  fallback: string;
  onError: (caught: unknown) => void;
  /** The window now on screen, for a parent that adds to it (the dev's box). */
  onChosen?: (window: string) => void;
}) => {
  const pickKey = `lambda:agents-window:${project}`;
  const lambdaKey = `lambda:agents-show-lambda:${project}`;
  const [panes, setPanes] = useState<Panes | null>(null);
  const [picked, setPicked] = useState(() => remembered(pickKey));
  const [showLambda, setShowLambda] = useState(
    () => remembered(lambdaKey) === 'yes'
  );

  useEffect(() => {
    const live = { current: true };

    const read = (): void => {
      api
        .panes(podId)
        .then((next) => {
          if (live.current) {
            setPanes(next);
          }
        })
        // The list is extra: the agents still show without it.
        .catch(() => undefined);
    };

    read();
    const timer = setInterval(read, PANES_EVERY_MS);

    return () => {
      live.current = false;
      clearInterval(timer);
    };
  }, [podId]);

  const groups = pickerGroups({ agents, labelOf, panes, showLambda });
  const active = chosenOption(groups, picked, fallback);

  useEffect(() => {
    if (active !== undefined) {
      onChosen?.(active.value);
    }
  }, [active?.value, onChosen]);

  if (active === undefined) {
    return <p className="rail__empty">Its windows are closed.</p>;
  }

  return (
    <>
      <div className="window-picker">
        <select
          aria-label="Window"
          value={active.value}
          onChange={(event) => {
            setPicked(event.target.value);
            remember(pickKey, event.target.value);
          }}
        >
          {groups.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <label className="window-picker__lambda">
          <input
            type="checkbox"
            checked={showLambda}
            onChange={(event) => {
              setShowLambda(event.target.checked);
              remember(lambdaKey, event.target.checked ? 'yes' : 'no');
            }}
          />
          Show Lambda&rsquo;s windows
        </label>
        {active.readOnly && (
          <span className="window-picker__note">Read-only</span>
        )}
      </div>
      <TerminalView
        key={`${podId}:${active.value}`}
        podId={podId}
        window={active.value}
        readOnly={active.readOnly}
        onError={onError}
      />
    </>
  );
};
