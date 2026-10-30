/**
 * Images the owner drops into a message. The server saves each one under
 * `<pods root>/_uploads/` and the message carries it as its own line,
 * `[Image: /abs/path.png]`, so the agent can open it with Read. The inbox
 * shows those lines as thumbnails.
 */

/** Uploaded file names: `img_<time>_<random>.<ext>` — no "XX-123" a ticket id could match. */
export const UPLOAD_NAME = /^img_[a-z0-9]+_[a-z0-9]+\.(?:png|jpe?g|gif|webp)$/;

export const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const IMAGE_LINE = /^\[Image: (\S+)\][ \t]*$/;

export const imageLine = (filePath: string): string => `[Image: ${filePath}]`;

/** The message's own words, and the images it carries (paths, in order). */
export const splitImages = (
  text: string
): { text: string; images: string[] } => {
  const lines = text.split('\n');
  const images = lines.flatMap((line) => {
    const match = IMAGE_LINE.exec(line.trim());

    return match?.[1] === undefined ? [] : [match[1]];
  });
  const words = lines
    .filter((line) => !IMAGE_LINE.test(line.trim()))
    .join('\n')
    .trim();

  return { text: words, images };
};

/** Where the inbox serves an uploaded image, or null for a path it doesn't own. */
export const imageUrl = (filePath: string): string | null => {
  const name = filePath.split('/').at(-1) ?? '';

  return UPLOAD_NAME.test(name) ? `/api/uploads/${name}` : null;
};

/**
 * A picture a pod links by its path on disk (`![Home](<root>/<pod>/shots/x.png)`)
 * — where the inbox serves it, or the src as given when it isn't one.
 */
export const podImageSrc = (src: string): string => {
  const match = /\/([a-z0-9-]+)\/((?:designs|shots)\/[^?#]+\.png)$/.exec(src);

  return src.startsWith('/') && !src.startsWith('/api/') && match !== null
    ? `/api/pod-file/${match[1]}/${match[2]}`
    : src;
};

/** Append an image line to a draft, on a line of its own. */
export const withImage = (draft: string, filePath: string): string => {
  const trimmed = draft.replace(/\s+$/, '');

  return trimmed === ''
    ? `${imageLine(filePath)}\n`
    : `${trimmed}\n${imageLine(filePath)}\n`;
};

/**
 * The words of a draft as typed — its image lines left out, nothing trimmed
 * (a trailing space or new line is mid-typing). What the message box shows.
 */
export const wordsOf = (draft: string): string => {
  const lines = draft.split('\n');
  // `withImage` ends the draft with a new line after the image; that one is
  // the image's, not a blank line they typed.
  const own =
    lines.at(-1) === '' && IMAGE_LINE.test((lines.at(-2) ?? '').trim())
      ? lines.slice(0, -1)
      : lines;

  return own.filter((line) => !IMAGE_LINE.test(line.trim())).join('\n');
};

/** The draft with new words, keeping the images it carries (after the words). */
export const withWords = (draft: string, words: string): string => {
  const { images } = splitImages(draft);

  return images.length === 0
    ? words
    : `${words}\n${images.map(imageLine).join('\n')}`;
};

/** A draft without one of its images. */
export const withoutImage = (draft: string, filePath: string): string =>
  draft
    .split('\n')
    .filter((line) => line.trim() !== imageLine(filePath))
    .join('\n');
