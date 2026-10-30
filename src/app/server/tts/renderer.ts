import * as fs from 'fs';
import * as path from 'path';

import type { ClipStatus } from '../../shared/types';
import { type Budget } from './budget';
import { type Rendered } from './elevenlabs';
import { type Priority, comparePriority } from './pieceQueue';
import { audioHash } from './timing';

/**
 * Per-section audio ("clips"). Each section of an item is rendered on its own
 * and cached under `<pods root>/<pod>/audio/<hash>.mp3` (+ `.json` with its
 * duration), keyed by voice + model + exact text — so a clip is paid for once,
 * however often it is replayed, and an unchanged section of a re-posted item
 * is reused. Two ways in:
 *   - `prefetch`: background, after the text has settled (so a dev amending a
 *     checkpoint doesn't pay for half-finished versions), retried with backoff;
 *   - `renderNow`: the player needs it now — no settling, one attempt.
 */

interface Job {
  podId: string;
  hash: string;
  text: string;
  state: 'queued' | 'rendering' | 'waiting' | 'failed';
  attempts: number;
  reason?: string;
  failedAt?: number;
  /** When it was first queued (for the log's queue wait). */
  queuedAt?: number;
}

/**
 * A failure is not forever: after this long the clip is tried again, so fixing
 * the key (e.g. granting text_to_speech in the ElevenLabs dashboard) takes
 * effect without restarting the app.
 */
const RETRY_FAILED_AFTER_MS = 5 * 60_000;

/** How long the clip lasts at 1×: the end of its last character. */
const durationOf = (rendered: Rendered): number =>
  rendered.duration ??
  rendered.alignment.ends.reduce((max, end) => Math.max(max, end), 0);

