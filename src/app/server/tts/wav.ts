/**
 * Raw samples as a WAV file: what a Kokoro clip is served as when ffmpeg
 * isn't on the machine (the Mac app doesn't carry it). Bigger than MP3, but
 * every browser plays it.
 */

export const WAV_TYPE = 'audio/wav';
export const MP3_TYPE = 'audio/mpeg';

/** 32-bit float mono → 16-bit PCM mono WAV. */
export const encodeWav = (
  samples: Float32Array,
  sampleRate: number
): Buffer => {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    data.writeInt16LE(Math.round(clamped * 0x7fff), index * 2);
  });

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
};

export const isWav = (bytes: Buffer): boolean =>
  bytes.length >= 12 &&
  bytes.toString('ascii', 0, 4) === 'RIFF' &&
  bytes.toString('ascii', 8, 12) === 'WAVE';

/** A clip's type, by its bytes: clips keep one file name whatever they hold. */
export const audioTypeOf = (bytes: Buffer): string =>
  isWav(bytes) ? WAV_TYPE : MP3_TYPE;
