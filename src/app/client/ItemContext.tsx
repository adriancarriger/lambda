import { useState } from 'react';

import type { Question, ThreadMessage } from '../../pod-store';
import {
  type Exchange,
  exchangeView,
  isLiveExchange,
  itemStatus,
  itemTitle,
  originView,
  spawnedFrom,
  splitExchange,
} from '../shared/items';
import { Message } from './Message';

const who = (message: ThreadMessage): string => {
  if (message.from === 'human') {
    return 'You';
  }

  if (message.from === 'fork') {
    return 'Lambda · live';
  }

  return message.progress === true ? 'Lambda · progress' : 'Lambda';
};

const Bubble = ({ message }: { message: ThreadMessage }) =>
  // An empty message from the owner is the end of a live conversation.
  message.from === 'human' && message.text.trim() === '' ? (
    <p className="muted chat__event">You ended the live conversation.</p>
  ) : (
    <Message
      from={message.from === 'human' ? 'you' : 'claude'}
      text={message.text}
      progress={message.progress === true}
      label={
        who(message) === 'You' || who(message) === 'Lambda'
          ? undefined
          : who(message)
      }
    />
  );

const messagesOf = (exchange: Exchange): ThreadMessage[] => [
  ...(exchange.you === null ? [] : [exchange.you]),
  ...exchange.replies,
];

/** ‹ Exchange 2 of 4 › — step back through earlier exchanges on the item. */
const ExchangeNav = ({
  index,
  total,
  isDefault,
  live,
  onPick,
}: {
  index: number;
  total: number;
  isDefault: boolean;
  live: boolean;
  onPick: (index: number | null) => void;
}) =>
  total < 2 ? null : (
    <div className="exchange-nav">
      <button
        type="button"
        className="ghost exchange-nav__step"
        disabled={index === 0}
        aria-label="Earlier exchange"
        onClick={() => onPick(index - 1)}
      >
        ‹
      </button>
      <span>
        Exchange {index + 1} of {total}
        {live ? ' · live' : ''}
      </span>
      <button
        type="button"
        className="ghost exchange-nav__step"
        disabled={index === total - 1}
        aria-label="Later exchange"
        onClick={() => onPick(index + 1)}
      >
        ›
      </button>
      {!isDefault && (
        <button
          type="button"
          className="link-button"
          onClick={() => onPick(null)}
        >
          Back to the latest
        </button>
      )}
    </div>
  );

/** Live questions since the exchange the item opens with. */
const LiveAfter = ({
  live,
  playing,
}: {
  live: Exchange[];
  playing: string | null;
}) =>
  live.length === 0 ? null : (
    <div
      className={`chat__live-after${
        playing === 'live' ? ' section--playing' : ''
      }`}
      data-section="live"
    >
      <h3 className="chat__heading">Since then, live</h3>
      {live.flatMap(messagesOf).map((message) => (
        <Bubble key={message.id} message={message} />
      ))}
    </div>
  );

/**
 * An item's chat. Collapsed (the default): "Since you were last here" — the
 * exchange the item opens with (the latest that isn't live talk), then any
 * live questions since — with ‹ › to step back through earlier exchanges and
 * every message one click away. Expanded (a live conversation, or on
 * request): everything, in order.
 */
