import { type TtsConfig } from './config';

const API = 'https://api.elevenlabs.io/v1/text-to-speech';

export interface Alignment {
  /** Start time (s, at 1×) of each character of the input text. */
  starts: number[];
  ends: number[];
}

export interface Rendered {
  /** MP3 bytes. */
  audio: Buffer;
  alignment: Alignment;
  /** Length at 1× when known directly (Kokoro); else the alignment's end. */
  duration?: number;
}

const numbers = (value: unknown): number[] =>
  Array.isArray(value)
    ? value.filter((item): item is number => typeof item === 'number')
    : [];

/**
 * Render the whole item at 1× WITH per-character timestamps — which is how
 * the section dots land at exact times. Speed is the player's job (pitch-held
 * playbackRate), so one file serves every speed and the slider never re-bills.
 */
export const renderWithTimestamps = async (
  config: TtsConfig,
  text: string
): Promise<Rendered> => {
  if (config.apiKey === undefined) {
    throw new Error('No ELEVENLABS_API_KEY');
  }

  const response = await fetch(
    `${API}/${config.voiceId}/with-timestamps?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': config.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text, model_id: config.modelId }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `ElevenLabs ${response.status}: ${(await response.text()).slice(0, 300)}`
    );
  }

  const body: unknown = await response.json();

  if (typeof body !== 'object' || body === null || !('audio_base64' in body)) {
    throw new Error('ElevenLabs returned no audio');
  }

  const alignment =
    'alignment' in body &&
    typeof body.alignment === 'object' &&
    body.alignment !== null
      ? body.alignment
      : {};

  return {
    audio: Buffer.from(String(body.audio_base64), 'base64'),
    alignment: {
      starts:
        'character_start_times_seconds' in alignment
          ? numbers(alignment.character_start_times_seconds)
          : [],
      ends:
        'character_end_times_seconds' in alignment
          ? numbers(alignment.character_end_times_seconds)
          : [],
    },
  };
};

/** Low-latency streaming (conversation replies). The caller pipes the body. */
export const streamSpeech = async (
  config: TtsConfig,
  text: string
): Promise<Response> => {
  if (config.apiKey === undefined) {
    throw new Error('No ELEVENLABS_API_KEY');
  }

  const response = await fetch(
    `${API}/${config.voiceId}/stream?output_format=mp3_44100_128&optimize_streaming_latency=3`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': config.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text, model_id: config.modelId }),
    }
  );

  if (!response.ok || response.body === null) {
    throw new Error(`ElevenLabs stream ${response.status}`);
  }

  return response;
};
