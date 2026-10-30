import { type HumanDecision, type ThreadMessage } from './schemas';

/** The name agent-facing text uses for the owner. */
export const ownerLabel = (ownerName: string | undefined): string =>
  ownerName === undefined || ownerName.trim() === ''
    ? 'Owner'
    : ownerName.trim();

/**
 * The message the dev receives when a conversation about a question ends.
 *
 * Built from the files, never written by the fork: the dev gets the owner's
 * decisions WITH the owner's verbatim words plus the whole two-sided transcript, so a
 * fork's paraphrase can always be checked against what the owner actually said.
 * `unconfirmed` marks the recovery path (the fork died before resolving).
 */
export const buildResolution = (args: {
  qid: string;
  msgId: string;
  decisions: HumanDecision[];
  conversation: ThreadMessage[];
  unconfirmed: boolean;
  /** The owner's name from the machine settings; `Owner` when there is none. */
  ownerName?: string;
}): string => {
  const { qid, msgId, decisions, conversation, unconfirmed } = args;
  const owner = ownerLabel(args.ownerName);

  const decided = decisions.filter((decision) => decision.deferred !== true);

  const deferred = decisions.filter((decision) => decision.deferred === true);

  const decisionLines =
    decided.length === 0
      ? ['(none recorded)']
      : decided.flatMap((decision, index) => [
          `${index + 1}. ${decision.decision}`,
          `   ${owner}: "${decision.quote}"`,
        ]);

  const deferredLines =
    deferred.length === 0
      ? ['(none)']
      : deferred.map(
          (decision) => `- ${decision.decision} (${owner}: "${decision.quote}")`
        );

  const transcript =
    conversation.length === 0
      ? ['(empty)']
      : conversation.map((message) => `[${message.from}] ${message.text}`);

  return [
    `/human-resolved ${qid} [m:${msgId}]`,
    unconfirmed
      ? 'UNCONFIRMED — the conversation ended without the fork resolving it (crash, kill or reboot). Re-ask anything ambiguous as a new question rather than guessing.'
      : `DECISIONS were confirmed to ${owner} one by one ("Recorded: …") during the conversation.`,
    '',
    'DECISIONS',
    ...decisionLines,
    '',
    'DEFERRED',
    ...deferredLines,
    '',
    'FULL CONVERSATION',
    ...transcript,
  ].join('\n');
};

/**
 * The sidebar chat's hand-off: everything the owner said in the chat since the
 * last hand-off, grouped by what it was about, with what the owner decided — sent to
 * the dev as `/human-resolved chat`, just before the owner's answer on an item.
 */
export const buildChatHandoff = (args: {
  msgId: string;
  messages: ThreadMessage[];
  decisions: HumanDecision[];
  /** "Checkpoint 3", "q5: Should the fallback ship?" — by qid. */
  topicLabel: (qid: string | undefined) => string;
  /** The owner's name from the machine settings; `Owner` when there is none. */
  ownerName?: string;
}): string => {
  const owner = ownerLabel(args.ownerName);
  const topics = Array.from(
    new Set(args.messages.map((message) => message.qid ?? ''))
  );

  return [
    `/human-resolved chat [m:${args.msgId}]`,
    `From the SIDEBAR CHAT (a fork of you, with your context). Apply it like any resolved conversation, per topic; it does not end any item — ${owner}'s answers on items still arrive as /human-async. DECISIONS were confirmed to ${owner} one by one ("Recorded: …").`,
    '',
    ...topics.flatMap((topic) => {
      const qid = topic === '' ? undefined : topic;
      const decided = args.decisions.filter(
        (decision) => (decision.qid ?? '') === topic
      );

      return [
        `## About ${args.topicLabel(qid)}`,
        'DECISIONS',
        ...(decided.length === 0
          ? ['(none recorded)']
          : decided.map(
              (decision, index) =>
                `${index + 1}. ${decision.decision}${
                  decision.deferred === true ? ' (DEFERRED)' : ''
                }\n   ${owner}: "${decision.quote}"`
            )),
        'CONVERSATION',
        ...args.messages
          .filter((message) => (message.qid ?? '') === topic)
          .map((message) => `[${message.from}] ${message.text}`),
        '',
      ];
    }),
  ].join('\n');
};
