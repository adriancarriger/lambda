import {
  type ReactNode,
  Suspense,
  createContext,
  lazy,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import type { PrototypeGroup } from '../../pod-store';
import type { Device, Made, PrototypeRef } from '../shared/prototypes';
import { api } from './api';

/**
 * The prototype viewer's context and provider: the small part the signed-in
 * shell holds. The focus view and lightbox it opens (Prototypes.tsx) load
 * with the pod screen, or when first opened, not with the shell.
 */

const FocusView = lazy(() =>
  import('./Prototypes').then((module) => ({ default: module.FocusView }))
);
const Lightbox = lazy(() =>
  import('./Prototypes').then((module) => ({ default: module.Lightbox }))
);

export type ViewMode = 'single' | 'side';

export interface ViewTarget extends PrototypeRef {
  letter?: string;
  situation?: string | null;
  device?: Device;
  mode?: ViewMode;
}

type Open =
  | { kind: 'prototype'; target: ViewTarget }
  | { kind: 'picture'; path: string };

interface Viewer {
  podId: string;
  made: Made | null;
  refresh: () => void;
  openPrototype: (target: ViewTarget) => void;
  openPicture: (path: string) => void;
}

const ViewerContext = createContext<Viewer | null>(null);

/** The viewer for the Lambda on screen; null off a Lambda. */
export const useViewer = (): Viewer | null => useContext(ViewerContext);

export const groupOf = (
  made: Made | null,
  slug: string
): PrototypeGroup | undefined =>
  made?.prototypes.find((group) => group.slug === slug);

export const ViewerProvider = ({
  podId,
  refreshKey,
  onAddToChat,
  children,
}: {
  /** The Lambda on screen; off a Lambda there's nothing to view. */
  podId: string | null;
  /** Changes when the pod may have made something (its thread grew). */
  refreshKey: number;
  /** A pick from the focus view ("Going with C"), added to the chat box. */
  onAddToChat: (text: string) => void;
  children: ReactNode;
}) => {
  const [made, setMade] = useState<Made | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    setOpen(null);
    setMade(null);
  }, [podId]);

  useEffect(() => {
    if (podId === null) {
      return undefined;
    }

    const live = { current: true };
    api
      .made(podId)
      .then((next) => live.current && setMade(next))
      .catch(() => live.current && setMade(null));

    return () => {
      live.current = false;
    };
  }, [podId, refreshKey, tick]);

  // The inbox's own shortcuts (Space, ←/→, [ ]) step aside while it's open.
  useEffect(() => {
    document.body.classList.toggle('viewer-open', open !== null);

    return () => document.body.classList.remove('viewer-open');
  }, [open]);

  const value = useMemo<Viewer | null>(
    () =>
      podId === null
        ? null
        : {
            podId,
            made,
            refresh,
            openPrototype: (target) => {
              refresh();
              setOpen({ kind: 'prototype', target });
            },
            openPicture: (path) => setOpen({ kind: 'picture', path }),
          },
    [podId, made, refresh]
  );

  const group =
    open?.kind === 'prototype' ? groupOf(made, open.target.slug) : undefined;

  return (
    <ViewerContext.Provider value={value}>
      {children}
      {podId !== null &&
        open?.kind === 'prototype' &&
        group !== undefined &&
        createPortal(
          <Suspense fallback={null}>
            <FocusView
              key={`${open.target.slug}`}
              podId={podId}
              bases={made?.bases}
              group={group}
              initial={open.target}
              onClose={() => setOpen(null)}
              onAddToChat={onAddToChat}
            />
          </Suspense>,
          document.body
        )}
      {podId !== null &&
        open?.kind === 'picture' &&
        createPortal(
          <Suspense fallback={null}>
            <Lightbox
              podId={podId}
              made={made}
              start={open.path}
              onClose={() => setOpen(null)}
              onTry={(target) => setOpen({ kind: 'prototype', target })}
            />
          </Suspense>,
          document.body
        )}
    </ViewerContext.Provider>
  );
};
