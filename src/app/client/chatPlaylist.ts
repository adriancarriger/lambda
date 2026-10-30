import type { ThreadMessage } from '../../pod-store';
import { chunkSpeech, speakable } from '../shared/speech';

/**
 * The Chat panel as something to listen to. Nothing plays on its own: a
 * message's 🔊 plays it and carries on through the newer ones until the
 * newest — including any that arrive while it plays. Clips render on demand
 * (POST /api/tts/clip), one message ahead.
 *
 * Each message is cut into chunks at sentence ends (chunkSpeech): a short
 * first one, so the first words come quickly, then longer ones.
 */

export interface ChatTrack {
  id: string;
  chunks: string[];
}

/** What's said for one message: the owner's own are introduced as theirs. */
export const messageSpeech = (message: ThreadMessage): string => {
  const spoken = speakable(message.text);

  if (spoken === '' || message.from !== 'human') {
    return spoken;
  }

  return `You said: ${spoken}`;
};

/** The chat history as a playlist: system notes and silent messages skipped. */
export const chatTracks = (history: ThreadMessage[]): ChatTrack[] =>
  history
    .filter((message) => message.from !== 'system')
    .map((message) => ({
      id: message.id,
      chunks: chunkSpeech(messageSpeech(message)),
    }))
    .filter((track) => track.chunks.length > 0);

/**
 * Where to go after chunk `chunk` of message `id`: the next chunk, else the
 * next message's first, else null (the newest is done). A message that has
 * vanished from the list ends the playlist.
 */
export const nextChunk = (
  tracks: ChatTrack[],
  id: string,
  chunk: number
): { id: string; chunk: number } | null => {
  const index = tracks.findIndex((track) => track.id === id);
  const track = tracks[index];

  if (track === undefined) {
    return null;
  }

  if (chunk + 1 < track.chunks.length) {
    return { id, chunk: chunk + 1 };
  }

  const following = tracks[index + 1];

  return following === undefined ? null : { id: following.id, chunk: 0 };
};
