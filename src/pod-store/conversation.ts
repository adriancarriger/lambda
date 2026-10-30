import type { ThreadMessage } from './schemas';

/**
 * "Waiting on the owner": the latest `lambda pod reply --ask` the pod sent
 * that has had no answer (no message from the owner since). The manager reads
 * it via `lambda pod status` — Shape doesn't end while one is open, so a
 * question in the opening message is talked through before the pipeline
 * moves on.
 *
 * Same rule as the inbox's "Your turn" item (src/app/shared/conversation.ts
 * — a copy, because the browser bundle can't import this package at runtime).
 */
export const pendingAsk = (thread: ThreadMessage[]): ThreadMessage | null => {
  const direct = thread.filter(
    (message) =>
      message.qid === undefined &&
      (message.from === 'human' ||
        ([
          'dev',
          'manager',
          'engineering-manager',
          'product-manager',
          'qa',
        ].includes(message.from) &&
          message.target === undefined))
  );
  // Anything the owner has written since, on an item too, answers it; side-chat
  // messages and the owner's questions to the Product manager never do (see
  // pendingReplies in app/shared/conversation.ts).
  const lastHuman = thread.reduce(
    (index, message, at) =>
      message.from === 'human' &&
      message.chat !== true &&
      message.target !== 'product-manager'
        ? at
        : index,
    -1
  );
  const after = new Set(thread.slice(lastHuman + 1));

  return (
    direct
      .filter((message) => after.has(message))
      .filter(
        (message) => message.from !== 'human' && message.expectsReply === true
      )
      .at(-1) ?? null
  );
};
