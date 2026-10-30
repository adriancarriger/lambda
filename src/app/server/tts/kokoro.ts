import { execFileSync, fork, spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';

import {
  appBundle,
  kokoroModulesDir,
  modelsDir,
} from '../../../desktop/appPaths';
import type { TtsConfig } from './config';
import type { Rendered } from './elevenlabs';
import { type Priority, createPieceQueue } from './pieceQueue';
import { MP3_TYPE, WAV_TYPE, encodeWav } from './wav';

/**
 * Kokoro-82M, on this machine: free, no key, several times faster than real
 * time on a desktop CPU (fp32). The model (~330 MB, cached by
 * transformers.js after the first download) loads once and stays in memory
 * (~1–1.5 GB while rendering). Renders run one at a time — CPU work on a box
 * that also runs the dev environment — and are encoded to MP3 with ffmpeg so
 * clips stay small over Tailscale.
 *
 * The model runs in its OWN process (kokoroWorker.ts): in the server it
 * would block the whole process, and the inbox page would stop loading
 * whenever the box was busy.
 */

/**
 * Kokoro reads at most 512 phoneme tokens per call and SILENTLY drops the rest
 * (its tokenizer truncates), so a long section was cut off mid-way. Each clip
 * is rendered in pieces well under that — whole sentences packed together,
 * an over-long sentence broken at a comma (or, failing that, a space) — and
 * the pieces are joined. 300 characters of English is ~300 tokens.
 */
export const MAX_CHUNK_CHARS = 300;

/** Split `text` at `pattern` (kept on the left piece), then pack pieces up to `max`. */
const pack = (text: string, pattern: RegExp, max: number): string[] =>
  text
    .split(pattern)
    .map((piece) => piece.trim())
    .filter((piece) => piece !== '')
    .reduce<string[]>((chunks, piece) => {
      const last = chunks.at(-1);

      if (last !== undefined && last.length + 1 + piece.length <= max) {
        return [...chunks.slice(0, -1), `${last} ${piece}`];
      }

      return [...chunks, piece];
    }, []);

export const chunkForKokoro = (
  text: string,
  max: number = MAX_CHUNK_CHARS
): string[] =>
  pack(text, /(?<=[.!?…])\s+/, max).flatMap((sentence) =>
    sentence.length <= max
      ? [sentence]
      : pack(sentence, /(?<=[,;:—])\s+/, max).flatMap((clause) =>
          clause.length <= max ? [clause] : pack(clause, /\s+/, max)
        )
  );

const SAMPLE_RATE = 24_000;
/** A breath between pieces, so a joined sentence boundary doesn't run on. */
const GAP = new Float32Array(Math.round(SAMPLE_RATE * 0.12));

const join = (parts: Float32Array[]): Float32Array => {
  const withGaps = parts.flatMap((part, index) =>
    index === 0 ? [part] : [GAP, part]
  );
  const out = new Float32Array(
    withGaps.reduce((sum, part) => sum + part.length, 0)
  );
  withGaps.reduce((offset, part) => {
    out.set(part, offset);

    return offset + part.length;
  }, 0);

  return out;
};

/** Raw 24 kHz float samples in → 64 kb/s mono MP3 out (plenty for speech). */
const toMp3 = (samples: Float32Array, command: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      command,
      [
        '-loglevel',
        'error',
        '-f',
        'f32le',
        '-ar',
        String(SAMPLE_RATE),
        '-ac',
        '1',
        '-i',
        'pipe:0',
        '-ac',
        '1',
        '-b:a',
        '64k',
        '-f',
        'mp3',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    ffmpeg.stdout.on('data', (chunk: Buffer) =>
      chunks.splice(chunks.length, 0, chunk)
    );
    ffmpeg.stderr.on('data', (chunk: Buffer) =>
      errors.splice(errors.length, 0, chunk)
    );
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));

        return;
      }

      reject(
        new Error(
          `ffmpeg ${code}: ${Buffer.concat(errors).toString().slice(0, 200)}`
        )
      );
    });
    ffmpeg.stdin.end(
      Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
    );
  });

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'ENOENT';

