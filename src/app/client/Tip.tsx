import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const DELAY_MS = 120;
const WIDTH = 320;
const GUTTER = 12;

interface Position {
  left: number;
  top: number;
  above: boolean;
}

/**
 * A quick, styled tooltip (the native `title` one waits ~1s and can't be
 * styled). Rendered in a portal with fixed positioning so the sidebar's
 * overflow never clips it; flips above the anchor near the bottom edge.
 */
export const Tip = ({
  text,
  children,
  className,
}: {
  /** Plain text, or formatted content (the workflow panel's step details). */
  text: ReactNode;
  children: ReactNode;
  className?: string;
}) => {
  const anchor = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [position, setPosition] = useState<Position | null>(null);

  const clear = (): void => window.clearTimeout(timer.current);

  const show = (): void => {
    clear();
    timer.current = window.setTimeout(() => {
      const rect = anchor.current?.getBoundingClientRect();

      if (rect === undefined) {
        return;
      }

      // Rich tips run taller; flip above sooner for them.
      const above =
        rect.bottom + (typeof text === 'string' ? 140 : 300) >
        window.innerHeight;
      const left = Math.min(
        Math.max(GUTTER, rect.left),
        window.innerWidth - WIDTH - GUTTER
      );

      setPosition({
        left,
        top: above ? rect.top - 8 : rect.bottom + 8,
        above,
      });
    }, DELAY_MS);
  };

  const hide = (): void => {
    clear();
    setPosition(null);
  };

  useEffect(() => clear, []);

  if (text === '') {
    return <span className={className}>{children}</span>;
  }

  return (
    <span
      ref={anchor}
      className={className}
      tabIndex={0}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {position !== null &&
        createPortal(
          <div
            role="tooltip"
            className={`tip${position.above ? ' tip--above' : ''}`}
            style={{ left: position.left, top: position.top, width: WIDTH }}
          >
            {text}
          </div>,
          document.body
        )}
    </span>
  );
};
