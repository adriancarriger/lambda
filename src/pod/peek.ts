import { callerPodId, openStore, resolvePodId, sessionName } from './context';
import { capturePane } from './tmux';

/**
 * `lambda pod peek <window>`: what a pod window shows, and nothing else. It
 * only captures. The Product manager reads panes this way because its
 * settings deny all of `lambda tmux`: permission rules match by prefix, so a
 * capture (`lambda tmux dev`) and a send (`lambda tmux dev "…"`) can't be
 * told apart there.
 */
export const runPeek = (
  window: string,
  options: { pod?: string; lines?: number },
  print: (text: string) => void = (text) => process.stdout.write(text)
): void => {
  const lines = options.lines ?? 60;

  // `--lines abc` is NaN, and tmux would get `-S -NaN`.
  if (!Number.isInteger(lines) || lines < 1) {
    throw new Error('--lines must be a positive whole number.');
  }

  const podId = resolvePodId(options.pod ?? callerPodId());
  const store = openStore();
  store.requirePod(podId);
  // Exact names: tmux would otherwise take `d` for `dev`, or another
  // session whose name only starts with this pod's.
  print(capturePane(`=${sessionName(podId, store)}:=${window}`, lines));
};
