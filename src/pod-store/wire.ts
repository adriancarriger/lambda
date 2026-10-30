/**
 * Message markers. Every message the app/CLI pastes into an agent carries
 * `[m:<id>]` so the agent's UserPromptSubmit hook can mark that exact thread
 * entry `received` (and so a re-delivery after a reboot is recognisably a
 * duplicate).
 */
const MARKER = /\[m:([a-z0-9][a-z0-9-]*)\]/;

export const formatWire = (
  command: string,
  args: { qid?: string; msgId: string },
  body: string
): string => {
  const head = [command, args.qid, `[m:${args.msgId}]`]
    .filter((part) => part !== undefined && part !== '')
    .join(' ');

  return body === '' ? head : `${head}: ${body}`;
};

export const parseMsgId = (prompt: string): string | null =>
  MARKER.exec(prompt)?.[1] ?? null;