/**
 * A clip's bytes: MP3 through ffmpeg, or WAV where ffmpeg isn't installed
 * (the Mac app doesn't carry it). The audio route serves each by its bytes.
 */
export const encodeClip = async (
  samples: Float32Array,
  ffmpeg = 'ffmpeg'
): Promise<{ audio: Buffer; type: string }> => {
  try {
    return { audio: await toMp3(samples, ffmpeg), type: MP3_TYPE };
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }

    return { audio: encodeWav(samples, SAMPLE_RATE), type: WAV_TYPE };
  }
};

/**
 * Built next to the runner by tsup (dist/kokoroWorker.js). Inside the Mac
 * app the bundle is `app.asar`, which a forked process can't run from: the
 * worker is unpacked (`asarUnpack`) and loaded from `app.asar.unpacked`.
 */
export const workerPath = (dir: string = __dirname): string =>
  path.join(
    dir.replace(/([/\\])app\.asar(?=[/\\]|$)/, '$1app.asar.unpacked'),
    'kokoroWorker.js'
  );

type Env = Record<string, string | undefined>;

/** Where the model is cached: the app's folder inside the Mac app, else transformers.js's own. */
export const modelCacheDir = (
  env: Env = process.env,
  home: string = os.homedir()
): string | null => (appBundle(env) === null ? null : modelsDir(home));

/** The worker's env: inside the app, its model cache and Kokoro's modules. */
export const workerEnv = (env: Env = process.env): Env => {
  const bundle = appBundle(env);
  const cache = modelCacheDir(env);

  return bundle === null || cache === null
    ? env
    : {
        ...env,
        KOKORO_CACHE_DIR: cache,
        NODE_PATH: [kokoroModulesDir(bundle), env.NODE_PATH]
          .filter((dir) => dir !== undefined && dir !== '')
          .join(path.delimiter),
      };
};

/**
 * CPU priority, decided per piece. A clip nobody is waiting for renders in
 * macOS's background tier (efficiency cores, lowest priority), below the
 * server and the test runs: speech can wait, the page and the tests can't. The clip
 * the owner IS waiting for (renderer priority [0, …]) renders at normal priority.
 *
 * Not nice(1): an unprivileged process can raise its nice value but never
 * lower it again, so a niced worker could not be lifted for an urgent clip.
 * At nice 10 on a fully loaded machine it rendered slower than real time, and
 * the player gave up and used the browser voice.
 * Elsewhere than macOS it is niced once, as before.
 */
const NICE = 10;

export type CpuTier = 'urgent' | 'background';

const setTier = (pid: number, tier: CpuTier): boolean => {
  try {
    if (process.platform === 'darwin') {
      execFileSync('taskpolicy', [
        tier === 'urgent' ? '-B' : '-b',
        '-p',
        String(pid),
      ]);

      return true;
    }

    if (tier === 'background') {
      os.setPriority(pid, NICE);
    }

    return true;
  } catch {
    // Not fatal: it still runs, just at the priority it had.
    return false;
  }
};

export type TtsLog = (event: Record<string, unknown>) => void;

type Reply = { id: number; samples?: Float32Array; error?: string };

const isReply = (message: unknown): message is Reply =>
  typeof message === 'object' &&
  message !== null &&
  'id' in message &&
  typeof message.id === 'number';

