import type { ThreadMessage } from '../../pod-store';
import { chatTracks, messageSpeech, nextChunk } from '../client/chatPlaylist';
import { chunkSpeech } from '../shared/speech';

/** The Chat panel's playlist: from the message pressed to the newest. */

const message = (overrides: Partial<ThreadMessage>): ThreadMessage => ({
  id: 'm1',
  podId: 'pawnee-a1b2',
  from: 'fork',
  mode: 'sync',
  chat: true,
  text: 'Leslie wants the parks budget on one page.',
  createdAt: '2026-10-13T16:00:00.000Z',
  delivery: 'received',
  ...overrides,
});

describe('chunkSpeech', () => {
  it('keeps a short message whole', () => {
    expect(chunkSpeech('One. Two.')).toEqual(['One. Two.']);
  });

  it('starts with a short chunk, then longer ones, cut at sentence ends', () => {
    const sentence = `${'word '.repeat(19)}end.`; // 100 characters
    const chunks = chunkSpeech(Array(30).fill(sentence).join(' '));

    expect(chunks[0]?.length).toBeLessThanOrEqual(250);
    expect(chunks.slice(1, -1).every((chunk) => chunk.length > 300)).toBe(true);
    expect(chunks.every((chunk) => chunk.length <= 600)).toBe(true);
    expect(chunks.every((chunk) => chunk.endsWith('end.'))).toBe(true);
    expect(chunks.join(' ')).toBe(Array(30).fill(sentence).join(' '));
  });

  it('says nothing for an empty message', () => {
    expect(chunkSpeech('')).toEqual([]);
  });

  it('keeps a line break where the text had one', () => {
    expect(chunkSpeech('Tickets\n1. Parks budget\n2. Pawnee mural')).toEqual([
      'Tickets\n1. Parks budget\n2. Pawnee mural',
    ]);
  });
});

describe('messageSpeech', () => {
  it("introduces the owner's own messages", () => {
    expect(messageSpeech(message({ from: 'human', text: 'Ship it' }))).toBe(
      'You said: Ship it'
    );
  });

  it('reads markdown as speech', () => {
    expect(messageSpeech(message({ text: '**Name:** Penguin Plaza' }))).toBe(
      'Name: Penguin Plaza'
    );
  });
});

describe('chatTracks and nextChunk', () => {
  const tracks = chatTracks([
    message({ id: 'a', from: 'human', text: 'What changed?' }),
    message({ id: 'note', from: 'system', text: 'Sent the dev what you said' }),
    message({ id: 'image-only', text: '[Image: /tmp/shot.png]' }),
    message({ id: 'b', text: 'The name. The colour.' }),
  ]);

  it('skips system notes and messages with nothing to say', () => {
    expect(tracks.map((track) => track.id)).toEqual(['a', 'b']);
  });

  it('plays through to the newest message, then stops', () => {
    expect(nextChunk(tracks, 'a', 0)).toEqual({ id: 'b', chunk: 0 });
    expect(nextChunk(tracks, 'b', 0)).toBeNull();
  });

  it('carries on into a message that arrived while playing', () => {
    const later = [
      ...tracks,
      ...chatTracks([message({ id: 'c', text: 'One more thing.' })]),
    ];

    expect(nextChunk(later, 'b', 0)).toEqual({ id: 'c', chunk: 0 });
  });

  it('moves through a long message chunk by chunk', () => {
    const long = [{ id: 'x', chunks: ['one', 'two'] }];

    expect(nextChunk(long, 'x', 0)).toEqual({ id: 'x', chunk: 1 });
    expect(nextChunk(long, 'x', 1)).toBeNull();
  });
});
