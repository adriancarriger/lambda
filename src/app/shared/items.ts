import type { Question, ThreadMessage } from '../../pod-store';
import { phaseName } from './phases';

/**
 * Per-item conversation and provenance — shared by the server (inbox) and
 * the client (the card), so what the owner sees and what decides whether an
 * item is in their inbox can never disagree.
 */

const isAgent = (message: ThreadMessage): boolean =>
  message.from === 'dev' ||
  message.from === 'manager' ||
  message.from === 'fork';

/**
 * An item's chat: everything the owner said about it (async or live) and every
 * agent message TO them about it. Agent → agent traffic (a `target`) and
 * system notes are not part of it.
 */
export const itemChat = (
  thread: ThreadMessage[],
  qid: string
): ThreadMessage[] =>
  thread.filter(
    (message) =>
      message.qid === qid &&
      message.text !== '(warm-up)' &&
      // Chat-panel talk lives in the Chat panel: it isn't the item's own
      // exchange (and isn't read as "Last time" or shown as pending on it).
      message.chat !== true &&
      (message.from === 'human' ||
        (isAgent(message) && message.target === undefined))
  );

export interface Exchange {
  /** The owner's latest message — null when Claude spoke first. */
  you: ThreadMessage | null;
  /** Claude's replies since (progress notes excluded). */
  replies: ThreadMessage[];
}

/**
 * A live (⌘⏎) question: a side conversation about the item, not a reply to
 * it. An empty message is them ENDING a live conversation — not live talk.
 */
export const isLiveExchange = (exchange: Exchange): boolean =>
  exchange.you === null
    ? exchange.replies.length > 0 &&
      exchange.replies.every((reply) => reply.from === 'fork')
    : exchange.you.mode === 'sync' && exchange.you.text.trim() !== '';

/**
 * Every exchange on an item, oldest first: each of the owner's messages with
 * Claude's replies to it (progress notes excluded). Anything Claude said
 * before the owner's first message is one exchange with `you: null`.
 */
export const exchangesOf = (chat: ThreadMessage[]): Exchange[] =>
  chat.reduce<Exchange[]>((list, message) => {
    // An empty message only ENDS the live exchange before it — it isn't one.
    if (message.from === 'human' && message.text.trim() === '') {
      return list;
    }

    if (message.from === 'human') {
      return [...list, { you: message, replies: [] }];
    }

    if (message.progress === true) {
      return list;
    }

    const last = list.at(-1);

    return last === undefined
      ? [{ you: null, replies: [message] }]
      : [
          ...list.slice(0, -1),
          { ...last, replies: [...last.replies, message] },
        ];
  }, []);

/**
 * Which exchange an item opens with: the latest one that isn't live talk —
 * a live question never replaces what the owner was listening to. Only when
 * every exchange is live is the last one used. -1 when there are none.
 */
export const defaultExchangeIndex = (list: Exchange[]): number => {
  const anchored = list.reduce(
    (found, exchange, index) => (isLiveExchange(exchange) ? found : index),
    -1
  );

  return anchored === -1 ? list.length - 1 : anchored;
};

export interface ExchangeView {
  exchange: Exchange | null;
  /** Which one (0-based) of `total`. */
  index: number;
  total: number;
  /** True when this is the one the item opens with. */
  isDefault: boolean;
  /** Live talk since the default exchange (only shown with the default). */
  liveAfter: Exchange[];
}

/** The exchange to show and read: `chosen` (‹ ›), else the default. */
export const exchangeView = (
  chat: ThreadMessage[],
  chosen?: number | null
): ExchangeView => {
  const list = exchangesOf(chat);
  const fallback = defaultExchangeIndex(list);
  const index =
    chosen === undefined || chosen === null || list[chosen] === undefined
      ? fallback
      : chosen;
  const isDefault = index === fallback;

  return {
    exchange: list[index] ?? null,
    index,
    total: list.length,
    isDefault,
    liveAfter: isDefault ? list.slice(index + 1) : [],
  };
};

const squash = (value: string): string => value.replace(/\s+/g, ' ').trim();

export interface ExchangePart {
  quote: string;
  answer: string;
  /** The decision this part became, and where it stands. */
  decision?: {
    qid: string;
    label: string;
    resolved: boolean;
    /** What they chose, when resolved. */
    chose?: string;
  };
}

/**
 * A reply to a message with several parts, split question → answer
 * (`reply --parts-file`), each part matched to the decision it became (by the
 * quote that decision was made from). Null when the latest exchange isn't
 * split; `rest` is any other reply that came after it.
 */
