import type { LaunchItem } from '../shared/caughtUp';

/** The λ, faint; it breathes while a Lambda is working. */
export const LambdaMark = ({ working }: { working: boolean }) => (
  <svg
    className={`lambda-mark${working ? ' lambda-mark--working' : ''}`}
    viewBox="0 0 32 32"
    width="40"
    height="40"
    aria-hidden="true"
  >
    <path d="M9 6.5c3 0 4.2 1.6 5.4 4.4L21 25.5h3" />
    <path d="M15.4 14.2L8.5 25.5" />
  </svg>
);

const names = (titles: string[]): string =>
  titles.length <= 3
    ? titles.join(' · ')
    : `${titles.slice(0, 3).join(' · ')} · +${titles.length - 3} more`;

/**
 * Nothing needs the owner: Auto comes here only after every build blocker,
 * review, checkpoint, reply and stalled Lambda. One line of where things
 * stand, then only what they could do, never what waits on them.
 */
export const CaughtUp = ({
  line,
  items,
  working,
  onNew,
  onPlan,
  onResume,
  onReassign,
}: {
  /** "2 planning · 11 building · 4 queued". */
  line: string;
  items: LaunchItem[];
  /** Anything mid-turn: the λ breathes. */
  working: boolean;
  onNew: () => void;
  onPlan: (titles: string[]) => void;
  onResume: (podId: string) => void;
  onReassign: () => void;
}) => (
  <div className="caught-up">
    <div className="caught-up__top">
      <LambdaMark working={working} />
      <h2 className="caught-up__title">All caught up</h2>
      <p className="caught-up__line">{line}</p>
    </div>

    <section className="launch" aria-label="Keep things moving">
      <h3 className="launch__head">Keep things moving</h3>
      {items.map((item) => {
        switch (item.kind) {
          case 'new':
            return (
              <div key="new" className="launch__row">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8v8M8 12h8" />
                </svg>
                <span className="launch__text">Plan something new</span>
                <button type="button" className="primary" onClick={onNew}>
                  New
                </button>
              </div>
            );
          case 'unplanned':
            return (
              <div key="unplanned" className="launch__row">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                >
                  <circle
                    cx="8"
                    cy="8"
                    r="6.5"
                    fill="none"
                    stroke="#52514e"
                    strokeWidth="1.4"
                  />
                </svg>
                <span className="launch__text">
                  {item.tickets.length === 1
                    ? '1 Ready ticket has no plan yet'
                    : `${item.tickets.length} Ready tickets have no plan yet`}
                  <span className="launch__sub">
                    {names(item.tickets.map((one) => one.title))}
                  </span>
                </span>
                <button
                  type="button"
                  className="launch__button"
                  onClick={() => onPlan(item.tickets.map((one) => one.title))}
                >
                  Plan
                </button>
              </div>
            );
          case 'paused':
            return (
              <div key={`paused/${item.computer}`} className="launch__row">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="#9a5b0b"
                  aria-hidden="true"
                >
                  <rect x="6" y="5" width="4" height="14" rx="1" />
                  <rect x="14" y="5" width="4" height="14" rx="1" />
                </svg>
                <span className="launch__text">
                  {item.computer} is paused
                  <span className="launch__sub">
                    {item.waiting === 1
                      ? '1 ticket is waiting for it'
                      : `${item.waiting} tickets are waiting for it`}
                  </span>
                </span>
                <button
                  type="button"
                  className="launch__button"
                  onClick={() => onResume(item.podId)}
                >
                  Resume
                </button>
              </div>
            );
          default:
            return (
              <div key={`offline/${item.computer}`} className="launch__row">
                <span className="launch__offline" aria-hidden="true" />
                <span className="launch__text">
                  {item.computer} is offline
                  <span className="launch__sub">
                    {item.assigned === 1
                      ? '1 ticket is assigned to it'
                      : `${item.assigned} tickets are assigned to it`}
                  </span>
                </span>
                <button
                  type="button"
                  className="launch__button"
                  onClick={onReassign}
                >
                  Reassign
                </button>
              </div>
            );
        }
      })}
    </section>

    <p className="caught-up__note">
      Auto brings you here only when nothing needs you: build blockers, reviews,
      checkpoints, replies and stalled Lambdas all come first. This list is only
      what you could do, never what&apos;s waiting on you.
    </p>
  </div>
);
