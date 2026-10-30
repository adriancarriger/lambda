import { Component, type ErrorInfo, type ReactNode, Suspense } from 'react';

import { uiLog } from './uiLog';

/** What shows instead of a screen whose chunk didn't load. */
export const UpdatedNotice = () => (
  <div className="caught-up">
    <p>Lambda was updated. Reload.</p>
    <button type="button" onClick={() => window.location.reload()}>
      Reload
    </button>
  </div>
);

/** What shows instead of a screen that crashed while drawing. */
export const CrashedNotice = () => (
  <div className="caught-up">
    <p>Something went wrong on this screen. Reload.</p>
    <button type="button" onClick={() => window.location.reload()}>
      Reload
    </button>
  </div>
);

/** What Chrome, Firefox and Safari say when a lazy chunk's file is gone. */
const CHUNK_LOAD_FAILED =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;

export const isChunkLoadError = (error: unknown): boolean =>
  error instanceof Error && CHUNK_LOAD_FAILED.test(error.message);

type Failed = 'chunk' | 'crash' | null;

/**
 * Around each lazy screen. A chunk can fail to load: the client was rebuilt
 * while this tab was open (the old hashed files are gone), or the network
 * dropped. Without this React unmounts the whole app and leaves a blank
 * page; with it, that screen says so and offers a reload. Any other error is
 * a crash: said as one and logged, never passed off as an update. A new
 * `resetKey` (another page opened) tries the screen again.
 */
export class ChunkBoundary extends Component<
  { children: ReactNode; resetKey?: string },
  { failed: Failed }
> {
  state: { failed: Failed } = { failed: null };

  static getDerivedStateFromError(error: unknown): { failed: Failed } {
    return { failed: isChunkLoadError(error) ? 'chunk' : 'crash' };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    uiLog('js-error', {
      message: error.message,
      where: (info.componentStack ?? '').trim().split('\n')[0]?.trim() ?? '',
    });
  }

  componentDidUpdate(previous: { resetKey?: string }): void {
    if (
      this.state.failed !== null &&
      previous.resetKey !== this.props.resetKey
    ) {
      this.setState({ failed: null });
    }
  }

  render() {
    if (this.state.failed === 'chunk') {
      return <UpdatedNotice />;
    }

    if (this.state.failed === 'crash') {
      return <CrashedNotice />;
    }

    return this.props.children;
  }
}

/** A lazy screen: its Suspense, inside the boundary. */
export const Lazy = ({
  fallback,
  resetKey,
  children,
}: {
  fallback: ReactNode;
  /** Changes when another page opens in this spot. */
  resetKey?: string;
  children: ReactNode;
}) => (
  <ChunkBoundary resetKey={resetKey}>
    <Suspense fallback={fallback}>{children}</Suspense>
  </ChunkBoundary>
);