export const splitExchange = (
  exchange: Exchange | null,
  questions: Question[],
  humanDecisions: { qid?: string; decision: string }[]
): { parts: ExchangePart[]; rest: ThreadMessage[] } | null => {
  const you = exchange?.you;

  if (exchange === null || you === null || you === undefined) {
    return null;
  }

  const split = exchange.replies
    .filter((reply) => reply.parts !== undefined && reply.replyTo === you.id)
    .at(-1);

  if (split?.parts === undefined) {
    return null;
  }

  const parts = split.parts.map((part): ExchangePart => {
    const quote = squash(part.quote);
    const spawned = questions.find(
      (candidate) =>
        candidate.status !== 'withdrawn' &&
        candidate.origin?.kind === 'message' &&
        candidate.origin.messageId === you.id &&
        candidate.origin.quote !== undefined &&
        (quote.includes(squash(candidate.origin.quote)) ||
          squash(candidate.origin.quote).includes(quote))
    );

    return {
      quote: part.quote,
      answer: part.answer,
      decision:
        spawned === undefined
          ? undefined
          : {
              qid: spawned.id,
              label: itemTitle(spawned),
              resolved: spawned.status === 'answered',
              chose: humanDecisions
                .filter((decision) => decision.qid === spawned.id)
                .at(-1)?.decision,
            },
    };
  });

  return {
    parts,
    // The split reply replaces any plain reply to the same message before it.
    rest: exchange.replies.filter(
      (reply) => reply !== split && reply.createdAt > split.createdAt
    ),
  };
};

/**
 * The owner has said something on this item and Claude hasn't given its reply
 * yet (progress notes don't count) — so it's out of their inbox meanwhile.
 */
export const awaitingAgent = (
  question: Question,
  thread: ThreadMessage[]
): boolean => {
  const latest = itemChat(thread, question.id)
    .filter(
      (message) =>
        message.progress !== true &&
        // Ending a live conversation with no last word asks Claude nothing:
        // it was already answered live, so the item stays (the dev may have
        // nothing to add).
        !(message.from === 'human' && message.text.trim() === '') &&
        // The Chat panel is talk, not an answer: it never takes an item out
        // of the inbox, and a chat reply is not Claude's reply on the item.
        message.chat !== true &&
        message.createdAt >= (question.committedAt ?? question.createdAt)
    )
    .at(-1);

  return latest !== undefined && latest.from === 'human';
};

/** Questions that came from something the owner said on this item. */
export const spawnedFrom = (questions: Question[], qid: string): Question[] =>
  questions.filter(
    (candidate) =>
      candidate.status !== 'withdrawn' &&
      candidate.origin !== undefined &&
      candidate.origin.kind !== 'work' &&
      candidate.origin.qid === qid
  );

const isPending = (question: Question): boolean =>
  question.status === 'open' || question.status === 'draft';

/**
 * The item steps aside while decisions it spawned are open — and until Claude
 * has replied on it after the last of them was answered ("here's what changed").
 */
export const waitingOnSpawned = (
  question: Question,
  questions: Question[],
  thread: ThreadMessage[]
): boolean => {
  const spawned = spawnedFrom(questions, question.id).filter(
    (candidate) => candidate.origin?.kind === 'message'
  );

  if (spawned.some(isPending)) {
    return true;
  }

  const lastAnswered = spawned.reduce(
    (max, candidate) =>
      (candidate.answeredAt ?? '') > max ? candidate.answeredAt ?? '' : max,
    ''
  );

  if (lastAnswered === '') {
    return false;
  }

  // The dev's reply on the item — or on the question it spawned (where it
  // usually answers what was decided there), or an edit to the card itself —
  // brings the item back. Only the item's own reply counted once, and a dev
  // that answered on the spawned question left the checkpoint hidden while
  // the manager waited on the owner: a stall nothing could nudge.
  const replies = [question.id, ...spawned.map((candidate) => candidate.id)]
    .flatMap((qid) => itemChat(thread, qid))
    .filter(
      (message) =>
        isAgent(message) && message.progress !== true && message.chat !== true
    )
    .map((message) => message.createdAt);
  const latest = [...replies, question.checkpoint?.refreshedAt ?? ''].reduce(
    (max, at) => (at > max ? at : max),
    ''
  );

  return latest < lastAnswered;
};

const firstSentence = (text: string, max = 80): string => {
  const sentence = text.trim().split(/(?<=[.?!])\s/)[0] ?? '';

  return sentence.length > max
    ? `${sentence.slice(0, max - 1).trimEnd()}…`
    : sentence;
};

/** How an item is named in links and in speech. */
const plainTitle = (question: Question): string =>
  question.kind === 'checkpoint' && question.checkpoint !== undefined
    ? `Checkpoint ${question.checkpoint.cp}`
    : firstSentence(question.summary ?? question.id);

/**
 * A question about one ticket says which, first ("PAWNEE-84 · …"): in a batch
 * of unrelated bugs every item is a context switch, so the card carries it.
 */
export const itemTitle = (question: Question): string =>
  question.kind !== 'checkpoint' && question.ticketId !== undefined
    ? `${question.ticketId} · ${plainTitle(question)}`
    : plainTitle(question);

const spokenTitle = (question: Question): string =>
  question.kind === 'checkpoint'
    ? plainTitle(question)
    : `the question "${plainTitle(question)}"`;

