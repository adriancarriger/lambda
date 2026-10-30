/**
 * Kokoro's model, in its own process (forked by kokoro.ts). Generating speech
 * is CPU-bound and partly synchronous (phonemes, the model step); in the
 * server it froze the whole process: the page itself stopped loading
 * whenever the machine was busy, e.g. during a long test run.
 *
 * `KOKORO_CACHE_DIR` (set by the Mac app) is where the model is cached:
 * `~/Library/Application Support/Lambda/models`.
 *
 * Protocol (advanced IPC serialization, so samples travel as Float32Array):
 *   in:  { id, piece, voice, dtype }  |  { id, warm: true, dtype }
 *   out: { id, samples }  |  { id, error }
 */
import type { GenerateOptions, KokoroTTS } from 'kokoro-js';

import { requireFromNodePath } from './nodePath';

type Voice = NonNullable<GenerateOptions['voice']>;
type Dtype = 'fp32' | 'fp16' | 'q8' | 'q4';

interface Request {
  id: number;
  piece?: string;
  voice?: string;
  dtype: Dtype;
  warm?: boolean;
}

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

const TRANSFORMERS = '@huggingface/transformers';

type KokoroModule = typeof import('kokoro-js');

const isKokoroModule = (value: unknown): value is KokoroModule =>
  typeof value === 'object' && value !== null && 'KokoroTTS' in value;

/** kokoro-js, from the app's Kokoro folder (NODE_PATH): never a native import(). */
const loadKokoro = (): KokoroModule => {
  const kokoro = requireFromNodePath('kokoro-js');

  if (!isKokoroModule(kokoro)) {
    throw new Error("kokoro-js didn't load as expected.");
  }

  return kokoro;
};

/** The model's cache folder, when the app names one. */
const useCacheDir = (): void => {
  const dir = process.env.KOKORO_CACHE_DIR;

  if (dir === undefined || dir === '') {
    return;
  }

  // Kokoro's own dependency, from the app's Kokoro folder (NODE_PATH).
  const transformers = requireFromNodePath(TRANSFORMERS);
  const env =
    typeof transformers === 'object' &&
    transformers !== null &&
    'env' in transformers
      ? transformers.env
      : undefined;

  if (typeof env !== 'object' || env === null) {
    throw new Error("Kokoro's model settings couldn't be loaded.");
  }

  Reflect.set(env, 'cacheDir', dir);
};
const state: { model: Promise<KokoroTTS> | null } = { model: null };

const model = (dtype: Dtype): Promise<KokoroTTS> => {
  if (state.model !== null) {
    return state.model;
  }

  const loading = Promise.resolve().then(() => {
    useCacheDir();

    return loadKokoro().KokoroTTS.from_pretrained(MODEL_ID, {
      dtype,
      device: 'cpu',
    });
  });
  state.model = loading;
  // A failed load is retried on the next request, not cached forever.
  loading.catch(() => {
    state.model = null;
  });

  return loading;
};

/** The configured voice, checked against the model's own list (a typo fails loudly). */
const voiceOf = (tts: KokoroTTS, name: string): Voice => {
  const voice = Object.keys(tts.voices).find(
    (candidate): candidate is Voice => candidate === name
  );

  if (voice === undefined) {
    throw new Error(`Unknown Kokoro voice "${name}"`);
  }

  return voice;
};

const isRequest = (message: unknown): message is Request =>
  typeof message === 'object' &&
  message !== null &&
  'id' in message &&
  typeof message.id === 'number';

const reply = (message: Record<string, unknown>): void => {
  process.send?.(message);
};

// One at a time, in arrival order: the parent's piece queue already decides
// what comes next, and hands over one piece per worker slot.
const work = { chain: Promise.resolve() };

process.on('message', (message: unknown) => {
  if (!isRequest(message)) {
    return;
  }

  work.chain = work.chain.then(async () => {
    try {
      const tts = await model(message.dtype);

      if (message.warm === true) {
        reply({ id: message.id, samples: new Float32Array(0) });

        return;
      }

      const audio = await tts.generate(message.piece ?? '', {
        voice: voiceOf(tts, message.voice ?? ''),
      });
      reply({ id: message.id, samples: audio.audio });
    } catch (error) {
      reply({
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
});

// The parent went away: nothing left to render for.
process.on('disconnect', () => process.exit(0));
