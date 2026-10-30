import type { TimedSection } from '../shared/speech';

/**
 * The timeline math behind the player. Section times come from each clip's
 * real duration once known (an estimate from its words until then; see
 * usePlayer.ts). All times are seconds at 1× — the speed control scales
 * playback, not the axis.
 */

/** Index of the section playing at `time` (the last one that has started). */
export const sectionIndexAt = (
  sections: TimedSection[],
  time: number
): number =>
  sections.reduce(
    (found, section, index) => (time >= section.start ? index : found),
    0
  );

export const formatTime = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds));

  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};
