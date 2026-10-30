import {
  agentWindowOf,
  callerPodId,
  openStore,
  resolvePodId,
  sessionName,
} from './context';
import { sendMessage } from './messaging';
import { hasWindow } from './tmux';

/**
 * `lambda pod relay "<decision>"`: the Product manager hands the owner's
 * call to the Engineering manager, through the pod's ordinary delivery,
 * prefixed so the Engineering manager knows it's the owner's call. It
 * confirms with `lambda pod reply --fyi`, which shows in the chat.
 */

export const RELAY_PREFIX = 'From the owner, via the Product manager:';

export const PAUSED = 'This pod is paused. Resume it first, then ask again.';

export const runRelay = async (
  decision: string,
  options: { pod?: string }
): Promise<void> => {
  const podId = resolvePodId(options.pod ?? callerPodId());
  const store = openStore();
  const pod = store.requirePod(podId);

  if (decision.trim() === '') {
    throw new Error('Say what the owner decided.');
  }

  if (pod.status === 'done') {
    throw new Error('This pod has ended, so there is no one to relay to.');
  }

  if (
    pod.status !== 'active' ||
    !hasWindow(
      sessionName(podId, store),
      agentWindowOf(podId, 'engineering-manager', store)
    )
  ) {
    throw new Error(PAUSED);
  }

  const entry = await sendMessage(store, {
    podId,
    target: 'engineering-manager',
    command: '',
    text: `${RELAY_PREFIX} ${decision.trim()}`,
    mode: 'note',
    from: 'product-manager',
  });
  console.log(`Relayed ${entry.id} to the Engineering manager.`);
};
