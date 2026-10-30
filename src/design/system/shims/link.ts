import {
  type AnchorHTMLAttributes,
  type MouseEvent,
  createElement,
} from 'react';

/**
 * Stands in for `next/link` in a design system's bundle: the same `<a>`, but
 * a click stays on the canvas instead of leaving it.
 */
const Link = ({
  href,
  onClick,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
  createElement('a', {
    ...props,
    href,
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      onClick?.(event);
    },
  });

export default Link;
