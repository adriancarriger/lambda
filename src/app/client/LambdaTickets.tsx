import type { Lambda, LambdaTicket } from '../shared/lambdas';

/**
 * A Lambda's tickets, beside its planning chat: the ticket or epic it's
 * about, then each ticket it planned and where it is, each opening its
 * ticket page. The way back from a chat to its tickets.
 */

/** The ticket marks of the Tickets screen, small. */
export const TicketMark = ({ where }: { where: LambdaTicket['where'] }) => {
  if (where.kind === 'building' || where.kind === 'blocked') {
    const colour = where.kind === 'blocked' ? '#8e2626' : '#c27b12';

    return (
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <circle
          cx="8"
          cy="8"
          r="6.5"
          fill="none"
          stroke={colour}
          strokeWidth="1.5"
        />
        <path d="M8 3.2a4.8 4.8 0 010 9.6z" fill={colour} />
      </svg>
    );
  }

  if (where.kind === 'shipped') {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="7" fill="#5e6ad2" />
        <path
          d="M5 8.2l2 2 4-4.2"
          fill="none"
          stroke="#fff"
          strokeWidth="1.6"
        />
      </svg>
    );
  }

  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r="6.5"
        fill="none"
        stroke="#52514e"
        strokeWidth="1.5"
      />
    </svg>
  );
};

/** Where a ticket is, in a word or two. */
const whereWord = (where: LambdaTicket['where']): string => {
  switch (where.kind) {
    case 'building':
      return `building on ${where.computer}`;
    case 'blocked':
      return 'blocked';
    case 'queued':
      return `in line on ${where.computer}`;
    case 'shipped':
      return 'merged';
    default:
      return '';
  }
};

export const LambdaTicketsRail = ({
  lambda,
  onOpenTicket,
}: {
  lambda: Lambda | undefined;
  onOpenTicket: (projectId: string, ticketId: string) => void;
}) => {
  const projectId = lambda?.projectId ?? null;
  const about = lambda?.ticketId ?? null;
  const planned = (lambda?.tickets ?? []).filter((one) => one.id !== about);
  const open = (ticketId: string): void => {
    if (projectId !== null) {
      onOpenTicket(projectId, ticketId);
    }
  };

  if (lambda === undefined || (about === null && planned.length === 0)) {
    return (
      <p className="rail__empty">
        No tickets yet. The tickets this chat is about, or writes, show here.
      </p>
    );
  }

  return (
    <div className="lambda-rail">
      {about !== null && (
        <>
          <h3 className="lambda-rail__head">
            {planned.length > 0 ? 'The epic' : 'The ticket'}
          </h3>
          <button
            type="button"
            className="lambda-rail__ticket lambda-rail__ticket--about"
            onClick={() => open(about)}
          >
            <TicketMark
              where={
                lambda.tickets.find((one) => one.id === about)?.where ?? {
                  kind: 'waiting',
                }
              }
            />
            <span className="lambda-rail__grow">
              {lambda.tickets.find((one) => one.id === about)?.title ??
                lambda.title}
            </span>
            <span className="lambda-rail__note">{about} ›</span>
          </button>
        </>
      )}
      {planned.length > 0 && (
        <>
          <h3 className="lambda-rail__head">
            {planned.length === 1
              ? 'Its ticket'
              : `Its tickets · ${planned.length}`}
          </h3>
          <ul className="lambda-rail__list">
            {planned.map((one) => (
              <li key={one.id}>
                <button
                  type="button"
                  className="lambda-rail__ticket"
                  title={whereWord(one.where)}
                  onClick={() => open(one.id)}
                >
                  <TicketMark where={one.where} />
                  <span className="lambda-rail__grow">{one.title}</span>
                  <span className="lambda-rail__note">{one.id}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
};
