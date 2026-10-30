import { PHASES, phaseName } from '../shared/phases';
import { type PodSummary, isWorking } from '../shared/types';
import { LambdaMark } from './CaughtUp';

/** One line: does the pod need the owner, and what is it doing. */
const leadFor = (summary: PodSummary, answering: boolean): string => {
  const phase = `phase ${summary.pod.phase} (${phaseName(
    summary.pod.phase,
    summary.pod
  )})`;

  // Its items wait while it answers what they asked about one of them.
  if (answering) {
    return "Nothing to review — it's answering your message. Its items come back when it has.";
  }

  if (summary.status === 'needs-you') {
    return summary.needsYou === 1
      ? 'One item is waiting for you in the inbox.'
      : `${summary.needsYou} items are waiting for you in the inbox.`;
  }

  if (
    summary.pod.mode === 'freeform' &&
    summary.status === 'working' &&
    !isWorking(summary)
  ) {
    return 'Nothing to review — it said its piece. Write in the chat whenever you want to carry on.';
  }

  if (summary.pod.mode === 'freeform' && summary.status !== 'done') {
    return "Nothing to review — it's answering your last message. Its reply comes to your inbox.";
  }

  if (summary.request !== undefined) {
    return `Nothing to review — it's working on your request: ${summary.request.summary}. Its items come back when that's done.`;
  }

  if (summary.status === 'working') {
    return summary.liveForks.length > 0
      ? `Nothing to review — you're in a conversation with it about ${phase}.`
      : `Nothing to review — it's working on ${phase}.`;
  }

  if (summary.status === 'stalled') {
    return `Stalled on ${phase}: nobody is working and nothing is waiting on you. Nudge it from the inbox.`;
  }

  if (summary.status === 'waiting-step0') {
    return `Planned and waiting on the step-0 ticket (${
      summary.pod.waitingOnHuman?.ticketId ?? ''
    }) — the held tickets move to your Backlog once it's done.`;
  }

  if (summary.status === 'paused') {
    return `Paused on ${phase}.`;
  }

  return 'Done — every ticket has been handed off.';
};

/**
 * A pod's page when nothing of its is in the inbox: like inbox zero — one
 * line on what it's doing, and the way back to Auto (nothing here is
 * actionable; its items come to the queue when they're ready).
 */
export const PodIdle = ({
  summary,
  answering,
  onAuto,
}: {
  summary: PodSummary | null;
  /** Set aside: busy answering them, so what it has waiting is held back. */
  answering: boolean;
  /** Turn Auto on: go to whatever's waiting, or all caught up. */
  onAuto: () => void;
}) => {
  const purpose =
    summary === null ? undefined : PHASES[summary.pod.phase]?.purpose;
  const showPurpose =
    summary !== null &&
    summary.status !== 'done' &&
    summary.status !== 'waiting-step0' &&
    summary.pod.mode !== 'freeform';

  return (
    <div className="empty">
      {summary !== null && (
        <LambdaMark
          working={
            answering || isWorking(summary) || summary.request !== undefined
          }
        />
      )}
      {summary !== null && (
        <p className="lead">{leadFor(summary, answering)}</p>
      )}
      {showPurpose && purpose !== undefined && (
        <p className="muted empty__detail">{purpose}</p>
      )}
      <button type="button" className="ghost" onClick={onAuto}>
        Turn on Auto
      </button>
    </div>
  );
};
