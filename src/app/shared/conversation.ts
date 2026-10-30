import type { ThreadMessage } from '../../pod-store';

/** Agents who talk to the owner: a planning pod's, and a building pod's. */
const SPEAKERS = [
  'dev',
  'manager',
  'engineering-manager',
  'product-manager',
  'qa',
];

/**
 * The direct conversation between the owner and the pod: their chat messages and
 * the agents' `lambda pod reply`s that are not about a specific question. Agent →
 * agent traffic (anything with a `target` not from the owner) and system notes
 * are excluded. Shared by the server (inbox) and the client (the card).
 */
export const conversation = (thread: ThreadMessage[]): ThreadMessage[] =>
  thread.filter(
    (message) =>
      message.qid === undefined &&
      (message.from === 'human' ||
        (SPEAKERS.includes(message.from) && message.target === undefined))
  );

/**
 * A building pod's chat: everything the owner wrote, and every agent line
 * addressed to them. Agent → agent traffic (the Product manager's relay to
 * the Engineering manager has a `target`) and system notes aren't theirs.
 */
export const buildingChat = (thread: ThreadMessage[]): ThreadMessage[] =>
  thread.filter(
    (message) =>
      message.text.trim() !== '' &&
      message.from !== 'system' &&
      (message.from === 'human' || message.target === undefined)
  );

/**
 * "Your turn": an agent ASKED the owner something (`lambda pod reply --ask`) since their
 * last message. FYIs and acknowledgements (`--fyi`) never surface on their own
 * — the pod only shows up when it truly needs them. Returns the latest
 * unanswered ask, even if FYIs came after it.
 *
 * A freeform chat is their conversation: any reply from its dev is their turn,
 * ask or not, so a dev that ends with an `--fyi` never leaves the chat in
 * their sidebar with nothing saying it is done or what to do. Progress notes
 * still don't count.
 *
 * Twin of `pendingAsk` in src/pod-store/conversation.ts (what `lambda pod status` shows the
 * manager) — kept as a copy because this file runs in the browser.
 */
/** The thread since they last wrote anything that answers the pod. */
const sinceTheirAnswer = (thread: ThreadMessage[]): Set<ThreadMessage> => {
  const lastHuman = thread.reduce(
    (index, message, at) =>
      message.from === 'human' && message.chat !== true ? at : index,
    -1
  );

  return new Set(thread.slice(lastHuman + 1));
};

export const pendingReply = (
  thread: ThreadMessage[],
  freeform = false
): ThreadMessage | null => {
  // Anything they've written since — in the chat or on one of its items — is
  // their answer: an ask answered on the item it names ends their turn too. A
  // side-chat message is a question to the chat, not their answer: it never
  // ends their turn.
  const after = sinceTheirAnswer(thread);
  const asks = conversation(thread)
    .filter((message) => after.has(message))
    .filter(
      (message) =>
        message.from !== 'human' &&
        (message.expectsReply === true ||
          (freeform &&
            message.from === 'dev' &&
            message.progress !== true &&
            message.text.trim() !== ''))
    );

  return asks.at(-1) ?? null;
};

/**
 * Every ask since their last answer, oldest first: a building pod's Blocked
 * items are each their own, so two in a row are two in the inbox. Asking the
 * Product manager something ("why did the test fail?") is a question to it,
 * not an answer on the item: only what they send the pod itself settles it.
 * An answer about one item (`about`) settles that item alone; one about none
 * settles every item before it.
 */
export const pendingReplies = (thread: ThreadMessage[]): ThreadMessage[] => {
  const answers = thread.filter(
    (message) =>
      message.from === 'human' &&
      message.chat !== true &&
      message.target !== 'product-manager'
  );

  return conversation(thread).filter(
    (ask) =>
      ask.from !== 'human' &&
      ask.expectsReply === true &&
      !answers.some(
        (answer) =>
          thread.indexOf(answer) > thread.indexOf(ask) &&
          (answer.about === undefined || answer.about === ask.id)
      )
  );
};

/** Past this, a ⌘⏎ hold lets go even with no reply — a pod never vanishes for good. */
export const CHAT_HOLD_MS = 15 * 60_000;

const isChatReply = (message: ThreadMessage): boolean =>
  message.chat === true &&
  message.from !== 'human' &&
  message.from !== 'system' &&
  message.progress !== true;

/**
 * The dev owes the owner a reply: the newest message between them is theirs
 * (system notes and progress updates don't count as a reply).
 */
export const owesReply = (thread: ThreadMessage[]): boolean =>
  thread
    .filter(
      (message) =>
        message.from !== 'system' &&
        message.progress !== true &&
        message.text.trim() !== '' &&
        (message.from === 'human' || message.target === undefined)
    )
    .at(-1)?.from === 'human';

/**
 * The sidebar chat's latest exchange: when the owner last sent it something,
 * and when it last answered (progress notes aren't answers).
 */
export const chatTimes = (
  thread: ThreadMessage[]
): { sentAt?: string; repliedAt?: string } => ({
  sentAt: thread
    .filter((message) => message.chat === true && message.from === 'human')
    .at(-1)?.createdAt,
  repliedAt: thread.filter(isChatReply).at(-1)?.createdAt,
});

/**
 * ⌘⏎ in the Chat panel: their latest chat message asked the pod to step aside
 * until it answered, and it hasn't yet — so its items stay out of the inbox.
 * Lets go on the reply, or after CHAT_HOLD_MS.
 */
export const chatHold = (thread: ThreadMessage[], now: number): boolean => {
  const sent = thread
    .filter((message) => message.chat === true && message.from === 'human')
    .at(-1);

  if (sent?.hold !== true || now - Date.parse(sent.createdAt) > CHAT_HOLD_MS) {
    return false;
  }

  return !thread.some(
    (message) => isChatReply(message) && message.createdAt >= sent.createdAt
  );
};
