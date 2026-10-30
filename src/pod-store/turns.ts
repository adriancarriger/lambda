import { type Turn } from './schemas';

/**
 * An agent is idle once a turn that started after our last message to it has
 * ended (UserPromptSubmit → startedAt, Stop → endedAt, `lambda pod send` → sentAt).
 */
export const isIdle = (turn: Turn): boolean => {
  const started = turn.startedAt ?? '';
  const ended = turn.endedAt ?? '';
  const sent = turn.sentAt ?? '';

  if (sent !== '' && started < sent) {
    return false;
  }

  return ended >= started;
};