/** What the renderer needs of the model's process (a fake one in tests). */
export interface KokoroChild {
  pid?: number;
  /** False once its IPC channel has closed, often before `exit`. */
  connected?: boolean;
  send: (
    message: Record<string, unknown>,
    callback?: (error: Error | null) => void
  ) => unknown;
  kill: () => unknown;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export type ForkKokoro = () => KokoroChild;

const forkWorker: ForkKokoro = () =>
  fork(workerPath(), [], {
    env: workerEnv(),
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });

/** The model's process: started on first use, restarted if it dies. */
const createWorkerProcess = (log: TtsLog, forkChild: ForkKokoro) => {
  const state: {
    child: KokoroChild | null;
    nextId: number;
    tier: CpuTier | null;
    closed: boolean;
  } = {
    child: null,
    nextId: 1,
    tier: null,
    closed: false,
  };
  const pending = new Map<
    number,
    {
      child: KokoroChild;
      resolve: (samples: Float32Array) => void;
      reject: (error: Error) => void;
    }
  >();

  /** A dead process: forget it, and fail what it still owed. */
  const lost = (child: KokoroChild, error: Error): number => {
    if (state.child === child) {
      state.child = null;
    }

    const owed = [...pending].filter(([, waiting]) => waiting.child === child);
    owed.forEach(([id, waiting]) => {
      pending.delete(id);
      waiting.reject(error);
    });

    return owed.length;
  };

  const start = (): KokoroChild => {
    const child = forkChild();

    state.tier = null;
    log({ event: 'worker-start', pid: child.pid });

    child.on('message', (message: unknown) => {
      if (!isReply(message)) {
        return;
      }

      const waiting = pending.get(message.id);
      pending.delete(message.id);

      if (message.error !== undefined) {
        waiting?.reject(new Error(message.error));

        return;
      }

      waiting?.resolve(message.samples ?? new Float32Array(0));
    });
    child.on('exit', (code, signal) => {
      const dropped = lost(
        child,
        new Error(`The Kokoro process exited (${String(code)})`)
      );
      log({ event: 'worker-exit', code, signal, dropped });
    });
    // A failed fork, or a send on a closed channel: unheard, it would throw
    // in the runner.
    child.on('error', (error) => {
      const dropped = lost(child, error);
      log({ event: 'worker-error', error: error.message, dropped });
    });
    state.child = child;

    return child;
  };

  const killChild = (): void => {
    state.child?.kill();
  };
  process.on('exit', killChild);

  const ask = (
    message: Record<string, unknown>,
    tier: CpuTier = 'background'
  ): Promise<Float32Array> =>
    new Promise((resolve, reject) => {
      if (state.closed) {
        reject(new Error('The Kokoro process was closed'));

        return;
      }

      const child =
        state.child !== null && state.child.connected !== false
          ? state.child
          : start();

      if (state.tier !== tier && child.pid !== undefined) {
        if (setTier(child.pid, tier)) {
          state.tier = tier;
          log({ event: 'tier', tier });
        }
      }

      const id = state.nextId;
      state.nextId += 1;
      pending.set(id, { child, resolve, reject });
      child.send({ ...message, id }, (error) => {
        if (error !== null && pending.delete(id)) {
          reject(error);
        }
      });
    });

  const close = (): void => {
    state.closed = true;
    process.off('exit', killChild);
    killChild();
  };

  return { ask, close };
};

export const createKokoro = (
  config: Pick<TtsConfig, 'kokoroVoice' | 'kokoroDtype' | 'kokoroWorkers'>,
  /** The renderer's live priority for a clip (keyed by its text). */
  priorityOf: (text: string) => Priority,
  log: TtsLog = () => undefined,
  forkChild: ForkKokoro = forkWorker
) => {
  const worker = createWorkerProcess(log, forkChild);

  // `kokoroWorkers` CPU-bound pieces at a time, most important clip first —
  // re-decided before every piece, which also sets the worker's CPU tier.
  const queue = createPieceQueue(
    (piece: string, key: string) =>
      worker.ask(
        {
          piece,
          voice: config.kokoroVoice,
          dtype: config.kokoroDtype,
        },
        priorityOf(key)[0] === 0 ? 'urgent' : 'background'
      ),
    { workers: config.kokoroWorkers, priorityOf }
  );

  const render = async (text: string): Promise<Rendered> => {
    const samples = join(await queue.add(text, chunkForKokoro(text)));

    return {
      audio: (await encodeClip(samples)).audio,
      alignment: { starts: [], ends: [] },
      duration: samples.length / SAMPLE_RATE,
    };
  };

  return {
    render,
    cancel: queue.cancel,
    poke: queue.poke,
    status: queue.status,
    /** Stop the model's process for good (the host is going away). */
    close: worker.close,
    /** Load the model now, so the first clip doesn't wait for it. */
    warm: (): void => {
      worker
        .ask({ warm: true, dtype: config.kokoroDtype })
        .catch((error: unknown) =>
          log({
            event: 'warm-failed',
            reason: error instanceof Error ? error.message : String(error),
          })
        );
    },
  };
};
