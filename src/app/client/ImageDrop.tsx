import {
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';

import {
  imageUrl,
  splitImages,
  withImage,
  withoutImage,
} from '../shared/images';
import { api } from './api';

/** A drag the owner could mean as an image: files, or an image from a web page (a link). */
const droppable = (event: DragEvent): boolean => {
  const types = Array.from(event.dataTransfer.types);

  return types.includes('Files') || types.includes('text/uri-list');
};

/** The image link in an HTML drag (an <img> from another page), if any. */
const imageLink = (transfer: DataTransfer): string | null => {
  const html = transfer.getData('text/html');
  const fromHtml = /<img[^>]+src="([^"]+)"/i.exec(html)?.[1];

  if (fromHtml !== undefined) {
    return fromHtml.replace(/&amp;/g, '&');
  }

  const uri = transfer
    .getData('text/uri-list')
    .split('\n')
    .find((line) => line.trim() !== '' && !line.startsWith('#'));

  return uri === undefined ? null : uri.trim();
};

export interface ImageDropState {
  /** Spread on the element that should take drops (and pastes). */
  zone: {
    onDragEnter: (event: DragEvent<HTMLElement>) => void;
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDragLeave: (event: DragEvent<HTMLElement>) => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
    onPaste: (event: ClipboardEvent<HTMLElement>) => void;
  };
  over: boolean;
  /** Thumbnails, progress and errors — goes under the message box. */
  tray: ReactNode;
  /** Attach files picked another way (a "+" button's file picker). */
  attach: (files: File[]) => void;
}

/**
 * Drop (or paste) images into a message. Each one is uploaded and added to
 * the draft as an `[Image: …]` line — the agent opens that path with Read —
 * and shown as a thumbnail; the box itself shows only the words (`wordsOf`). Files of any image type (HEIC and the like are
 * converted on the server) and images dragged from a web page (a link the
 * server fetches) both work; anything else says why it can't be attached.
 */
export const useImageDrop = (
  value: string,
  onChange: (next: string) => void
): ImageDropState => {
  const [over, setOver] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Uploads finish after more typing: append to the draft as it is then.
  const latest = useRef(value);
  latest.current = value;
  // dragenter/leave fire for every child crossed: count, so the hint holds.
  const depth = useRef(0);

  const track = (upload: Promise<string>): void => {
    setError(null);
    setUploading((count) => count + 1);
    upload
      .then((filePath) => onChange(withImage(latest.current, filePath)))
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : String(failure))
      )
      .finally(() => setUploading((count) => count - 1));
  };

  const attachFiles = (files: File[]): void =>
    files.forEach((file) => track(api.uploadImage(file)));

  const zone: ImageDropState['zone'] = {
    onDragEnter: (event) => {
      if (droppable(event)) {
        depth.current += 1;
        setOver(true);
      }
    },
    onDragOver: (event) => {
      if (!droppable(event)) {
        return;
      }

      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (event) => {
      if (droppable(event)) {
        depth.current = Math.max(0, depth.current - 1);
        setOver(depth.current > 0);
      }
    },
    onDrop: (event) => {
      if (!droppable(event)) {
        return;
      }

      event.preventDefault();
      depth.current = 0;
      setOver(false);
      const files = Array.from(event.dataTransfer.files);

      if (files.length > 0) {
        attachFiles(files);

        return;
      }

      const link = imageLink(event.dataTransfer);

      if (link === null) {
        setError("That isn't an image I can attach.");

        return;
      }

      track(api.uploadImageUrl(link));
    },
    onPaste: (event) => {
      const files = Array.from(event.clipboardData.files);

      if (files.length > 0) {
        event.preventDefault();
        attachFiles(files);
      }
    },
  };

  const { images } = splitImages(value);
  const tray =
    images.length > 0 || uploading > 0 || error !== null ? (
      <div className="image-drop__tray">
        {images.map((filePath) => (
          <span key={filePath} className="image-drop__thumb">
            <img src={imageUrl(filePath) ?? ''} alt="Attached" />
            <button
              type="button"
              aria-label="Remove image"
              onClick={() => onChange(withoutImage(value, filePath))}
            >
              ✕
            </button>
          </span>
        ))}
        {uploading > 0 && (
          <span className="muted image-drop__status">Uploading…</span>
        )}
        {error !== null && (
          <span className="image-drop__status image-drop__error">{error}</span>
        )}
      </div>
    ) : null;

  return { zone, over, tray, attach: attachFiles };
};

/** A message box that takes dropped and pasted images. */
export const ImageDrop = ({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (next: string) => void;
  children: ReactNode;
}) => {
  const { zone, over, tray } = useImageDrop(value, onChange);
  const host = useRef<HTMLDivElement>(null);
  const imageCount = splitImages(value).images.length;
  const lastImageCount = useRef(imageCount);

  // An image just landed: its box takes focus, ready for words.
  useEffect(() => {
    if (imageCount > lastImageCount.current) {
      host.current?.querySelector('textarea')?.focus();
    }

    lastImageCount.current = imageCount;
  }, [imageCount]);

  return (
    <div
      ref={host}
      className={`image-drop${over ? ' image-drop--over' : ''}`}
      {...zone}
    >
      {children}
      {tray}
      {over && <div className="image-drop__hint">Drop to attach</div>}
    </div>
  );
};