export const ItemChat = ({
  chat,
  live = false,
  questions = [],
  humanDecisions = [],
  onOpen,
  playing = null,
  exchangeIndex = null,
  onExchangeIndex,
}: {
  chat: ThreadMessage[];
  live?: boolean;
  /** For matching parts of a split reply to the decisions they became. */
  questions?: Question[];
  humanDecisions?: { qid?: string; decision: string }[];
  onOpen?: (qid: string) => void;
  playing?: string | null;
  /** The exchange picked with ‹ › (null: the default). */
  exchangeIndex?: number | null;
  onExchangeIndex?: (index: number | null) => void;
}) => {
  const [open, setOpen] = useState(false);

  if (chat.length === 0) {
    return null;
  }

  const view = exchangeView(chat, exchangeIndex);
  const { exchange } = view;
  const split = live
    ? null
    : splitExchange(exchange, questions, humanDecisions);
  const nav =
    onExchangeIndex === undefined || live || open ? null : (
      <ExchangeNav
        index={view.index}
        total={view.total}
        isDefault={view.isDefault}
        live={exchange !== null && isLiveExchange(exchange)}
        onPick={onExchangeIndex}
      />
    );
  const heading = view.isDefault ? 'Since you were last here' : 'Earlier';

  // A message with several parts, answered part by part: show it as
  // question → answer pairs, each with the decision it became.
  if (
    split !== null &&
    !open &&
    exchange?.you !== null &&
    exchange?.you !== undefined
  ) {
    const shownIds = new Set(
      [exchange, ...view.liveAfter].flatMap(messagesOf).map((m) => m.id)
    );
    const otherCount = chat.filter((m) => !shownIds.has(m.id)).length;

    return (
      <section className="chat">
        {otherCount > 0 && (
          <button
            type="button"
            className="link-button"
            onClick={() => setOpen(true)}
          >
            {view.isDefault
              ? `Show earlier messages (${otherCount})`
              : `Show every message (${chat.length})`}
          </button>
        )}
        {nav}
        <h3 className="chat__heading">
          {heading} · {split.parts.length} parts
        </h3>
        <ol className="chat__parts">
          {split.parts.map((part, index) => (
            <li
              key={part.quote}
              data-section={`part-${index + 1}`}
              className={
                playing === `part-${index + 1}`
                  ? 'chat__part--playing'
                  : undefined
              }
            >
              <Message from="you" text={part.quote} />
              <Message from="claude" text={part.answer} />
              {part.decision !== undefined && (
                <p className="chat__part-status">
                  {part.decision.resolved
                    ? `✓ Resolved${
                        part.decision.chose === undefined
                          ? ''
                          : ` — you chose: ${part.decision.chose}`
                      }`
                    : '● Waiting on you as a decision'}
                  {onOpen !== undefined && (
                    <>
                      {' · '}
                      <button
                        type="button"
                        className="link-button"
                        onClick={() =>
                          part.decision !== undefined &&
                          onOpen(part.decision.qid)
                        }
                      >
                        ↗ Open the decision
                      </button>
                    </>
                  )}
                </p>
              )}
            </li>
          ))}
        </ol>
        {split.rest.map((message) => (
          <Bubble key={message.id} message={message} />
        ))}
        <details className="origin__full">
          <summary>Show your full message</summary>
          <p>{exchange.you.text}</p>
        </details>
        <LiveAfter live={view.liveAfter} playing={playing} />
      </section>
    );
  }
  const latest = exchange === null ? [] : messagesOf(exchange);
  const latestIds = new Set(
    [...latest, ...view.liveAfter.flatMap(messagesOf)].map(
      (message) => message.id
    )
  );
  const earlier = chat.filter((message) => !latestIds.has(message.id));
  const expanded = live || open;
  const shown = expanded ? chat : latest;

  return (
    <section className={`chat${live ? ' chat--live' : ''}`}>
      {!live && earlier.length > 0 && (
        <button
          type="button"
          className="link-button"
          onClick={() => setOpen((value) => !value)}
        >
          {open
            ? 'Hide earlier messages'
            : view.isDefault
            ? `Show earlier messages (${earlier.length})`
            : `Show every message (${chat.length})`}
        </button>
      )}
      {nav}
      <h3 className="chat__heading">
        {live ? 'Live conversation' : expanded ? 'Conversation' : heading}
      </h3>
      {shown.map((message) => (
        <Bubble key={message.id} message={message} />
      ))}
      {!expanded && <LiveAfter live={view.liveAfter} playing={playing} />}
      {/* Live: the owner spoke last, so Claude's reply is being written. */}
      {live && chat.at(-1)?.from === 'human' && (
        <div
          className="msg msg--claude chat__typing"
          aria-label="Lambda is thinking"
        >
          <span className="typing" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </div>
      )}
      {!live &&
        exchange !== null &&
        exchange.you !== null &&
        exchange.replies.length === 0 && (
          <p className="muted chat__pending">Lambda is working on this.</p>
        )}
    </section>
  );
};

/** "How we got here" — where this question came from, with a link back. */
export const OriginBlock = ({
  question,
  questions,
  thread,
  onOpen,
}: {
  question: Question;
  questions: Question[];
  thread: ThreadMessage[];
  onOpen: (qid: string) => void;
}) => {
  const origin = originView(question, questions, thread);

  if (origin === null) {
    return null;
  }

  return (
    <section className="origin">
      <h3>
        How we got here
        {origin.series !== undefined &&
          ` · decision ${origin.series.index + 1} of ${origin.series.total}`}
      </h3>
      <p>{origin.lead}.</p>
      {origin.quote !== undefined && (
        <p className="origin__quote">
          <span className="chat__who">You said</span> {origin.quote}
        </p>
      )}
      {origin.reply !== undefined && (
        <p className="origin__quote">
          <span className="chat__who">Lambda</span> {origin.reply}
        </p>
      )}
      {origin.fullMessage !== undefined && (
        <details className="origin__full">
          <summary>Show your full message</summary>
          <p>{origin.fullMessage}</p>
        </details>
      )}
      {origin.link !== undefined && (
        <button
          type="button"
          className="link-button"
          onClick={() => origin.link !== undefined && onOpen(origin.link.qid)}
        >
          ↩ Open {origin.link.label}
        </button>
      )}
    </section>
  );
};

/** "This led to" — the decisions this item spawned, and where each stands. */
export const LedTo = ({
  question,
  questions,
  thread,
  onOpen,
}: {
  question: Question;
  questions: Question[];
  thread: ThreadMessage[];
  onOpen: (qid: string) => void;
}) => {
  const spawned = spawnedFrom(questions, question.id);

  if (spawned.length === 0) {
    return null;
  }

  return (
    <section className="led-to">
      <h3>This led to</h3>
      <ul>
        {spawned.map((child) => (
          <li key={child.id}>
            <button
              type="button"
              className="link-button"
              onClick={() => onOpen(child.id)}
            >
              {itemTitle(child)}
            </button>
            <span className="muted">
              {' '}
              · {itemStatus(child, questions, thread)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
};
