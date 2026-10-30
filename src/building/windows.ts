import { execFileSync } from 'child_process';

import { hasSession } from '../pod/tmux';

/**
 * In a project's shared `tmux.session` a window named `dev` or `qa` may be
 * the project's own (a pod adopts one already there). The windows a pod opens
 * there carry its id in this tmux user option, and only those are closed.
 */
export const POD_WINDOW_OPTION = '@lambda-pod';

/** `list-windows -F`: each window's name and its pod, tab-separated. */
export const POD_WINDOW_FORMAT = `#{window_name}\t#{${POD_WINDOW_OPTION}}`;

/**
 * The pod's windows in a `POD_WINDOW_FORMAT` listing: only the ones tagged
 * with its id (every window the pod launches there is). An untagged window,
 * whatever it's called, is the project's.
 */
export const podWindowsOf = (listing: string, podId: string): string[] =>
  listing
    .split('\n')
    .filter((line) => line !== '')
    .flatMap((line) => {
      const [name = '', tag = ''] = line.split('\t');

      return tag === podId ? [name] : [];
    });

export const tagPodWindow = (
  session: string,
  window: string,
  podId: string
): void => {
  execFileSync(
    'tmux',
    [
      'set-option',
      '-w',
      '-t',
      `=${session}:=${window}`,
      POD_WINDOW_OPTION,
      podId,
    ],
    { stdio: 'ignore' }
  );
};

/** The pod a window is tagged with; '' when it's untagged or gone. */
export const windowTag = (session: string, window: string): string => {
  try {
    return execFileSync(
      'tmux',
      [
        'show-options',
        '-w',
        '-v',
        '-t',
        `=${session}:=${window}`,
        POD_WINDOW_OPTION,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
  } catch {
    return '';
  }
};

/** None when the session isn't running (nothing of the pod's is open). */
export const listPodWindows = (session: string, podId: string): string[] =>
  hasSession(session)
    ? podWindowsOf(
        execFileSync(
          'tmux',
          ['list-windows', '-t', `=${session}`, '-F', POD_WINDOW_FORMAT],
          { encoding: 'utf8' }
        ),
        podId
      )
    : [];