/** Where an item stands, for a card opened from a link. */
export const itemStatus = (
  question: Question,
  questions: Question[],
  thread: ThreadMessage[]
): string => {
  if (question.status === 'withdrawn') {
    return 'Withdrawn';
  }

  if (question.status === 'answered') {
    return question.kind === 'checkpoint' ? 'Complete' : 'Answered';
  }

  if (question.status === 'draft') {
    return 'Draft';
  }

  const pending = spawnedFrom(questions, question.id).filter(isPending).length;

  if (pending > 0) {
    return `Waiting on ${
      pending === 1 ? 'one decision' : `${pending} decisions`
    }`;
  }

  return awaitingAgent(question, thread) ? 'Lambda is on it' : 'Waiting on you';
};

const ORDINALS = [
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
];

const ordinal = (index: number): string =>
  ORDINALS[index] ?? `number ${index + 1}`;

/** Which phase's checkpoint a phase ends at. */
const CHECKPOINT_FOR_PHASE: Record<number, number> = {
  1: 1,
  2: 2,
  3: 3,
  4: 5,
  5: 5,
};

export interface OriginView {
  /** "From what you said on Checkpoint 1". */
  lead: string;
  /** The item to jump to, when there is one. */
  link?: { qid: string; label: string };
  /** The owner's own words, quoted from the saved message. */
  quote?: string;
  /** Claude's reply to them. */
  reply?: string;
  /** Their whole message, when `quote` is just the relevant part of it. */
  fullMessage?: string;
  /** "decision 1 of 3" when one message led to several. */
  series?: { index: number; total: number };
  /** Read first: "This comes from what you said on Checkpoint 1: '…'". */
  spoken: string;
}

/** "How we got here" for a question, or null (checkpoints, older questions). */
export const originView = (
  question: Question,
  questions: Question[],
  thread: ThreadMessage[]
): OriginView | null => {
  const { origin } = question;

  if (origin === undefined) {
    return null;
  }

  const byId = (qid: string): Question | undefined =>
    questions.find((candidate) => candidate.id === qid);

  if (origin.kind === 'message') {
    const message = thread.find((entry) => entry.id === origin.messageId);
    const source = origin.qid === undefined ? undefined : byId(origin.qid);
    const reply = thread.find(
      (entry) =>
        message !== undefined &&
        isAgent(entry) &&
        entry.target === undefined &&
        entry.progress !== true &&
        entry.qid === origin.qid &&
        entry.createdAt > message.createdAt
    );
    const siblings = questions
      .filter(
        (candidate) =>
          candidate.status !== 'withdrawn' &&
          candidate.origin?.kind === 'message' &&
          candidate.origin.messageId === origin.messageId
      )
      .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
    const index = siblings.findIndex(
      (candidate) => candidate.id === question.id
    );
    const series =
      siblings.length > 1 && index !== -1
        ? { index, total: siblings.length }
        : undefined;
    const where =
      source === undefined
        ? 'in your chat with Lambda'
        : `on ${spokenTitle(source)}`;
    // Just the part of their message this question is about, and Claude's
    // answer to that part — the whole message is one click away.
    const quote = origin.quote ?? message?.text;
    const answer = origin.reply ?? reply?.text;

    return {
      lead:
        source === undefined
          ? 'From what you said in your chat with Lambda'
          : `From what you said on ${itemTitle(source)}`,
      link:
        source === undefined
          ? undefined
          : { qid: source.id, label: itemTitle(source) },
      quote,
      reply: answer,
      fullMessage:
        origin.quote !== undefined && message !== undefined
          ? message.text
          : undefined,
      series,
      spoken: `This comes from what you said ${where}${
        quote === undefined ? '' : `: "${quote}"`
      }.${answer === undefined ? '' : ` Lambda answered: "${answer}"`}${
        series === undefined
          ? ''
          : ` It's the ${ordinal(series.index)} of ${series.total} decisions.`
      }`,
    };
  }

  if (origin.kind === 'answer') {
    const source = byId(origin.qid);
    const answer = itemChat(thread, origin.qid)
      .filter((message) => message.from === 'human')
      .at(-1);
    const label =
      source === undefined ? 'an earlier question' : itemTitle(source);

    return {
      lead: `Follows from your answer on ${label}`,
      link: source === undefined ? undefined : { qid: source.id, label },
      quote: answer?.text,
      spoken: `This follows from your answer on ${
        source === undefined ? 'an earlier question' : spokenTitle(source)
      }${answer === undefined ? '' : `: "${answer.text}"`}.`,
    };
  }

  const checkpoint = questions.find(
    (candidate) =>
      candidate.kind === 'checkpoint' &&
      candidate.checkpoint?.cp === CHECKPOINT_FOR_PHASE[origin.phase]
  );

  return {
    lead: `Came up during ${phaseName(origin.phase)}, while ${origin.doing}`,
    link:
      checkpoint === undefined
        ? undefined
        : { qid: checkpoint.id, label: itemTitle(checkpoint) },
    spoken: `This came up during ${phaseName(origin.phase)}, while ${
      origin.doing
    }.`,
  };
};
