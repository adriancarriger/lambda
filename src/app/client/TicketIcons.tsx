import type { Priority, TicketState } from '../../tickets/source';
import { PRIORITY_NAMES, STATUSES } from '../shared/ticketBoard';

/**
 * The Tickets screen's small icons, drawn as Linear draws them: one status
 * set used everywhere (list, ticket page, menus), priority bars, and the
 * computer an assigned ticket goes to.
 */

export const StatusIcon = ({
  status,
  size = 15,
  label = true,
}: {
  status: TicketState;
  size?: number;
  /** Off where the status's name is written beside it. */
  label?: boolean;
}) => {
  const look = STATUSES[status];
  const a11y = label
    ? { role: 'img', 'aria-label': look.name }
    : { 'aria-hidden': true };

  return (
    <svg
      className={`status-icon status-icon--${look.icon}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      {...a11y}
    >
      {look.icon === 'inbox' && (
        <>
          <circle
            cx="8"
            cy="8"
            r="6.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray="1 2.4"
            strokeLinecap="round"
          />
          <path
            d="M5.2 8.6h1.6l.7 1.1h1l.7-1.1h1.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
      {look.icon === 'planning' && (
        <circle
          cx="8"
          cy="8"
          r="6.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="2.5 2"
        />
      )}
      {look.icon === 'ready' && (
        <circle
          cx="8"
          cy="8"
          r="6.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      )}
      {look.icon === 'building' && (
        <>
          <circle
            cx="8"
            cy="8"
            r="6.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path d="M8 3.2a4.8 4.8 0 010 9.6z" fill="currentColor" />
        </>
      )}
      {look.icon === 'blocked' && (
        <>
          <circle
            cx="8"
            cy="8"
            r="6.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path d="M3.5 12.5l9-9" stroke="currentColor" strokeWidth="1.5" />
        </>
      )}
      {look.icon === 'shipped' && (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path
            d="M4.8 8.2l2.2 2.2 4.2-4.6"
            fill="none"
            stroke="var(--white)"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
      {look.icon === 'canceled' && (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path
            d="M5.5 5.5l5 5M10.5 5.5l-5 5"
            stroke="var(--white)"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  );
};

/** Bars filled for each level; Urgent is an orange square; none is "···". */
export const PriorityIcon = ({
  priority,
  label = true,
}: {
  priority: Priority;
  label?: boolean;
}) => {
  const a11y = label
    ? { role: 'img', 'aria-label': PRIORITY_NAMES[priority] }
    : { 'aria-hidden': true };

  if (priority === 'none') {
    return (
      <span
        className="priority-icon priority-icon--none"
        {...(label
          ? { role: 'img', 'aria-label': PRIORITY_NAMES.none }
          : { 'aria-hidden': true })}
      >
        ···
      </span>
    );
  }

  if (priority === 'urgent') {
    return (
      <svg
        className="priority-icon priority-icon--urgent"
        width="14"
        height="14"
        viewBox="0 0 16 16"
        {...a11y}
      >
        <rect x="1" y="1" width="14" height="14" rx="3" fill="currentColor" />
        <path
          d="M8 4v5"
          stroke="var(--white)"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx="8" cy="11.8" r="1.2" fill="var(--white)" />
      </svg>
    );
  }

  const filled = { high: 3, medium: 2, low: 1 }[priority];

  return (
    <svg
      className="priority-icon"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      {...a11y}
    >
      {[
        { x: 1.5, y: 9, h: 5 },
        { x: 6.5, y: 5.5, h: 8.5 },
        { x: 11.5, y: 2, h: 12 },
      ].map((bar, index) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={bar.y}
          width="3"
          height={bar.h}
          rx="1"
          className={
            index < filled ? 'priority-icon__on' : 'priority-icon__off'
          }
        />
      ))}
    </svg>
  );
};

/** A laptop: a ticket assigned to a computer; dashed when unassigned. */
export const ComputerIcon = ({ assigned }: { assigned: boolean }) =>
  assigned ? (
    <svg
      className="computer-icon"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <rect x="4" y="5" width="16" height="11" rx="1.5" />
      <path d="M2 19h20" />
    </svg>
  ) : (
    <svg
      className="computer-icon computer-icon--none"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeDasharray="3 2"
      aria-hidden="true"
    >
      <rect x="4" y="5" width="16" height="11" rx="1.5" />
    </svg>
  );

/** The epic's progress ring beside "1/5". */
export const ProgressRing = ({
  done,
  total,
}: {
  done: number;
  total: number;
}) => {
  const share = total === 0 ? 0 : done / total;
  const radius = 6;
  const around = 2 * Math.PI * radius;

  return (
    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        stroke="var(--grey-300)"
        strokeWidth="2.5"
      />
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        stroke="var(--success)"
        strokeWidth="2.5"
        strokeDasharray={`${share * around} ${around}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
};

/** A small stroke icon, 14px: filter, display, plus, chevrons, link, lock. */
export const LineIcon = ({
  name,
  size = 14,
}: {
  name:
    | 'filter'
    | 'display'
    | 'plus'
    | 'down'
    | 'up'
    | 'link'
    | 'lock'
    | 'close'
    | 'check'
    | 'search'
    | 'sparkle';
  size?: number;
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {name === 'filter' && <path d="M4 6h16M7 12h10M10 18h4" />}
    {name === 'display' && (
      <>
        <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
        <circle cx="16" cy="7" r="2" />
        <circle cx="10" cy="17" r="2" />
      </>
    )}
    {name === 'plus' && <path d="M12 5v14M5 12h14" />}
    {name === 'down' && <path d="M12 5v14M6 13l6 6 6-6" />}
    {name === 'up' && <path d="M12 19V5M6 11l6-6 6 6" />}
    {name === 'link' && (
      <path d="M10 14a4 4 0 006 0l3-3a4 4 0 00-6-6l-1 1M14 10a4 4 0 00-6 0l-3 3a4 4 0 006 6l1-1" />
    )}
    {name === 'lock' && (
      <>
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V8a4 4 0 018 0v3" />
      </>
    )}
    {name === 'close' && <path d="M6 6l12 12M18 6L6 18" />}
    {name === 'check' && <path d="M5 12l5 5 9-10" />}
    {name === 'search' && (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.5-3.5" />
      </>
    )}
    {name === 'sparkle' && (
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
    )}
  </svg>
);
