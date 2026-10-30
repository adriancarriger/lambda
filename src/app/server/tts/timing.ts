import { createHash } from 'crypto';

import type { Script, TimedSection } from '../../shared/speech';
import type { Alignment } from './elevenlabs';

/**
 * Section times from ElevenLabs' per-character timestamps. The alignment has
 * one entry per input character; if its length ever differs from the script
 * (normalisation), offsets are mapped proportionally rather than trusted 1:1.
 */
export const sectionTimes = (
  script: Script,
  alignment: Alignment
): { sections: TimedSection[]; duration: number } => {
  const count = alignment.starts.length;
  const duration = Math.max(0, ...alignment.ends);

  const timeAt = (offset: number): number => {
    if (count === 0 || script.text.length === 0) {
      return 0;
    }

    const index = Math.min(
      count - 1,
      Math.max(0, Math.round((offset * count) / script.text.length))
    );

    return alignment.starts[index] ?? 0;
  };

  const starts = script.sections.map((section) => timeAt(section.start));

  return {
    duration,
    sections: script.sections.map((section, index) => ({
      key: section.key,
      label: section.label,
      start: starts[index] ?? 0,
      end: starts[index + 1] ?? duration,
    })),
  };
};

/** Content-addressed: same voice + model + text ⇒ same file, never billed twice. */
export const audioHash = (
  voiceId: string,
  modelId: string,
  text: string
): string =>
  createHash('sha256')
    .update(`${voiceId}\n${modelId}\n${text}`)
    .digest('hex')
    .slice(0, 24);

/** `Range: bytes=a-b` → inclusive byte range, or null to serve the whole file. */
export const parseRange = (
  header: string | undefined,
  size: number
): { start: number; end: number } | null | 'unsatisfiable' => {
  if (header === undefined) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());

  if (match === null) {
    return null;
  }

  const [, rawStart = '', rawEnd = ''] = match;

  if (rawStart === '' && rawEnd === '') {
    return null;
  }

  // "bytes=-500" = the last 500 bytes.
  const start =
    rawStart === '' ? Math.max(0, size - Number(rawEnd)) : Number(rawStart);
  const end =
    rawStart === '' || rawEnd === ''
      ? size - 1
      : Math.min(Number(rawEnd), size - 1);

  return start > end || start >= size ? 'unsatisfiable' : { start, end };
};
