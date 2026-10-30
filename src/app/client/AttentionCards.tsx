import type { Pod, Question } from '../../pod-store';
import { itemTitle } from '../shared/items';
import { podName } from '../shared/podName';

/**
 * "Your turn" in the Plan rail: the dev asked the owner something and waits on
 * their reply. The question itself is the newest message in the chat beside
 * this, so the rail doesn't repeat it: one line saying so, and the pod's
 * open items, a click away.
 */
export const YourTurnCard = ({
  pod,
  open,
  onOpen,
}: {
  pod: Pod;
  /** The pod's open questions and checkpoints. */
  open: Question[];
  onOpen: (qid: string) => void;
}) => (
  <article className="card">
    <div className="card__meta">
      <span className="kind">Your turn</span>
      <span>{podName(pod)}</span>
    </div>
    <p className="lead your-turn__lead">
      The dev asked you something — it&apos;s the latest message in the chat.
      Reply there, or press Done to let it carry on.
    </p>
    {open.length > 0 && (
      <section className="pod-panel pod-items">
        <h3>Open items</h3>
        <ul>
          {open.map((question) => (
            <li key={question.id}>
              <button
                type="button"
                className="link-button"
                onClick={() => onOpen(question.id)}
              >
                {itemTitle(question)}
              </button>
            </li>
          ))}
        </ul>
      </section>
    )}
  </article>
);

/**
 * "Stalled": the watchdog could not get the pod moving. With a `reason` it
 * names what a human must do (a permission prompt, the usage limit, a hang);
 * without one, nobody is working and nothing is waiting on the owner.
 */
export const StalledCard = ({
  pod,
  running,
  reason,
  position,
}: {
  pod: Pod;
  running: boolean;
  reason?: string;
  position: string;
}) => (
  <article className="card">
    <div className="card__meta">
      <span className="kind">Stalled</span>
      <span>{podName(pod)}</span>
      <span className="card__position">{position}</span>
    </div>
    <section className="section section--playing">
      <header>
        <h3>
          {reason === undefined
            ? 'Nobody is working on this'
            : 'This Lambda needs a hand'}
        </h3>
      </header>
      <p className="lead">{stalledLead(pod, running, reason)}</p>
    </section>
  </article>
);

const stalledLead = (
  pod: Pod,
  running: boolean,
  reason: string | undefined
): string => {
  if (reason !== undefined) {
    return /permission answer/.test(reason)
      ? `${reason}. Answer it in the agent's pane (the Dev / Manager tabs); a nudge can't.`
      : `${reason}.`;
  }

  return running
    ? `Both the manager and the dev have been idle for over five minutes, and nothing is waiting on you. A nudge tells the manager to check where phase ${pod.phase} stands and carry on.`
    : 'Its agents are not running (the session ended or the machine restarted without resuming it). A nudge resumes both, with their conversations intact.';
};