export const createRenderer = (args: {
  audioDir: (podId: string) => string;
  render: (text: string) => Promise<Rendered>;
  /** Drop a clip already handed to `render` (it left the inbox). */
  cancel?: (text: string) => void;
  /** Priorities changed: let the provider re-pick (Kokoro, per piece). */
  poke?: () => void;
  budget: Budget;
  /** Asked each time — a key added to the env takes effect without a restart. */
  enabled: () => boolean;
  voiceId: string;
  modelId: string;
  concurrency?: number;
  retryDelaysMs?: number[];
  schedule?: (fn: () => void, ms: number) => void;
  now?: () => number;
  /** How long a text must stay unchanged before it is pre-rendered. */
  settleMs?: number;
  onChange?: () => void;
  /** One line per render and per player wait, for `<pods root>/_tts.log`. */
  log?: (event: Record<string, unknown>) => void;
}) => {
  const log = args.log ?? (() => undefined);
  /**
   * The render is paid for and stored: a failure to write it down is logged,
   * never a reason to render (and pay) again.
   */
  const recordSpend = (characters: number): void => {
    try {
      args.budget.record(characters);
    } catch (error) {
      log({
        event: 'budget-not-recorded',
        chars: characters,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const concurrency = args.concurrency ?? 2;
  const retryDelays = args.retryDelaysMs ?? [2_000, 8_000, 30_000];
  const schedule = args.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
  const now = args.now ?? (() => Date.now());
  const settleMs = args.settleMs ?? 15_000;
  /** When each text was first seen — pre-rendering waits until it settles. */
  const seen = new Map<string, number>();
  const jobs = new Map<string, Job>();
  /** Renders in flight, so an on-demand request joins one already running. */
  const inflight = new Map<string, Promise<void>>();
  /**
   * Priority, decided live (see priorityOf). `needs`: what the player asked
   * for, with when and on which item; `ranks`: the background order from the
   * latest prefetch; `focus`: the item (or pod page) on screen.
   */
  const needs = new Map<
    string,
    { level: 0 | 1; at: number; focus: string | null }
  >();
  const ranks = new Map<string, number>();
  const state: { focus: string | null; at: number } = { focus: null, at: 0 };
  /** Strictly increasing, so two requests in the same millisecond still order. */
  const tick = (): number => {
    state.at = Math.max(state.at + 1, now());

    return state.at;
  };

  const hashOf = (text: string): string =>
    audioHash(args.voiceId, args.modelId, text);

  const files = (podId: string, hash: string) => ({
    mp3: path.join(args.audioDir(podId), `${hash}.mp3`),
    json: path.join(args.audioDir(podId), `${hash}.json`),
  });

  const storedDuration = (podId: string, hash: string): number | null => {
    const { mp3, json } = files(podId, hash);

    if (!fs.existsSync(mp3) || !fs.existsSync(json)) {
      return null;
    }

    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(json, 'utf8'));

      return typeof parsed === 'object' &&
        parsed !== null &&
        'duration' in parsed &&
        typeof parsed.duration === 'number'
        ? parsed.duration
        : null;
    } catch {
      return null;
    }
  };

  const running = (): number =>
    [...jobs.values()].filter((job) => job.state === 'rendering').length;

  /**
   * How much a clip matters right now — lowest first, asked before every
   * piece Kokoro renders:
   *   [0, -at]  the section the player is waiting on (newest request wins:
   *             a jump beats everything asked before it)
   *   [1, at]   the player's look-ahead on the item on screen
   *   [2, rank] the background order (on-screen item first; see the server)
   *   [3]       anything else
   * A request made for another item than the one on screen counts as
   * background: clicking away demotes it at once.
   */
  const priorityOfHash = (hash: string): Priority => {
    const need = needs.get(hash);

    if (need !== undefined && need.focus === state.focus) {
      return need.level === 0 ? [0, -need.at] : [1, need.at];
    }

    const rank = ranks.get(hash);

    return rank === undefined ? [3] : [2, rank];
  };

  const priorityOf = (text: string): Priority => priorityOfHash(hashOf(text));

  /** One attempt. Background jobs get retries; on-demand ones don't wait for them. */
  const run = (job: Job, retry: boolean): Promise<void> => {
    const existing = inflight.get(job.hash);

    // Joining a render already running: its priority was raised by the
    // caller (renderNow), which Kokoro reads before its next piece.
    if (existing !== undefined) {
      return existing;
    }

    jobs.set(job.hash, { ...job, state: 'rendering' });
    const startedAt = now();
    const timing = () => ({
      podId: job.podId,
      chars: job.text.length,
      priority: priorityOfHash(job.hash).join(','),
      queuedMs:
        job.queuedAt === undefined ? undefined : startedAt - job.queuedAt,
      renderMs: now() - startedAt,
      attempt: job.attempts + 1,
    });

    const attempt = (async (): Promise<void> => {
      try {
        const rendered = await args.render(job.text);
        const seconds = durationOf(rendered);
        const took = timing();
        log({
          event: 'rendered',
          ...took,
          audioSec: Math.round(seconds * 10) / 10,
          // Seconds of speech per second of rendering: under 1, a listener
          // catches up with it.
          speed:
            took.renderMs > 0
              ? Math.round((seconds / (took.renderMs / 1000)) * 100) / 100
              : undefined,
        });
        const { mp3, json } = files(job.podId, job.hash);
        fs.mkdirSync(path.dirname(mp3), { recursive: true });
        fs.writeFileSync(mp3, rendered.audio);
        fs.writeFileSync(
          json,
          `${JSON.stringify({ duration: durationOf(rendered) })}\n`
        );
        jobs.delete(job.hash);
        needs.delete(job.hash);
        recordSpend(job.text.length);
      } catch (error) {
        // Dropped on purpose (it left the inbox): not a failure.
        if (error instanceof Error && error.name === 'CancelledError') {
          log({ event: 'cancelled', ...timing() });
          jobs.delete(job.hash);
          inflight.delete(job.hash);
          pump();

          return;
        }

        const attempts = job.attempts + 1;
        const message = error instanceof Error ? error.message : String(error);
        // 4xx (bad key, missing permission, bad request) won't fix itself: fail now.
        const permanent = /^ElevenLabs 4\d\d/.test(message);
        log({ event: 'failed', ...timing(), reason: message.slice(0, 200) });
        const delay =
          permanent || !retry ? undefined : retryDelays[attempts - 1];

        if (delay === undefined) {
          jobs.set(job.hash, {
            ...job,
            attempts,
            state: 'failed',
            reason: message,
            failedAt: now(),
          });
        } else {
          jobs.set(job.hash, { ...job, attempts, state: 'waiting' });
          schedule(() => {
            const current = jobs.get(job.hash);

            if (current?.state === 'waiting') {
              jobs.set(job.hash, { ...current, state: 'queued' });
              pump();
            }
          }, delay);
        }
      } finally {
        inflight.delete(job.hash);
      }

      args.onChange?.();
      pump();
    })();
    inflight.set(job.hash, attempt);

    return attempt;
  };

  const pump = (): void => {
    const [next] = [...jobs.values()]
      .filter((job) => job.state === 'queued')
      .sort((a, b) =>
        comparePriority(priorityOfHash(a.hash), priorityOfHash(b.hash))
      );

    if (next !== undefined && running() < concurrency) {
      run(next, true).catch(() => undefined);
      pump();
    }
  };

  /** Forget a failure old enough to be worth another try. */
  const expireFailure = (hash: string): void => {
    const existing = jobs.get(hash);

    if (
      existing?.state === 'failed' &&
      now() - (existing.failedAt ?? 0) > RETRY_FAILED_AFTER_MS
    ) {
      jobs.delete(hash);
    }
  };

  const overBudget = (podId: string, hash: string, text: string): boolean => {
    if (args.budget.allows(text.length)) {
      return false;
    }

    jobs.set(hash, {
      podId,
      hash,
      text,
      state: 'failed',
      attempts: 0,
      reason: 'over-budget',
      failedAt: now(),
    });

    return true;
  };

  /**
   * The whole background order, most important first (the server builds it:
   * the item on screen, its pod, then the inbox). Replaces the previous order:
   * a queued clip no longer in it — its item left the inbox — is dropped,
   * even mid-render. `settle: false` skips the settling wait (the item on
   * screen is being looked at now).
   */
  const prefetch = (
    items: { podId: string; text: string; settle?: boolean }[]
  ): void => {
    if (!args.enabled()) {
      return;
    }

    ranks.clear();
    items.forEach(({ text }, index) => {
      const hash = hashOf(text);

      if (!ranks.has(hash)) {
        ranks.set(hash, index);
      }
    });

    // Gone from the inbox and nobody is listening to it: drop it.
    [...jobs.values()]
      .filter(
        (job) =>
          !ranks.has(job.hash) &&
          !needs.has(job.hash) &&
          (job.state === 'queued' || job.state === 'rendering')
      )
      .forEach((job) => {
        if (job.state === 'queued') {
          jobs.delete(job.hash);

          return;
        }

        args.cancel?.(job.text);
      });

    items.forEach(({ podId, text, settle = true }) => {
      const hash = hashOf(text);
      expireFailure(hash);

      if (
        text === '' ||
        jobs.has(hash) ||
        storedDuration(podId, hash) !== null
      ) {
        return;
      }

      const firstSeen = seen.get(hash);

      if (!settle) {
        seen.set(hash, firstSeen ?? now());
      } else if (firstSeen === undefined) {
        seen.set(hash, now());

        if (settleMs > 0) {
          schedule(() => args.onChange?.(), settleMs + 100);

          return;
        }
      } else if (now() - firstSeen < settleMs) {
        return;
      }

      if (overBudget(podId, hash, text)) {
        return;
      }

      jobs.set(hash, {
        podId,
        hash,
        text,
        state: 'queued',
        attempts: 0,
        queuedAt: now(),
      });
    });
    pump();
    args.poke?.();
  };

  const clip = (podId: string, text: string): ClipStatus => {
    if (!args.enabled()) {
      return { status: 'unavailable', reason: 'no-key' };
    }

    const hash = hashOf(text);
    const duration = storedDuration(podId, hash);

    if (duration !== null) {
      return {
        status: 'ready',
        url: `/api/audio/${encodeURIComponent(podId)}/${hash}.mp3`,
        duration,
      };
    }

    const job = jobs.get(hash);

    if (job === undefined) {
      return seen.has(hash) ? { status: 'pending' } : { status: 'none' };
    }

    return job.state === 'failed'
      ? { status: 'unavailable', reason: job.reason ?? 'failed' }
      : { status: 'pending' };
  };

  /**
   * The player needs this clip: `now` (it is waiting to play it) or `soon`
   * (look-ahead). Renders at once, or joins the render already running — its
   * priority rises either way, effective at Kokoro's next piece.
   */
  const renderNow = async (
    podId: string,
    text: string,
    need: 'now' | 'soon' = 'now'
  ): Promise<ClipStatus> => {
    const current = clip(podId, text);

    if (current.status === 'ready' || text === '' || !args.enabled()) {
      return current;
    }

    const askedAt = now();

    const hash = hashOf(text);
    const asked = needs.get(hash);
    const level = need === 'now' ? 0 : 1;

    // Never downgrade: a look-ahead request for a clip already wanted "now".
    if (
      asked === undefined ||
      asked.focus !== state.focus ||
      level <= asked.level
    ) {
      needs.set(hash, { level, at: tick(), focus: state.focus });
    }

    args.poke?.();
    expireFailure(hash);
    const job = jobs.get(hash);

    if (job?.state === 'failed') {
      return clip(podId, text);
    }

    if (job === undefined && overBudget(podId, hash, text)) {
      return clip(podId, text);
    }

    // Jumps the queue: the owner is listening.
    await run(
      job ?? {
        podId,
        hash,
        text,
        state: 'queued',
        attempts: 0,
        queuedAt: askedAt,
      },
      false
    );

    const result = clip(podId, text);
    // How long the player waited: the number that decides whether audio
    // feels instant. `joined`: it was already rendering (look-ahead/prefetch).
    log({
      event: 'player-wait',
      podId,
      need,
      chars: text.length,
      waitedMs: now() - askedAt,
      joined: job?.state === 'rendering',
      status: result.status,
    });

    return result;
  };

  /** What's on screen (an item key or a pod page); re-prioritizes at once. */
  const setFocus = (focus: string | null): void => {
    if (focus === state.focus) {
      return;
    }

    state.focus = focus;
    pump();
    args.poke?.();
  };

  /** For the sidebar: what's queued or rendering, by pod. */
  const queued = (): { podId: string; text: string }[] =>
    [...jobs.values()]
      .filter((job) => job.state === 'queued' || job.state === 'rendering')
      .map(({ podId, text }) => ({ podId, text }));

  return {
    prefetch,
    clip,
    renderNow,
    hashOf,
    priorityOf,
    setFocus,
    queued,
  };
};

export type Renderer = ReturnType<typeof createRenderer>;
