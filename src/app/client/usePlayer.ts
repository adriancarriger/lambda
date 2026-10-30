import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  type SectionKey,
  type SpokenSection,
  type TimedSection,
  sectionParts,
} from '../shared/speech';
import type { AudioMeta, ClipStatus } from '../shared/types';
import { api } from './api';
import { type ChatTrack, nextChunk } from './chatPlaylist';
import { waitForClip } from './clipWait';
import { loadPlace, savePlace } from './planPlace';
import {
  clampRate,
  loadAutoplay,
  loadRate,
  saveAutoplay,
  saveRate,
} from './speech';
import { sectionIndexAt } from './timeline';
import { uiLog } from './uiLog';

/**
 * The inbox's audio player. Each section is cut into PARTS (sectionParts: a
 * short first one, then longer ones) and each part is its own clip, rendered
 * the moment the player needs it (plus two ahead) and cached on the server by
 * its exact text — so the first words of any section come after one short
 * render, the rest render while it plays, jumping anywhere works, and replays
 * are free. The timeline they see is still per section.
 *
 * There is NO browser-voice fallback (2026-10-12). A clip that isn't ready yet is waited for — the player
 * shows "Preparing audio…" — and one that can't be rendered at all is asked
 * for again, then reported ("Audio unavailable") instead of read by another
 * voice. Waits land in `<pods root>/_ui.log` (audio-wait / audio-play) and the
 * server's side in `<pods root>/_tts.log`.
 *
 * The timeline is in seconds at 1×: a section's span is its clip's real
 * duration once known, an estimate from its words until then.
 */

export type PlayerSource = 'elevenlabs' | 'unavailable' | 'none';

/** Browsers block audio until the first click/keypress on the page. */
const unlock = { done: false, listeners: new Set<() => void>() };

if (typeof window !== 'undefined') {
  const onGesture = (): void => {
    if (!unlock.done) {
      unlock.done = true;
      unlock.listeners.forEach((listener) => listener());
    }
  };
  window.addEventListener('pointerdown', onGesture, { capture: true });
  window.addEventListener('keydown', onGesture, { capture: true });
}

/** A clip that came back unavailable is asked for this many more times… */
const CLIP_RETRIES = 2;
/** …this far apart (a Kokoro worker restart takes a few seconds). */
const CLIP_RETRY_GAP_MS = 3_000;
/** How long a playExtra / reply waits before giving up on its clip. */
const EXTRA_WAIT_MS = 120_000;
/** Clips rendered ahead of the one playing. */
const AHEAD = 2;
/** ~160 words per minute at 1×, plus a short pause — until the real duration is known. */
const WORDS_PER_SECOND = 2.7;
const SECTION_PAUSE = 0.4;

const estimate = (text: string): number =>
  text.split(/\s+/).filter((word) => word !== '').length / WORDS_PER_SECOND +
  SECTION_PAUSE;

type Ready = { url: string; duration: number };

const readyOf = (clip: ClipStatus | undefined): Ready | null =>
  clip?.status === 'ready' ? { url: clip.url, duration: clip.duration } : null;

const sleep = (ms: number): Promise<null> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(null), ms);
  });

