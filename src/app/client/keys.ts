/**
 * xterm hands us typed data as a string (including escape sequences for arrows
 * etc.). tmux `send-keys -H` takes raw bytes as hex, which carries every key
 * through unchanged — no key-name mapping table to keep in sync.
 */
export const toHexBytes = (data: string): string[] =>
  Array.from(new TextEncoder().encode(data)).map((byte) =>
    byte.toString(16).padStart(2, '0')
  );

/** Inputs that take typing — not switches, sliders or buttons. */
const TEXT_INPUTS = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
]);

/** Is the user typing in a text field (so playback shortcuts must not fire)? */
export const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.tagName === 'TEXTAREA' ||
    (target instanceof HTMLInputElement && TEXT_INPUTS.has(target.type)) ||
    target.isContentEditable ||
    target.closest('.xterm') !== null);
