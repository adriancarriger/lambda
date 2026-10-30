import * as fs from 'fs';
import * as zlib from 'zlib';

/** CRC-32, as every PNG chunk carries one. */
const crc32 = (bytes: Buffer): number => {
  const table = Array.from({ length: 256 }, (_, n) =>
    Array.from({ length: 8 }).reduce<number>(
      (c) => (c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1),
      n
    )
  );

  return (
    (bytes.reduce(
      (crc, byte) => (table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8),
      0xffffffff
    ) ^
      0xffffffff) >>>
    0
  );
};

const chunk = (type: string, data: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));

  return Buffer.concat([length, body, crc]);
};

/** A real width × height PNG of one RGB colour, written to `file`. */
export const writePng = (
  file: string,
  width: number,
  height: number,
  rgb: [number, number, number] = [200, 40, 40]
): string => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // truecolour
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: width }, () => rgb).flat()),
  ]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', zlib.deflateSync(pixels)),
      chunk('IEND', Buffer.alloc(0)),
    ])
  );

  return file;
};
