import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from './api';

/**
 * Read aloud for a Lambda's page: its rail's sections, one clip each (the
 * same clips the Plan rail plays), with previous/next section and 1×/2×.
 */

export interface ReadAloudSection {
  id: string;
  text: string;
}

export interface ReadAloud {
  playing: boolean;
  /** The section playing or paused at; null before the first play. */
  at: string | null;
  speed: 1 | 2;
  /** Play from one section (or the first), or pause/resume. */
  toggle: () => void;
  playSection: (id: string) => void;
  step: (by: -1 | 1) => void;
  setSpeed: (speed: 1 | 2) => void;
  /** The last clip that wouldn't render. */
  trouble: string | null;
}

export const useReadAloud = (
  podId: string | null,
  sections: ReadAloudSection[]
): ReadAloud => {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState<string | null>(null);
  const [speed, setSpeedNow] = useState<1 | 2>(1);
  const [trouble, setTrouble] = useState<string | null>(null);
  const latest = useRef(sections);
  latest.current = sections;
  const speedRef = useRef(speed);
  speedRef.current = speed;

  const stop = useCallback(() => {
    audio.current?.pause();
    setPlaying(false);
  }, []);

  // Leaving the page stops it.
  useEffect(() => stop, [stop, podId]);

  const play = useCallback(
    (id: string): void => {
      const index = latest.current.findIndex((one) => one.id === id);
      const section = latest.current[index];

      if (podId === null || section === undefined) {
        stop();

        return;
      }

      setAt(id);
      setPlaying(true);
      setTrouble(null);
      api
        .ttsClip(podId, section.text, 'now')
        .then((clip) => {
          if (clip.status !== 'ready') {
            setTrouble("Read aloud isn't available right now.");
            setPlaying(false);

            return;
          }

          audio.current?.pause();
          const player = new Audio(clip.url);
          player.playbackRate = speedRef.current;
          player.onended = () => {
            const next = latest.current[index + 1];

            if (next === undefined) {
              setPlaying(false);

              return;
            }

            play(next.id);
          };
          audio.current = player;
          player.play().catch(() => setPlaying(false));
        })
        .catch(() => {
          setTrouble("Read aloud isn't available right now.");
          setPlaying(false);
        });
    },
    [podId, stop]
  );

  const toggle = (): void => {
    if (playing) {
      stop();

      return;
    }

    if (audio.current !== null && at !== null && !audio.current.ended) {
      audio.current.play().catch(() => setPlaying(false));
      setPlaying(true);

      return;
    }

    const [first] = sections;

    if (first !== undefined) {
      play(first.id);
    }
  };

  const step = (by: -1 | 1): void => {
    const index = sections.findIndex((one) => one.id === at);
    const next = sections[Math.max(0, index + by)];

    if (next !== undefined) {
      play(next.id);
    }
  };

  const setSpeed = (value: 1 | 2): void => {
    setSpeedNow(value);

    if (audio.current !== null) {
      audio.current.playbackRate = value;
    }
  };

  return {
    playing,
    at,
    speed,
    toggle,
    playSection: play,
    step,
    setSpeed,
    trouble,
  };
};
