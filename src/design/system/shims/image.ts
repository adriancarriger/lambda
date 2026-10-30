import { type ImgHTMLAttributes, createElement } from 'react';

/**
 * Stands in for `next/image` in a design system's bundle: a plain `<img>`
 * (a canvas has no image optimiser). Next's own props are dropped.
 */
const Image = ({
  src,
  fill,
  priority: _priority,
  quality: _quality,
  placeholder: _placeholder,
  blurDataURL: _blurDataURL,
  loader: _loader,
  unoptimized: _unoptimized,
  style,
  ...props
}: Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  src: string | { src: string };
  fill?: boolean;
  priority?: boolean;
  quality?: number;
  placeholder?: string;
  blurDataURL?: string;
  loader?: unknown;
  unoptimized?: boolean;
}) =>
  createElement('img', {
    ...props,
    src: typeof src === 'string' ? src : src.src,
    style:
      fill === true
        ? {
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            ...style,
          }
        : style,
  });

export default Image;
