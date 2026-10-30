/**
 * Browser-side speech helpers. What gets spoken (and the script/section
 * shaping) lives in ../shared/speech so the server pre-renders the identical
 * text; this file only holds the rate and Autoplay settings. There is no
 * browser-voice fallback (see usePlayer.ts).
 */
import type { Screen } from '../../pod-store';

export * from '../shared/speech';

export const MIN_RATE = 1;
export const MAX_RATE = 3.5;

export const clampRate = (rate: number): number =>
  Math.min(MAX_RATE, Math.max(MIN_RATE, Math.round(rate * 4) / 4));

const RATE_KEY = 'pods.speechRate';

export const loadRate = (): number => {
  try {
    const stored = Number(window.localStorage.getItem(RATE_KEY));

    return Number.isFinite(stored) && stored > 0 ? clampRate(stored) : 2.5;
  } catch {
    return 2.5;
  }
};

export const saveRate = (rate: number): void => {
  try {
    window.localStorage.setItem(RATE_KEY, String(rate));
  } catch {
    // Private window / blocked storage: the rate just won't persist.
  }
};

const AUTOPLAY_KEY = 'pods.autoplay';

/**
 * The Autoplay switch: when on, an item starts playing as it arrives and live
 * conversation replies are read aloud as they land. Off by default — nothing
 * plays until the owner presses play.
 */
/**
 * Autoplay isn't offered for now (2026-10-17: the switch is gone from
 * the player, the feature kept in case it comes back). While it isn't, it's off
 * — whatever an earlier switch saved.
 */
export const AUTOPLAY_OFFERED = false;

export const loadAutoplay = (): boolean => {
  if (!AUTOPLAY_OFFERED) {
    return false;
  }

  try {
    return window.localStorage.getItem(AUTOPLAY_KEY) === 'on';
  } catch {
    return false;
  }
};

export const saveAutoplay = (on: boolean): void => {
  try {
    window.localStorage.setItem(AUTOPLAY_KEY, on ? 'on' : 'off');
  } catch {
    // Not persisted; the switch still works for this page.
  }
};

const UX_VIEW_KEY = 'pods.uxView';

/** The UX review's Screens switch: the pictures (default), or the ASCII. */
export type UxView = 'pictures' | 'ascii';

export const loadUxView = (): UxView => {
  try {
    return window.localStorage.getItem(UX_VIEW_KEY) === 'ascii'
      ? 'ascii'
      : 'pictures';
  } catch {
    return 'pictures';
  }
};

export const saveUxView = (view: UxView): void => {
  try {
    window.localStorage.setItem(UX_VIEW_KEY, view);
  } catch {
    // Not persisted; the switch still works for this page.
  }
};

/** What one screen shows: its pictures only when chosen and it has some (older reviews have none). */
export const screenView = (
  saved: UxView,
  screen: Pick<Screen, 'pictures'>
): UxView =>
  saved === 'pictures' && (screen.pictures ?? []).length > 0
    ? 'pictures'
    : 'ascii';

/** What a picture's empty side says in place of its image. */
export const missingPictureText = (
  side: 'before' | 'after',
  screen: Pick<Screen, 'change' | 'noPhotoHook'>
): string => {
  if (side === 'after') {
    return 'Removed.';
  }

  if (screen.change === 'new') {
    return 'New screen — nothing here today.';
  }

  return screen.noPhotoHook === true
    ? 'No "before" picture: this codebase hasn\'t set up app photos.'
    : 'No screenshot of today.';
};
