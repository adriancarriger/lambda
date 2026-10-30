/**
 * "Something's ready": a bright two-note rising chime, synthesized with Web
 * Audio (no asset to ship). Played when the inbox goes from empty to not.
 * Browsers only allow audio after a click or keypress on the page; before
 * that it is silently skipped.
 */

const context: { current: AudioContext | null } = { current: null };

const audioContext = (): AudioContext | null => {
  if (typeof window === 'undefined' || !('AudioContext' in window)) {
    return null;
  }

  if (context.current === null) {
    context.current = new AudioContext();
  }

  return context.current;
};

/** One bell-like note: a sine plus a soft octave, quick attack, ringing decay. */
const note = (
  ctx: AudioContext,
  frequency: number,
  at: number,
  length: number
): void => {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.35, at + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  gain.connect(ctx.destination);

  [
    { type: 'sine' as const, ratio: 1, level: 1 },
    { type: 'triangle' as const, ratio: 2, level: 0.25 },
  ].forEach(({ type, ratio, level }) => {
    const voice = ctx.createGain();
    voice.gain.value = level;
    voice.connect(gain);
    const oscillator = ctx.createOscillator();
    oscillator.type = type;
    oscillator.frequency.value = frequency * ratio;
    oscillator.connect(voice);
    oscillator.start(at);
    oscillator.stop(at + length + 0.05);
  });
};

export const playReadyChime = (): void => {
  const ctx = audioContext();

  if (ctx === null) {
    return;
  }

  const start = (): void => {
    const now = ctx.currentTime + 0.02;
    // E5 → B5 → E6: rising and unmistakable, under a second.
    note(ctx, 659.25, now, 0.45);
    note(ctx, 987.77, now + 0.13, 0.5);
    note(ctx, 1318.51, now + 0.26, 0.7);
  };

  if (ctx.state === 'suspended') {
    ctx
      .resume()
      .then(start)
      .catch(() => undefined);

    return;
  }

  start();
};

/**
 * "The chat answered": two soft falling notes (B5 → G5), quieter and shorter
 * than the ready chime, so the two are never confused. Every chat reply.
 */
export const playChatChime = (): void => {
  const ctx = audioContext();

  if (ctx === null) {
    return;
  }

  const start = (): void => {
    const now = ctx.currentTime + 0.02;
    note(ctx, 987.77, now, 0.3);
    note(ctx, 783.99, now + 0.11, 0.45);
  };

  if (ctx.state === 'suspended') {
    ctx
      .resume()
      .then(start)
      .catch(() => undefined);

    return;
  }

  start();
};