export const usePlayer = (args: {
  itemKey: string | null;
  podId: string | null;
  sections: SpokenSection[] | null;
  audio: AudioMeta | undefined;
  title: string;
  artist: string;
}) => {
  const [rate, setRateState] = useState(loadRate);
  const [autoplay, setAutoplayState] = useState(loadAutoplay);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [needsGesture, setNeedsGesture] = useState(false);
  /** The section waiting on its clip (a spinner on its dot, "Preparing audio…"). */
  const [loadingKey, setLoadingKey] = useState<SectionKey | null>(null);
  /** Why playback stopped: a clip that could not be rendered. */
  const [audioError, setAudioError] = useState<string | null>(null);
  /** Clips fetched on demand for this item, by section key. */
  const [fetched, setFetched] = useState<Record<string, Ready>>({});
  /** The chat message the chat playlist is on (see playChat). */
  const [chat, setChat] = useState<{
    msgId: string;
    loading: boolean;
    paused: boolean;
  } | null>(null);

  /** Every clip in order: `key` is the part's, `section` its section's. */
  const speech = useMemo(
    () =>
      (args.sections ?? []).flatMap((section) =>
        sectionParts(section).map((part) => ({
          key: part.key,
          section: section.key,
          label: section.label,
          text: part.text,
        }))
      ),
    [args.sections]
  );

  const clipFor = useCallback(
    (key: string): Ready | null =>
      fetched[key] ?? readyOf(args.audio?.clips[key]),
    [fetched, args.audio]
  );

  /** Each part's span: what playback steps through. */
  const parts: TimedSection[] = useMemo(
    () =>
      speech.reduce<TimedSection[]>((line, part) => {
        const start = line.at(-1)?.end ?? 0;
        const length = clipFor(part.key)?.duration ?? estimate(part.text);

        return [
          ...line,
          { key: part.key, label: part.label, start, end: start + length },
        ];
      }, []),
    [speech, clipFor]
  );

  /** Each section's span (its parts end to end): what they see and seek by. */
  const timeline: { sections: TimedSection[]; duration: number } = useMemo(
    () => ({
      sections: speech.reduce<TimedSection[]>((line, part, index) => {
        const span = parts[index];
        const last = line.at(-1);

        if (span === undefined) {
          return line;
        }

        if (last?.key === part.section) {
          return [...line.slice(0, -1), { ...last, end: span.end }];
        }

        return [
          ...line,
          {
            key: part.section,
            label: part.label,
            start: span.start,
            end: span.end,
          },
        ];
      }, []),
      duration: parts.at(-1)?.end ?? 0,
    }),
    [speech, parts]
  );

  const clips = Object.values(args.audio?.clips ?? {});
  const source: PlayerSource =
    speech.length === 0
      ? 'none'
      : clips.length > 0 && clips.every((clip) => clip.status === 'unavailable')
      ? 'unavailable'
      : 'elevenlabs';

  // Latest values for callbacks that outlive a render.
  const live = useRef({
    rate,
    speech,
    parts,
    timeline,
    time,
    playing,
    podId: args.podId,
    itemKey: args.itemKey,
    clipFor,
    chatPlaying: false,
    chatLoading: false,
  });
  live.current = {
    rate,
    speech,
    parts,
    timeline,
    time,
    playing,
    podId: args.podId,
    itemKey: args.itemKey,
    clipFor,
    chatPlaying: chat !== null,
    chatLoading: chat?.loading === true,
  };

  const element = useRef<HTMLAudioElement | null>(null);
  /** Bumped on every stop/seek: a stale run's callbacks do nothing. */
  const run = useRef(0);
  /** The part playing in the current run. */
  const playingIndex = useRef(0);
  const requests = useRef(
    new Map<string, { promise: Promise<Ready | null>; need: 'now' | 'soon' }>()
  );

  const audioElement = useCallback((): HTMLAudioElement => {
    if (element.current === null) {
      const created = new Audio();
      created.preload = 'auto';
      created.preservesPitch = true;
      element.current = created;
    }

    return element.current;
  }, []);

  /**
   * This part's clip: cached, or rendered now. `now`: the player is
   * waiting to play it; `soon`: look-ahead. One request per part — except
   * that a look-ahead still pending when the player reaches it asks again as
   * `now`, which raises its priority on the server (Kokoro's next piece).
   */
  const ensureClip = useCallback(
    (index: number, need: 'now' | 'soon' = 'now'): Promise<Ready | null> => {
      const section = live.current.speech[index];
      const { podId } = live.current;

      if (section === undefined || podId === null) {
        return Promise.resolve(null);
      }

      const known = live.current.clipFor(section.key);

      if (known !== null) {
        return Promise.resolve(known);
      }

      const pending = requests.current.get(section.text);

      if (
        pending !== undefined &&
        (pending.need === 'now' || need === 'soon')
      ) {
        return pending.promise;
      }

      const request = api
        .ttsClip(podId, section.text, need)
        .then((clip) => {
          const ready = readyOf(clip);

          if (ready !== null) {
            setFetched((previous) => ({ ...previous, [section.key]: ready }));
          }

          return ready;
        })
        .catch(() => null);
      requests.current.set(section.text, { promise: request, need });

      return request;
    },
    []
  );

  // On-demand extras (a screen's edge cases): one clip outside the item's
  // sequence, rendered only when asked for.
  const [extra, setExtra] = useState<{ key: string; loading: boolean } | null>(
    null
  );
  const extraRun = useRef(0);
  const extraAudio = useRef<HTMLAudioElement | null>(null);

  const stopExtra = useCallback((): void => {
    extraRun.current += 1;
    extraAudio.current?.pause();
    setExtra(null);
  }, []);

  // The Chat panel's playlist: from the message pressed to the newest.
  const chatRun = useRef(0);
  const chatAudio = useRef<HTMLAudioElement | null>(null);
  /** Where the chat playlist is, so the shortcuts can steer it. */
  const chatAt = useRef<{
    podId: string;
    at: { id: string; chunk: number };
    tracks: () => ChatTrack[];
  } | null>(null);
  const chatPaused = useRef(false);

  const stopChat = useCallback((): void => {
    chatRun.current += 1;
    chatAudio.current?.pause();
    chatAt.current = null;
    chatPaused.current = false;
    setChat(null);
  }, []);

  /** Space on a playing chat message: pause it, or carry on. */
  const toggleChat = useCallback((): void => {
    chatPaused.current = !chatPaused.current;
    const paused = chatPaused.current;
    setChat((now) => (now === null ? null : { ...now, paused }));

    if (paused) {
      chatAudio.current?.pause();

      return;
    }

    // Still loading: the clip plays by itself once it's ready.
    if (!live.current.chatLoading) {
      chatAudio.current?.play().catch(() => undefined);
    }
  }, []);

  /** The item's own playback, leaving the chat playlist alone. */
  const stopItem = useCallback((): void => {
    run.current += 1;
    element.current?.pause();
    setPlaying(false);
    setLoadingKey(null);
  }, []);

  const stopAll = useCallback((): void => {
    stopItem();
    stopExtra();
    stopChat();
  }, [stopItem, stopExtra, stopChat]);

  /** Play `text` on its own (press again to stop). Not part of the timeline. */
  const playExtra = useCallback(
    (key: string, text: string): void => {
      const { podId } = live.current;

      if (extra?.key === key) {
        stopExtra();

        return;
      }

      stopAll();
      // Pressing the button is the gesture browsers need before audio.
      unlock.done = true;
      extraRun.current += 1;
      const { current } = extraRun;
      setExtra({ key, loading: true });
      const speed = live.current.rate;
      const done = (): void => {
        if (extraRun.current === current) {
          setExtra(null);
        }
      };

      Promise.race([
        podId === null
          ? Promise.resolve(null)
          : api
              .ttsClip(podId, text, 'now')
              .then(readyOf)
              .catch(() => null),
        sleep(EXTRA_WAIT_MS),
      ])
        .then((ready) => {
          if (extraRun.current !== current) {
            return;
          }

          setExtra({ key, loading: false });

          if (ready === null) {
            uiLog('audio-unavailable', { kind: 'extra', key });
            setAudioError('This audio could not be prepared.');
            done();

            return;
          }

          const audio = extraAudio.current ?? new Audio();
          audio.preservesPitch = true;
          extraAudio.current = audio;
          audio.src = ready.url;
          audio.playbackRate = speed;
          audio.onended = done;
          audio.play().catch(done);
        })
        .catch(done);
    },
    [extra, stopAll, stopExtra]
  );

  /**
   * Play the chat from message `msgId` through the newest (press the playing
   * one again to stop). `tracks` is read afresh at every step, so messages
   * that arrive meanwhile are played too.
   */
  const startChat = useCallback(
    (
      podId: string,
      from: { id: string; chunk: number },
      tracks: () => ChatTrack[]
    ): void => {
      stopAll();
      // Pressing the button is the gesture browsers need before audio.
      unlock.done = true;
      setAudioError(null);
      chatRun.current += 1;
      const { current } = chatRun;
      const asked = new Map<string, Promise<Ready | null>>();
      const clip = (
        text: string,
        need: 'now' | 'soon'
      ): Promise<Ready | null> => {
        const known = asked.get(text);

        if (known !== undefined && need === 'soon') {
          return known;
        }

        const request = api
          .ttsClip(podId, text, need)
          .then(readyOf)
          .catch(() => null);
        asked.set(text, request);

        return request;
      };
      const textOf = (
        at: { id: string; chunk: number } | null
      ): string | null =>
        at === null
          ? null
          : tracks().find((track) => track.id === at.id)?.chunks[at.chunk] ??
            null;

      const step = (at: { id: string; chunk: number } | null): void => {
        if (chatRun.current !== current) {
          return;
        }

        const text = textOf(at);

        if (at === null || text === null) {
          uiLog('audio-chat-end', {});
          chatAt.current = null;
          setChat(null);

          return;
        }

        chatAt.current = { podId, at, tracks };
        setChat({ msgId: at.id, loading: true, paused: chatPaused.current });
        const first = clip(text, 'now');
        // One ahead: the next chunk, or the next message's first.
        const ahead = textOf(nextChunk(tracks(), at.id, at.chunk));

        if (ahead !== null) {
          clip(ahead, 'soon').catch(() => undefined);
        }

        const askedAt = performance.now();
        waitForClip(first, {
          again: () => clip(text, 'now'),
          retries: CLIP_RETRIES,
          gapMs: CLIP_RETRY_GAP_MS,
          sleep,
          cancelled: () => chatRun.current !== current,
        })
          .then((ready) => {
            if (chatRun.current !== current) {
              return;
            }

            if (ready === null) {
              uiLog('audio-unavailable', { kind: 'chat', msgId: at.id });
              setAudioError('Audio unavailable for this chat message.');
              setChat(null);

              return;
            }

            uiLog('audio-play', {
              kind: 'chat',
              msgId: at.id,
              chunk: at.chunk,
              waitedMs: Math.round(performance.now() - askedAt),
            });
            setChat({
              msgId: at.id,
              loading: false,
              paused: chatPaused.current,
            });
            const audio = chatAudio.current ?? new Audio();
            audio.preservesPitch = true;
            chatAudio.current = audio;
            audio.src = ready.url;
            audio.playbackRate = live.current.rate;
            audio.onended = () => step(nextChunk(tracks(), at.id, at.chunk));

            // Paused while it loaded: Space starts it.
            if (chatPaused.current) {
              return;
            }

            audio.play().catch(() => {
              if (chatRun.current === current) {
                setChat(null);
              }
            });
          })
          .catch(() => setChat(null));
      };

      step(from);
    },
    [stopAll]
  );

  /**
   * A message's 🔊: play from it through the newest. Pressing the one that's
   * playing stops it; pressing it while paused carries on.
   */
  const playChat = useCallback(
    (podId: string, msgId: string, tracks: () => ChatTrack[]): void => {
      if (chat?.msgId === msgId) {
        if (chat.paused) {
          toggleChat();

          return;
        }

        stopChat();

        return;
      }

      startChat(podId, { id: msgId, chunk: 0 }, tracks);
    },
    [chat, startChat, stopChat, toggleChat]
  );

  /** ⇧→ / D: the next message. ⇧← / A: back to this one's start, or the one before. */
  const stepChat = useCallback(
    (direction: 1 | -1): void => {
      const place = chatAt.current;

      if (place === null) {
        return;
      }

      const tracks = place.tracks();
      const index = tracks.findIndex((track) => track.id === place.at.id);
      const heard =
        place.at.chunk > 0 || (chatAudio.current?.currentTime ?? 0) > 1.5;
      const target =
        direction === 1
          ? tracks[index + 1]
          : heard
          ? tracks[index]
          : tracks[index - 1] ?? tracks[index];

      if (target === undefined) {
        stopChat();

        return;
      }

      startChat(place.podId, { id: target.id, chunk: 0 }, place.tracks);
    },
    [startChat, stopChat]
  );

  /** Play part `index` from `offset` seconds, then carry on to the next. */
  const playSection = useCallback(
    (index: number, offset: number, current: number): void => {
      const section = live.current.speech[index];
      const span = live.current.parts[index];

      if (section === undefined || span === undefined) {
        setPlaying(false);
        setTime(live.current.timeline.duration);

        return;
      }

      playingIndex.current = index;
      setPlaying(true);
      setTime(span.start + offset);
      // Was this clip's render already under way (requested ahead)?
      const inFlight = requests.current.has(section.text);
      // Ask for THIS clip before the ones ahead: the server renders requests in
      // the order they arrive, and a jump must not wait behind its look-ahead.
      const clip = ensureClip(index);
      // Render ahead while this one plays.
      Array.from(
        { length: AHEAD },
        (_unused, step) => index + 1 + step
      ).forEach((ahead) => {
        ensureClip(ahead, 'soon').catch(() => undefined);
      });

      const next = (): void => {
        if (run.current === current) {
          playSection(index + 1, 0, current);
        }
      };

      const known = live.current.clipFor(section.key);
      const askedAt = performance.now();

      if (known === null) {
        setLoadingKey(section.section);
        uiLog('audio-wait', { section: section.key, inFlight });
      }

      waitForClip(clip, {
        again: () => {
          requests.current.delete(section.text);

          return ensureClip(index);
        },
        retries: CLIP_RETRIES,
        gapMs: CLIP_RETRY_GAP_MS,
        sleep,
        cancelled: () => run.current !== current,
      })
        .then((ready) => ready ?? live.current.clipFor(section.key))
        .then((ready) => {
          if (run.current !== current) {
            return;
          }

          setLoadingKey(null);

          if (ready === null) {
            uiLog('audio-unavailable', {
              section: section.key,
              waitedMs: Math.round(performance.now() - askedAt),
            });
            setAudioError(
              `Audio unavailable for "${section.label}" — it could not be rendered.`
            );
            setPlaying(false);

            return;
          }

          if (known === null) {
            uiLog('audio-play', {
              section: section.key,
              waitedMs: Math.round(performance.now() - askedAt),
            });
          }

          const audio = audioElement();

          if (audio.src !== new URL(ready.url, window.location.href).href) {
            audio.src = ready.url;
          }

          audio.playbackRate = live.current.rate;
          audio.currentTime = Math.min(
            offset,
            Math.max(0, ready.duration - 0.05)
          );
          audio.onended = next;
          audio.play().catch(() => setNeedsGesture(true));
        })
        .catch(next);
    },
    [audioElement, ensureClip]
  );

  const playAt = useCallback(
    (at: number): void => {
      if (!unlock.done) {
        setNeedsGesture(true);

        return;
      }

      setNeedsGesture(false);
      setAudioError(null);
      stopAll();
      const { parts: line } = live.current;
      const index = sectionIndexAt(line, at);
      const start = line[index]?.start ?? 0;
      playSection(index, Math.max(0, at - start), run.current);
    },
    [playSection, stopAll]
  );

  // Progress: the clip's own clock while it plays; the estimate's otherwise.
  useEffect(() => {
    if (!playing) {
      return undefined;
    }

    const frame = { id: 0 };
    const tick = (): void => {
      const audio = element.current;
      const span = live.current.parts[playingIndex.current];

      if (span !== undefined && audio !== null && !audio.paused) {
        setTime(span.start + audio.currentTime);
      }

      frame.id = requestAnimationFrame(tick);
    };
    frame.id = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frame.id);
  }, [playing]);

  // ── remember the position (see planPlace.ts) ──────────────────────────
  // At most once a second while playing; at once when paused or seeking.
  const savedAt = useRef(0);
  /** The item whose place has been put back (restorePlace) — saving waits for it. */
  const restoredFor = useRef<string | null>(null);

  useEffect(() => {
    const { itemKey } = args;

    if (itemKey === null || (playing && Date.now() - savedAt.current < 1_000)) {
      return;
    }

    // Not until this item's place has been put back: its 0:00 before then
    // isn't where they are, and saving it would wipe where they were.
    if (restoredFor.current !== itemKey) {
      return;
    }

    const line = live.current.timeline;
    const section = line.sections[sectionIndexAt(line.sections, time)];

    if (section === undefined) {
      return;
    }

    savedAt.current = Date.now();
    savePlace(itemKey, {
      audio: {
        section: section.key,
        offset: Math.max(0, time - section.start),
      },
    });
    // Keyed on the position only: the item is read as it is now.
  }, [time, playing]);

  /**
   * Put the position back where they left this item (planPlace.ts). Needs the
   * item's sections: until they're known (a reload, before the card has
   * loaded) it waits, and nothing is saved meanwhile. Returns where it put it.
   */
  const restorePlace = (): number => {
    const { itemKey } = args;
    const line = live.current.timeline;

    if (itemKey === null || line.sections.length === 0) {
      setTime(0);

      return 0;
    }

    const place = loadPlace(itemKey)?.audio;
    const section = line.sections.find((item) => item.key === place?.section);
    const resumeAt =
      place === undefined || section === undefined
        ? 0
        : Math.min(
            section.start + place.offset,
            Math.max(0, line.duration - 0.05)
          );
    setTime(resumeAt);
    savedAt.current = Date.now();
    restoredFor.current = itemKey;

    return resumeAt;
  };
  const sectionsKnown = timeline.sections.length > 0;

  useEffect(() => {
    if (
      sectionsKnown &&
      args.itemKey !== null &&
      restoredFor.current !== args.itemKey &&
      !live.current.playing
    ) {
      restorePlace();
    }
  }, [args.itemKey, sectionsKnown]);

  // ── item changes: load it; play only if Autoplay is on ────────────────
  // The chat playlist keeps going across items unless Autoplay starts one.
  useEffect(() => {
    stopItem();
    stopExtra();
    setAudioError(null);
    setFetched({});
    requests.current = new Map();
    // Pick up where they were in this item's audio, if they've been here before
    // (or as soon as its sections are known — see the effect below).
    restoredFor.current = null;
    const resumeAt = restorePlace();

    if (args.itemKey === null || speech.length === 0 || !loadAutoplay()) {
      setNeedsGesture(false);

      return undefined;
    }

    const start = (): void => playAt(resumeAt);

    if (unlock.done) {
      start();

      return stopItem;
    }

    setNeedsGesture(true);
    unlock.listeners.add(start);

    return () => {
      unlock.listeners.delete(start);
      stopItem();
    };
    // Deliberately keyed on item identity only: a state refresh of the same
    // item must not restart playback. Latest values are read through refs.
  }, [args.itemKey]);

  // ── public controls ───────────────────────────────────────────────────
  // While a chat message plays, the controls are its.
  const pause = useCallback((): void => {
    if (live.current.chatPlaying) {
      if (!chatPaused.current) {
        toggleChat();
      }

      return;
    }

    stopAll();
  }, [stopAll, toggleChat]);

  const toggle = useCallback((): void => {
    if (live.current.chatPlaying) {
      toggleChat();

      return;
    }

    if (live.current.playing) {
      pause();

      return;
    }

    const { time: at, timeline: line } = live.current;
    playAt(at >= line.duration - 0.05 ? 0 : at);
  }, [pause, playAt, toggleChat]);

  const seek = useCallback(
    (to: number, keepPlaying?: boolean): void => {
      const { timeline: line, playing: isPlaying } = live.current;
      const at = Math.min(Math.max(0, to), Math.max(0, line.duration - 0.05));

      if (keepPlaying === true || isPlaying) {
        playAt(at);

        return;
      }

      setTime(at);
    },
    [playAt]
  );

  /** A section's 🔊 or dot: jump there and play from it. */
  const seekSection = useCallback(
    (key: SectionKey): void => {
      const target = live.current.timeline.sections.find(
        (section) => section.key === key
      );

      if (target !== undefined) {
        seek(target.start, true);
      }
    },
    [seek]
  );

  const stepSection = useCallback(
    (direction: 1 | -1): void => {
      if (live.current.chatPlaying) {
        stepChat(direction);

        return;
      }

      const { timeline: line, time: at } = live.current;
      const index = sectionIndexAt(line.sections, at);
      const current = line.sections[index];
      // "Previous" restarts the current section unless we are at its very start.
      const target =
        direction === -1 && current !== undefined && at - current.start > 1.5
          ? current
          : line.sections[index + direction];

      if (target !== undefined) {
        seek(target.start, true);
      }
    },
    [seek, stepChat]
  );

  const skip = useCallback(
    (seconds: number): void => {
      const audio = chatAudio.current;

      if (!live.current.chatPlaying) {
        seek(live.current.time + seconds);

        return;
      }

      if (audio === null || live.current.chatLoading) {
        return;
      }

      audio.currentTime = Math.min(
        Math.max(0, audio.currentTime + seconds),
        Math.max(0, audio.duration - 0.05)
      );
    },
    [seek]
  );

  const setRate = useCallback((next: number): void => {
    const clamped = clampRate(next);
    setRateState(clamped);
    saveRate(clamped);

    if (element.current !== null) {
      element.current.playbackRate = clamped;
    }

    if (chatAudio.current !== null) {
      chatAudio.current.playbackRate = clamped;
    }
  }, []);

  const setAutoplay = useCallback((on: boolean): void => {
    setAutoplayState(on);
    saveAutoplay(on);
  }, []);

  /**
   * Live conversation replies (Autoplay on only): stream the reply's audio as
   * it renders. If it fails, nothing is read — the text is already on screen,
   * and audio never holds it back.
   */
  const sayReply = useCallback(
    (podId: string, msgId: string): void => {
      // A playing chat playlist reaches the reply by itself.
      if (!loadAutoplay() || live.current.chatPlaying) {
        return;
      }

      stopAll();
      const askedAt = performance.now();
      const stream = new Audio(
        `/api/tts/stream?podId=${encodeURIComponent(
          podId
        )}&msgId=${encodeURIComponent(msgId)}`
      );
      stream.preservesPitch = true;
      stream.playbackRate = live.current.rate;
      const failed = (): void => {
        uiLog('audio-unavailable', { kind: 'reply', msgId });
        stream.removeAttribute('src');
      };
      stream.addEventListener(
        'playing',
        () =>
          uiLog('audio-play', {
            kind: 'reply',
            msgId,
            waitedMs: Math.round(performance.now() - askedAt),
          }),
        { once: true }
      );
      stream.addEventListener('error', failed, { once: true });
      stream.play().catch(failed);
    },
    [stopAll]
  );

  // ── headphones / lock screen ──────────────────────────────────────────
  useEffect(() => {
    if (!('mediaSession' in navigator) || args.itemKey === null) {
      return;
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: args.title,
      artist: args.artist,
      album: 'Lambda',
    });
    navigator.mediaSession.setActionHandler('play', () => toggle());
    navigator.mediaSession.setActionHandler('pause', () => pause());
    navigator.mediaSession.setActionHandler('nexttrack', () => stepSection(1));
    navigator.mediaSession.setActionHandler('previoustrack', () =>
      stepSection(-1)
    );
    navigator.mediaSession.setActionHandler('seekforward', () => skip(10));
    navigator.mediaSession.setActionHandler('seekbackward', () => skip(-10));
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime !== undefined) {
        seek(details.seekTime);
      }
    });
  }, [
    args.itemKey,
    args.title,
    args.artist,
    toggle,
    pause,
    stepSection,
    skip,
    seek,
  ]);

  const activeKey =
    source === 'none' || (!playing && time === 0)
      ? null
      : timeline.sections[sectionIndexAt(timeline.sections, time)]?.key ?? null;

  return {
    source,
    playing,
    time,
    duration: timeline.duration,
    sections: timeline.sections,
    activeKey,
    loadingKey,
    audioError,
    dismissAudioError: () => setAudioError(null),
    needsGesture,
    rate,
    autoplay,
    toggle,
    pause,
    stop: stopAll,
    seek,
    seekSection,
    next: () => stepSection(1),
    previous: () => stepSection(-1),
    skip,
    setRate,
    setAutoplay,
    sayReply,
    /** The on-demand clip playing / loading (by key), if any. */
    extra,
    playExtra,
    /** The chat message playing / loading, if the chat playlist is on. */
    chat,
    playChat,
    enable: () => {
      unlock.done = true;
      setNeedsGesture(false);
      playAt(live.current.time);
    },
  };
};

export type Player = ReturnType<typeof usePlayer>;
