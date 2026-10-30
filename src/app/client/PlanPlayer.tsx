import { type PointerEvent, type ReactNode, useRef, useState } from 'react';

import { MAX_RATE } from './speech';
import { formatTime, sectionIndexAt } from './timeline';
import type { Player } from './usePlayer';

/**
 * The audio, in the Plan rail's footer next to Done: one row (prev, play,
 * next, speed, Autoplay) with a hairline of progress along the footer's top
 * edge — itself a seek bar: click or drag anywhere on it; hovering names the
 * time and section. Anything about the audio that needs them ("click to enable
 * audio", out of budget…) shows above the row.
 */

/** The speed button steps through these, then back to 1× (W/S fine-tune). */
const STEPS = [1, 1.25, 1.5, 1.75, 2, 2.5, 3, MAX_RATE];

const nextStep = (rate: number): number =>
  STEPS.find((step) => step > rate + 0.01) ?? STEPS[0] ?? 1;

const Glyph = ({ children }: { children: ReactNode }) => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="currentColor"
    aria-hidden="true"
  >
    {children}
  </svg>
);

/**
 * A control's tooltip, above it (the player sits at the bottom): what it does,
 * and its keys. Shown on hover or keyboard focus, after a beat.
 */
const Tip = ({
  text,
  keys,
  children,
}: {
  text: string;
  /** Each a key or chord with what it does, e.g. ['Space'] or ['W', 'faster']. */
  keys?: [string, string?][];
  children: ReactNode;
}) => (
  <span className="control-tip">
    {children}
    <span className="control-tip__box" role="tooltip">
      {text}
      {keys !== undefined && (
        <span className="control-tip__keys">
          {keys.map(([key, what]) => (
            <span key={key}>
              <kbd>{key}</kbd>
              {what === undefined ? '' : ` ${what}`}
            </span>
          ))}
        </span>
      )}
    </span>
  </span>
);

export const PlanPlayer = ({
  player,
  notices,
  actions,
  onSeekSection,
  onStep,
}: {
  player: Player;
  /** A click or drag on the line landed in this section: bring it into view. */
  onSeekSection: (key: string) => void;
  /** ⏮ / ⏭: a section step they asked for — the rail brings it to the top. */
  onStep: () => void;
  /** "Click to enable audio", out of budget… — shown above the row. */
  notices: ReactNode;
  /** Done and friends, at the row's right end. */
  actions: ReactNode;
}) => {
  const line = useRef<HTMLDivElement>(null);
  /** Where a drag along the line has got to (seconds), until it's let go. */
  const [drag, setDrag] = useState<number | null>(null);
  const [hover, setHover] = useState<{ x: number; time: number } | null>(null);
  const disabled = player.source === 'none' || player.duration <= 0;
  const progress =
    player.duration > 0 ? Math.min(1, player.time / player.duration) : 0;

  // The section under the pointer, named as the big bar names it.
  const hoverLabel =
    hover === null
      ? undefined
      : player.sections[sectionIndexAt(player.sections, hover.time)]?.label;

  const xAt = (event: PointerEvent<HTMLDivElement>): number => {
    const rect = line.current?.getBoundingClientRect();

    return rect === undefined
      ? 0
      : Math.min(Math.max(0, event.clientX - rect.left), rect.width);
  };

  const timeAt = (event: PointerEvent<HTMLDivElement>): number => {
    const width = line.current?.getBoundingClientRect().width ?? 0;

    return width === 0 ? 0 : (xAt(event) / width) * player.duration;
  };

  return (
    <div className="plan-player">
      {/* The hairline is the seek bar: click or drag anywhere along it. */}
      <div
        ref={line}
        className={`plan-player__scrub${
          disabled ? ' plan-player__scrub--off' : ''
        }`}
        role="slider"
        aria-label="Audio position"
        aria-valuemin={0}
        aria-valuemax={Math.round(player.duration)}
        aria-valuenow={Math.round(drag ?? player.time)}
        onPointerDown={(event) => {
          if (disabled) {
            return;
          }

          event.currentTarget.setPointerCapture(event.pointerId);
          setDrag(timeAt(event));
        }}
        onPointerMove={(event) => {
          setHover({ x: xAt(event), time: timeAt(event) });

          if (drag !== null) {
            setDrag(timeAt(event));
          }
        }}
        onPointerUp={() => {
          if (drag !== null) {
            player.seek(drag);
            setDrag(null);
            const landed =
              player.sections[sectionIndexAt(player.sections, drag)]?.key;

            if (landed !== undefined) {
              onSeekSection(landed);
            }
          }
        }}
        onPointerLeave={() => setHover(null)}
      >
        <div
          className="plan-player__progress"
          style={{
            width: `${
              (drag === null
                ? progress
                : player.duration > 0
                ? drag / player.duration
                : 0) * 100
            }%`,
          }}
        />
        {hover !== null && !disabled && (
          <span className="plan-player__time" style={{ left: hover.x }}>
            {formatTime(hover.time)}
            {hoverLabel === undefined ? '' : ` · ${hoverLabel}`}
          </span>
        )}
      </div>

      {notices !== null && (
        <div className="plan-player__notices">{notices}</div>
      )}

      <div className="plan-player__row">
        <Tip
          text="Back to the start of this section — or, at its start, the one before."
          keys={[['A'], ['⇧←']]}
        >
          <button
            type="button"
            className="plan-player__button"
            aria-label="Previous section"
            disabled={disabled}
            onClick={() => {
              onStep();
              player.previous();
            }}
          >
            <Glyph>
              <path d="M6 5h2v14H6zM20 5v14L9.5 12z" />
            </Glyph>
          </button>
        </Tip>
        <Tip
          text={
            player.playing
              ? 'Pause the plan being read aloud.'
              : 'Read the plan aloud from here.'
          }
          keys={[['Space'], ['←', 'back 5s'], ['→', 'ahead 5s']]}
        >
          <button
            type="button"
            className={`plan-player__button plan-player__button--play${
              player.loadingKey !== null || player.extra?.loading === true
                ? ' plan-player__button--loading'
                : ''
            }`}
            aria-label={player.playing ? 'Pause' : 'Play'}
            disabled={disabled}
            onClick={player.toggle}
          >
            <Glyph>
              {player.playing ? (
                <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
              ) : (
                <path d="M8 5v14l11-7z" />
              )}
            </Glyph>
          </button>
        </Tip>
        <Tip text="Skip to the next section." keys={[['D'], ['⇧→']]}>
          <button
            type="button"
            className="plan-player__button"
            aria-label="Next section"
            disabled={disabled}
            onClick={() => {
              onStep();
              player.next();
            }}
          >
            <Glyph>
              <path d="M16 5h2v14h-2zM4 5v14l10.5-7z" />
            </Glyph>
          </button>
        </Tip>
        <Tip
          text="Reading speed. Click for the next step; after the fastest it goes back to 1×."
          keys={[
            ['W', 'faster'],
            ['S', 'slower'],
          ]}
        >
          <button
            type="button"
            className="plan-player__rate"
            aria-label="Reading speed"
            onClick={() => player.setRate(nextStep(player.rate))}
          >
            {Number(player.rate.toFixed(2))}×
          </button>
        </Tip>
        {/* Autoplay: not offered for now (speech.ts, AUTOPLAY_OFFERED). */}
        <span className="plan-player__actions">{actions}</span>
      </div>
    </div>
  );
};
