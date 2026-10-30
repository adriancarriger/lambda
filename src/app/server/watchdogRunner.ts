import * as fs from 'fs';

import { type PodStore, nowIso } from '../../pod-store';
import type { AppState } from '../shared/types';
import { buildState } from './state';
import {
  type Agent,
  type Episode,
  MAX_NUDGES,
  type PodSignals,
  judge,
} from './watchdog';

/**
 * Runs the watchdog (./watchdog.ts) over every pod: gathers each pod's
 * signals, nudges through `lambda pod nudge`, and keeps the escalations the inbox
 * shows as Stalled. Every action is logged to the pod's steps.jsonl (by
 * `watchdog`), so the workflow panel shows what it did.
 */

const mtime = (file: string): number | undefined => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
};

/** Escalations that differ only in their counts are the same one. */
export const sameEscalation = (a: string, b: string): boolean =>
  a.replace(/\d+/g, '#') === b.replace(/\d+/g, '#');

export const createWatchdogRunner = (deps: {
  store: PodStore;
  windowsFor: (podId: string) => string[];
  /** The agent's visible pane (only read while it is mid-turn). */
  capture: (podId: string, agent: Agent) => string;
  nudge: (podId: string) => Promise<unknown>;
  /** Re-send a thread message by id (`lambda pod deliver`). */
  resend: (podId: string, msgId: string) => Promise<unknown>;
  onChange: () => void;
}) => {
  const episodes = new Map<string, Episode>();
  const escalated = new Map<string, string>();

  const note = (podId: string, text: string): void => {
    deps.store.appendStep(podId, {
      at: nowIso(),
      step: 'watchdog',
      event: 'note',
      by: 'watchdog',
      note: text,
    });
  };

  const signalsFor = (state: AppState, podId: string): PodSignals => {
    const pod = deps.store.requirePod(podId);
    const turns = {
      manager: deps.store.readTurn(podId, 'manager'),
      dev: deps.store.readTurn(podId, 'dev'),
    };
    const busy = (agent: Agent): boolean => {
      const turn = turns[agent];

      return (turn.startedAt ?? '') > (turn.endedAt ?? '');
    };

    return {
      pod,
      running: deps.windowsFor(podId).length > 0,
      hasInboxItems: state.inbox.some(
        (entry) => entry.podId === podId && entry.kind !== 'stalled'
      ),
      turns,
      thread: deps.store.readThread(podId),
      questions: deps.store.listQuestions(podId),
      steps: deps.store.readSteps(podId),
      // The file the agent is really writing, as its hook reports it. After a
      // resume or fork that is NOT the pod's original session file — which
      // goes quiet and would make a busy dev look hung. Unknown until
      // the agent's next hook: no hang check rather than a wrong one.
      transcriptAt: {
        manager:
          turns.manager.transcriptPath === undefined
            ? undefined
            : mtime(turns.manager.transcriptPath),
        dev:
          turns.dev.transcriptPath === undefined
            ? undefined
            : mtime(turns.dev.transcriptPath),
      },
      screens: {
        manager: busy('manager') ? deps.capture(podId, 'manager') : undefined,
        dev: busy('dev') ? deps.capture(podId, 'dev') : undefined,
      },
    };
  };

  const tick = (now: number = Date.now()): void => {
    const state = buildState(deps.store, deps.windowsFor);
    const changed = deps.store
      .listPodIds()
      // A building pod has its own stall watch, on its runner.
      .filter((podId) => deps.store.readPod(podId)?.kind !== 'building')
      .map((podId): boolean => {
        const { verdict, episode } = judge(
          signalsFor(state, podId),
          episodes.get(podId),
          now
        );

        if (episode === undefined) {
          episodes.delete(podId);
        } else {
          episodes.set(podId, episode);
        }

        if (verdict.kind === 'nudge') {
          note(
            podId,
            `Nudged the manager (${verdict.attempt} of ${MAX_NUDGES}): nothing was running and nothing was waiting on you.`
          );
          deps
            .nudge(podId)
            .catch((error: unknown) =>
              note(podId, `Nudge failed: ${String(error).slice(0, 200)}`)
            );
        }

        if (verdict.kind === 'resend') {
          note(
            podId,
            `Re-sent ${verdict.msgIds.length} message(s) an idle agent never took in.`
          );
          verdict.msgIds.forEach((msgId) =>
            deps
              .resend(podId, msgId)
              .catch((error: unknown) =>
                note(
                  podId,
                  `Re-send of ${msgId} failed: ${String(error).slice(0, 200)}`
                )
              )
          );

          return false;
        }

        if (verdict.kind === 'escalate') {
          const previous = escalated.get(podId);
          escalated.set(podId, verdict.reason);

          // "…for 17 minutes…" then "…for 18 minutes…" is one escalation, not
          // a new one a minute.
          if (
            previous !== undefined &&
            sameEscalation(previous, verdict.reason)
          ) {
            return false;
          }

          note(podId, `Sent to your inbox: ${verdict.reason}.`);

          return true;
        }

        // Moving again (or waiting between nudges): no longer the owner's.
        return verdict.kind === 'ok' && escalated.delete(podId);
      })
      .some(Boolean);

    if (changed) {
      deps.onChange();
    }
  };

  return {
    tick,
    escalated: (): ReadonlyMap<string, string> => escalated,
  };
};
