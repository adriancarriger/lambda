import type { ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { imageUrl, podImageSrc, splitImages } from '../shared/images';
import { podFileOf, splitPrototypeLines } from '../shared/prototypes';
import { PrototypeCard, useViewer } from './Prototypes';

/**
 * A picture in agent text. One of this Lambda's own opens the lightbox
 * (every picture it made, ← →); anything else opens in a tab.
 */
const PictureLink = ({ src, alt }: { src?: string; alt?: string }) => {
  const viewer = useViewer();
  const own = src === undefined ? null : podFileOf(src);

  return (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        if (viewer !== null && own !== null && own.podId === viewer.podId) {
          event.preventDefault();
          viewer.openPicture(own.path);
        }
      }}
    >
      <img className="md__img" src={src} alt={alt} />
    </a>
  );
};

/** Agent text as markdown (GitHub flavour: tables, task lists, strikethrough). */
export const Markdown = ({ text }: { text: string }) => (
  <div className="md">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
        img: ({ src, alt }) => <PictureLink src={src} alt={alt} />,
      }}
      // A pod's own picture, linked by its path on disk, is served by the
      // inbox; the default's unsafe-protocol check still applies.
      urlTransform={(url) => defaultUrlTransform(podImageSrc(url))}
    >
      {text}
    </ReactMarkdown>
  </div>
);

const Images = ({ paths }: { paths: string[] }) =>
  paths.length === 0 ? null : (
    <div className="msg__images">
      {paths.map((filePath) => {
        const url = imageUrl(filePath);

        return url === null ? (
          <code key={filePath}>{filePath}</code>
        ) : (
          <a key={filePath} href={url} target="_blank" rel="noreferrer">
            <img src={url} alt="Attached" />
          </a>
        );
      })}
    </div>
  );

/**
 * One message, laid out like Claude Code: Claude's text sits on the page as
 * markdown; the owner's is a right-aligned bubble, as typed, with any images they
 * attached. A label (the manager speaking, a progress update) is a quiet note under it.
 */
export const Message = ({
  from,
  text,
  label,
  progress = false,
  latest = false,
  className = '',
  children,
}: {
  from: 'you' | 'claude';
  text: string;
  /** A quiet note under the text — omit for a plain "You"/"Claude". */
  label?: string;
  progress?: boolean;
  /** The newest message on an attention card (outlined). */
  latest?: boolean;
  className?: string;
  /** Extra controls under the text (e.g. Retry). */
  children?: ReactNode;
}) => {
  const { text: withoutImages, images } = splitImages(text);
  const { text: words, prototypes } = splitPrototypeLines(withoutImages);

  return (
    <div
      className={`msg msg--${from}${progress ? ' msg--progress' : ''}${
        latest ? ' msg--latest' : ''
      }${className === '' ? '' : ` ${className}`}`}
    >
      {from === 'claude' ? (
        <Markdown text={words} />
      ) : (
        words !== '' && <p className="msg__text">{words}</p>
      )}
      {prototypes.map((ref) => (
        <PrototypeCard key={`${ref.slug}@${ref.version}`} refOf={ref} />
      ))}
      <Images paths={images} />
      {label !== undefined && <span className="msg__label">{label}</span>}
      {children}
    </div>
  );
};
