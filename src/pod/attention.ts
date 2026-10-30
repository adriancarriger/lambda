import { formatWire, newId, nowIso } from '../pod-store';
import { openStore } from './context';
import { runChatHandoff } from './fork';
import { agentsHealthy, runResume } from './lifecycle';
import { deliverEntry, sendMessage } from './messaging';
import { ownerForAgent, ownerStartForAgent } from './owner';

/**
 * The two actions behind the inbox's "Your turn" and "Stalled" items.
 * Invariant they serve: a pod either Needs you or is Working — never neither.
 */

export const CARRY_ON = (name?: string): string =>
  `${ownerStartForAgent(
    name
  )} has nothing more to add on this — proceed with your best judgement, and log what you decide with \`lambda pod decide --autonomous\` so it shows at the next checkpoint.`;

/** "Done — carry on": end a back-and-forth; the dev stops waiting on the owner. */
export const runCarryOn = async (podId: string): Promise<void> => {
  // A center action like any answer: the sidebar chat reaches the dev first.
  await runChatHandoff(podId);
  const store = openStore();
  const msgId = newId('m');
  const entry = store.appendThread({
    id: msgId,
    podId,
    from: 'human',
    mode: 'sync',
    text: 'Done — carry on',
    wire: formatWire('/human-chat', { msgId }, CARRY_ON()),
    target: 'dev',
    createdAt: nowIso(),
  });
  await deliverEntry(store, entry);
  console.log(`Told the dev in ${podId} to carry on.`);
};

const NUDGE = (): string => {
  const owner = ownerForAgent();

  return `[Watchdog] Nothing is running in this pod and nothing is waiting on ${owner}. Run \`lambda pod status $POD_ID\`, check the current phase's "done when", and continue the pipeline. If something truly needs ${owner}, ask with \`lambda pod reply --ask\` — never in your pane, where nobody reads it.`;
};

/** "Nudge": wake a stalled pod — restart it if its session is gone. */
export const runNudge = async (podId: string): Promise<void> => {
  // Gone, half-started or doubled: a message can't reach it, so restart it
  // (runResume replaces the session; it never adds to one).
  if (!agentsHealthy(podId)) {
    await runResume(podId);

    return;
  }

  await sendMessage(openStore(), {
    podId,
    target: 'manager',
    command: '',
    text: NUDGE(),
    mode: 'note',
    from: 'system',
  });
  console.log(`Nudged the manager in ${podId}.`);
};
