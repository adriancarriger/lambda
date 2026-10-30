/**
 * Turn the raw bytes xterm emits into `tmux send-keys` calls.
 *
 * Raw bytes (`send-keys -H`) are right for printable text, but agent TUIs
 * such as Claude Code do NOT treat a raw CR byte as Enter — only tmux's named
 * key submits. So control bytes and the common escape sequences become named
 * keys; everything else stays raw. Returns one argument list per send-keys call.
 */

const NAMED_BYTES: Record<string, string> = {
  '0d': 'Enter',
  '0a': 'Enter',
  '7f': 'BSpace',
  '08': 'BSpace',
  '09': 'Tab',
  '03': 'C-c',
  '15': 'C-u',
};

/** ESC [ <final> sequences (and ESC O <final>, used in application mode). */
const NAMED_SEQUENCES: Record<string, string> = {
  '1b5b41': 'Up',
  '1b5b42': 'Down',
  '1b5b43': 'Right',
  '1b5b44': 'Left',
  '1b5b48': 'Home',
  '1b5b46': 'End',
  '1b4f41': 'Up',
  '1b4f42': 'Down',
  '1b4f43': 'Right',
  '1b4f44': 'Left',
  '1b5b5a': 'BTab',
};

export const toSendKeysCalls = (hex: string[]): string[][] => {
  const step = (at: number, raw: string[], calls: string[][]): string[][] => {
    const flush = (): string[][] =>
      raw.length > 0 ? [...calls, ['-H', ...raw]] : calls;

    if (at >= hex.length) {
      return flush();
    }

    const byte = hex[at] ?? '';
    const triple = hex.slice(at, at + 3).join('');
    const sequence = NAMED_SEQUENCES[triple];

    if (sequence !== undefined) {
      return step(at + 3, [], [...flush(), [sequence]]);
    }

    if (byte === '1b' && at === hex.length - 1) {
      return step(at + 1, [], [...flush(), ['Escape']]);
    }

    const named = NAMED_BYTES[byte];

    if (named !== undefined) {
      return step(at + 1, [], [...flush(), [named]]);
    }

    return step(at + 1, [...raw, byte], calls);
  };

  return step(0, [], []);
};
