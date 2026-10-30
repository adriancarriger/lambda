/**
 * Programmatic "checkpoint complete" detector — no agent judgement involved.
 *
 * The owner dictates, so spacing, case, punctuation and "check point" vs
 * "checkpoint" all vary. A QUESTION about completeness must not close a
 * checkpoint: "is the checkpoint complete?" returns false.
 */
const PHRASE = /check[\s-]*point[\s.,!-]*complete\b([^a-z0-9]*)/;

export const matchCheckpointPhrase = (text: string): boolean => {
  const match = PHRASE.exec(text.toLowerCase());

  if (match === null) {
    return false;
  }

  const trailing = match[1] ?? '';

  return !trailing.includes('?');
};
