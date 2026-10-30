import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import type {
  PrototypeBoard,
  PrototypeGroup,
  PrototypeManifest,
} from '../../pod-store';
import type { ThreadMessage } from '../../pod-store';
import {
  type Device,
  type Made,
  type MadePicture,
  type PrototypeRef,
  messageShows,
  pictureOnPrototype,
} from '../shared/prototypes';
import { type ViewMode, type ViewTarget, groupOf, useViewer } from './Viewer';
import { api } from './api';

export { groupOf, useViewer } from './Viewer';
export type { ViewMode, ViewTarget } from './Viewer';

/**
 * Trying a Lambda's prototypes in the inbox (2026-10-20):
 *
 * - a chat message with `[Prototype: <slug> v<n>]` shows a card — the
 *   board's picture, every board side by side, and Try it — pinned to the
 *   version it was sent with;
 * - Try it opens the focus view over the inbox: the live prototype in a
 *   sandboxed frame, its situations switched from the inbox's own bar, one
 *   board, all side by side, or a phone; New tab opens one board full
 *   screen; Pick puts their choice in the chat box;
 * - a picture opens the lightbox, every picture this Lambda made a ← → away;
 * - the Made here rail lists all of it for the Lambda on screen.
 *
 * The frame only talks through the bridge the server adds to each board
 * (server/prototypes.ts BRIDGE_SCRIPT).
 */

export const fileSrc = (podId: string, file: string): string =>
  `/api/pod-file/${encodeURIComponent(podId)}/${file
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;

/**
 * A board's URL: its version's folder as the mothership gave it (`bases`,
 * from /api/made, carrying the link token a sandboxed frame needs), plus the
 * board's file. No folder yet: nothing to load.
 */
const frameSrc = (
  bases: Made['bases'],
  manifest: PrototypeManifest,
  board: PrototypeBoard
): string => {
  const base = bases?.[`${manifest.slug}/v${manifest.version}`];

  return base === undefined
    ? 'about:blank'
    : `${base}${board.file.split('/').map(encodeURIComponent).join('/')}`;
};

const boardOf = (
  manifest: PrototypeManifest,
  letter: string | undefined
): PrototypeBoard | undefined =>
  manifest.boards.find((board) => board.letter === letter) ??
  manifest.boards[0];

/** The board's picture in a situation, else its first, else nothing. */
export const stillOf = (
  board: PrototypeBoard,
  situation: string | null | undefined
): string | undefined =>
  (situation === null || situation === undefined
    ? undefined
    : board.stills[situation]) ?? Object.values(board.stills)[0];

/** The first situation the board was photographed in. */
const firstSituation = (
  manifest: PrototypeManifest,
  board: PrototypeBoard | undefined
): string | null =>
  manifest.situations.find(
    (situation) => board?.stills[situation.slug] !== undefined
  )?.slug ??
  manifest.situations[0]?.slug ??
  null;

const situationTitle = (
  manifest: PrototypeManifest,
  slug: string | null
): string =>
  slug === null
    ? 'As it opens'
    : manifest.situations.find((situation) => situation.slug === slug)?.title ??
      slug;

export const PrototypeCard = ({ refOf }: { refOf: PrototypeRef }) => {
  const viewer = useViewer();
  const group = groupOf(viewer?.made ?? null, refOf.slug);
  const manifest = group?.versions.find(
    (version) => version.version === refOf.version
  );
  const latest = group?.versions[0];
  const [letter, setLetter] = useState<string | undefined>(undefined);

  if (viewer === null) {
    return null;
  }

  if (manifest === undefined) {
    return (
      <div className="proto-card proto-card--missing">
        <span className="proto-card__kicker">Prototype</span>
        <span className="muted">
          {viewer.made === null
            ? 'Loading…'
            : `${refOf.slug} v${refOf.version} isn't saved in this Lambda.`}
        </span>
      </div>
    );
  }

  const board = boardOf(manifest, letter);
  const situation = firstSituation(manifest, board);
  const still = board === undefined ? undefined : stillOf(board, situation);
  const open = (target: Partial<ViewTarget> = {}): void =>
    viewer.openPrototype({
      slug: manifest.slug,
      version: manifest.version,
      letter: board?.letter,
      situation,
      ...target,
    });

  return (
    <div
      className="proto-card"
      data-prototype={`${manifest.slug}@${manifest.version}`}
    >
      <header className="proto-card__head">
        <span className="proto-card__kicker">Prototype</span>
        <strong>{manifest.title}</strong>
        <span className="proto-card__version">
          v{manifest.version}
          {latest !== undefined && latest.version > manifest.version ? (
            <button
              type="button"
              className="link-button"
              onClick={() =>
                open({ version: latest.version, letter: board?.letter })
              }
            >
              v{latest.version} is newer →
            </button>
          ) : (
            <span className="proto-card__latest" title="The newest version">
              ●
            </span>
          )}
        </span>
      </header>
      <button
        type="button"
        className="proto-card__still"
        title="Try it"
        onClick={() => open()}
      >
        {still === undefined ? (
          <span className="muted">{board?.title}</span>
        ) : (
          <img
            src={fileSrc(viewer.podId, still)}
            alt={`${manifest.title} — ${board?.letter} ${
              board?.title
            }, ${situationTitle(manifest, situation)}`}
          />
        )}
        <span className="proto-card__try">⤢ Try it</span>
      </button>
      {manifest.boards.length > 1 && (
        <div className="proto-card__boards" role="tablist">
          {manifest.boards.map((candidate) => {
            const thumb = stillOf(
              candidate,
              firstSituation(manifest, candidate)
            );

            return (
              <button
                key={candidate.letter}
                type="button"
                role="tab"
                aria-selected={candidate.letter === board?.letter}
                className={`proto-card__board${
                  candidate.letter === board?.letter
                    ? ' proto-card__board--on'
                    : ''
                }`}
                onClick={() => setLetter(candidate.letter)}
              >
                {thumb !== undefined && (
                  <img src={fileSrc(viewer.podId, thumb)} alt="" />
                )}
                <span>
                  <strong>{candidate.letter}</strong> {candidate.title}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {manifest.note !== undefined && (
        <p className="proto-card__note">
          {manifest.version > 1
            ? `Changed since v${manifest.version - 1}: `
            : ''}
          {manifest.note}
        </p>
      )}
      <footer className="proto-card__foot">
        <span className="muted">
          {manifest.situations.length === 0
            ? 'One situation'
            : `${manifest.situations.length} situation${
                manifest.situations.length === 1 ? '' : 's'
              }`}{' '}
          · desktop + phone
        </span>
        {manifest.boards.length > 1 && (
          <button
            type="button"
            className="link-button"
            onClick={() => open({ mode: 'side' })}
          >
            ⊞ Compare
          </button>
        )}
      </footer>
    </div>
  );
};

// ── the focus view ──────────────────────────────────────────────────────────

const PHONE = { w: 390, h: 844 };

/** The size of an element, kept up to date. */
const useSize = (): [
  (node: HTMLDivElement | null) => void,
  { width: number; height: number }
] => {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();

    if (node === null) {
      return;
    }

    const measure = (): void =>
      setSize({ width: node.clientWidth, height: node.clientHeight });
    observer.current = new ResizeObserver(measure);
    observer.current.observe(node);
    measure();
  }, []);

  return [ref, size];
};

/**
 * Whether the bar's button groups fit on one line. Once they wrap (a narrow
 * window, or text zoomed up) they become dropdowns, and come back when the
 * bar is as wide as they needed.
 */
const useRoomyBar = (): [(node: HTMLElement | null) => void, boolean] => {
  const [bar, setBar] = useState<HTMLElement | null>(null);
  const [roomy, setRoomy] = useState(true);
  const needed = useRef(0);

  useLayoutEffect(() => {
    if (bar === null) {
      return undefined;
    }

    const check = (): void => {
      if (!roomy) {
        if (bar.clientWidth >= needed.current) {
          setRoomy(true);
        }

        return;
      }

      const items = Array.from(bar.children).filter(
        (item): item is HTMLElement =>
          item instanceof HTMLElement &&
          !item.classList.contains('proto-view__spacer')
      );
      const firstRowEnd = Math.min(
        ...items.map((item) => item.offsetTop + item.offsetHeight)
      );

      if (!items.some((item) => item.offsetTop >= firstRowEnd)) {
        return;
      }

      const style = getComputedStyle(bar);
      needed.current =
        items.reduce((sum, item) => sum + item.offsetWidth, 0) +
        (parseFloat(style.columnGap) || 0) * items.length +
        parseFloat(style.paddingLeft) +
        parseFloat(style.paddingRight);
      setRoomy(false);
    };
    const observer = new ResizeObserver(check);
    observer.observe(bar);
    check();

    return () => observer.disconnect();
  }, [bar, roomy]);

  return [setBar, roomy];
};

const isBridgeMessage = (
  data: unknown
): data is { lambda: 'prototype'; type: string } & Record<string, unknown> =>
  typeof data === 'object' &&
  data !== null &&
  'lambda' in data &&
  data.lambda === 'prototype' &&
  'type' in data &&
  typeof data.type === 'string';

const FOCUS_KEYS = /^[1-9]$/;

export const FocusView = ({
  podId,
  bases,
  group,
  initial,
  onClose,
  onAddToChat,
}: {
  podId: string;
  bases: Made['bases'];
  group: PrototypeGroup;
  initial: ViewTarget;
  onClose: () => void;
  onAddToChat: (text: string) => void;
}) => {
  const [newest] = group.versions;
  const [version, setVersion] = useState(initial.version);
  const manifest =
    group.versions.find((candidate) => candidate.version === version) ?? newest;
  const [letter, setLetter] = useState(
    initial.letter ?? manifest?.boards[0]?.letter ?? 'A'
  );
  const [situation, setSituation] = useState<string | null>(
    initial.situation === undefined
      ? manifest === undefined
        ? null
        : firstSituation(manifest, boardOf(manifest, initial.letter))
      : initial.situation
  );
  const [device, setDevice] = useState<Device>(initial.device ?? 'desktop');
  const [mode, setMode] = useState<ViewMode>(initial.mode ?? 'single');
  const [fit, setFit] = useState<'fit' | 'actual'>('fit');
  /** Situations a board reports having (its own `data-state` switches). */
  const [reported, setReported] = useState<string[]>([]);
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  const [stageRef, stage] = useSize();
  const [barRef, roomy] = useRoomyBar();

  const board = manifest === undefined ? undefined : boardOf(manifest, letter);
  const shown =
    manifest === undefined
      ? []
      : mode === 'side' && device === 'desktop'
      ? manifest.boards
      : board === undefined
      ? []
      : [board];
  const situations =
    manifest === undefined
      ? []
      : manifest.situations.length > 0
      ? manifest.situations
      : reported.map((slug) => ({ slug, title: slug }));

  const post = useCallback(
    (frameLetter: string | null, message: Record<string, unknown>) => {
      frames.current.forEach((frame, key) => {
        if (frameLetter === null || frameLetter === key) {
          frame.contentWindow?.postMessage(message, '*');
        }
      });
    },
    []
  );

  // Every frame shows the situation.
  useEffect(() => {
    if (situation !== null) {
      post(null, { type: 'state', slug: situation });
    }
  }, [situation, post, version, mode, device]);

  // What the boards say: they're ready, a switch they clicked, Esc.
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const from = Array.from(frames.current.entries()).find(
        ([, frame]) => frame.contentWindow === event.source
      );

      if (from === undefined || !isBridgeMessage(event.data)) {
        return;
      }

      const { data } = event;

      if (data.type === 'escape') {
        onClose();

        return;
      }

      if (data.type === 'ready') {
        const states = Array.isArray(data.states)
          ? data.states.filter(
              (state): state is string => typeof state === 'string'
            )
          : [];
        setReported((before) =>
          before.join() === states.join() ? before : states
        );

        return;
      }

      // They switched it inside the board: the bar (and the other boards) follow.
      if (data.type === 'switched' && typeof data.state === 'string') {
        setSituation(data.state);

        return;
      }
    };
    window.addEventListener('message', onMessage);

    return () => window.removeEventListener('message', onMessage);
  }, [onClose]);

  // Keys, when the frame and the box don't have them.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const typing =
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLInputElement;

      if (event.key === 'Escape') {
        if (typing && event.target instanceof HTMLElement) {
          event.target.blur();

          return;
        }

        event.preventDefault();
        onClose();

        return;
      }

      if (typing || manifest === undefined) {
        return;
      }

      if (FOCUS_KEYS.test(event.key)) {
        const next = manifest.boards[Number(event.key) - 1];

        if (next !== undefined) {
          event.preventDefault();
          setLetter(next.letter);
        }

        return;
      }
    };
    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [manifest, onClose]);

  if (manifest === undefined || board === undefined) {
    return null;
  }

  /** Into the one chat box, to finish and send there; the view closes. */
  const addToChat = (text: string): void => {
    onAddToChat(text);
    onClose();
  };

  const gap = 8;
  const columns = shown.length;
  const frameSize = (candidate: PrototypeBoard) =>
    device === 'phone' ? PHONE : { w: candidate.w, h: candidate.h };
  const scaleOf = (candidate: PrototypeBoard): number => {
    const size = frameSize(candidate);
    const room = Math.max(
      1,
      (stage.width - gap * (columns + 1)) / Math.max(1, columns)
    );

    if (fit === 'actual' && columns === 1) {
      return 1;
    }

    if (device === 'phone') {
      return Math.min(
        1,
        room / size.w,
        Math.max(0.3, (stage.height - 48) / size.h)
      );
    }

    // The whole window in view, like a browser: the page scrolls inside it,
    // never the view around it. Side by side leaves room for the names and
    // Pick buttons.
    const chrome = columns > 1 ? 88 : 16;

    return Math.min(1, room / size.w, (stage.height - chrome) / size.h);
  };

  const pickLine = (candidate: PrototypeBoard): string =>
    `Going with ${candidate.letter} (${candidate.title}).`;

  return (
    <div
      className="proto-view"
      role="dialog"
      aria-modal="true"
      aria-label={`${manifest.title} prototype`}
      onMouseDown={(event) => {
        // A click on the dimmed margin hands the keys back, then closes.
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="proto-view__panel">
        <header ref={barRef} className="proto-view__bar">
          <strong className="proto-view__title">{manifest.title}</strong>
          <span className="proto-view__version">
            {group.versions.length > 1 ? (
              <select
                aria-label="Version"
                value={manifest.version}
                onChange={(event) => setVersion(Number(event.target.value))}
              >
                {group.versions.map((candidate) => (
                  <option key={candidate.version} value={candidate.version}>
                    v{candidate.version}
                    {candidate.version === newest?.version ? ' (newest)' : ''}
                  </option>
                ))}
              </select>
            ) : (
              `v${manifest.version}`
            )}
          </span>
          {manifest.boards.length > 1 && !roomy && (
            <select
              className="proto-view__pick"
              aria-label="Board"
              value={board.letter}
              onChange={(event) => setLetter(event.target.value)}
            >
              {manifest.boards.map((candidate) => (
                <option key={candidate.letter} value={candidate.letter}>
                  {candidate.letter} {candidate.title}
                </option>
              ))}
            </select>
          )}
          {manifest.boards.length > 1 && roomy && (
            <span className="seg" role="tablist" aria-label="Board">
              {manifest.boards.map((candidate, index) => (
                <button
                  key={candidate.letter}
                  type="button"
                  role="tab"
                  aria-selected={candidate.letter === board.letter}
                  className={`seg__button${
                    candidate.letter === board.letter ? ' seg__button--on' : ''
                  }`}
                  title={`${candidate.title} (${index + 1})`}
                  onClick={() => setLetter(candidate.letter)}
                >
                  {candidate.letter}
                  <span className="proto-view__board-name">
                    {' '}
                    {candidate.title}
                  </span>
                </button>
              ))}
            </span>
          )}
          {!roomy && (
            <select
              className="proto-view__pick"
              aria-label="View"
              value={device === 'phone' ? 'phone' : mode}
              onChange={(event) => {
                const { value } = event.target;

                if (value === 'phone') {
                  setDevice('phone');

                  return;
                }

                setMode(value === 'side' ? 'side' : 'single');
                setDevice('desktop');
              }}
            >
              <option value="single">▭ One board</option>
              {manifest.boards.length > 1 && (
                <option value="side">⊞ Side by side</option>
              )}
              <option value="phone">▯ Phone</option>
            </select>
          )}
          {roomy && (
            <span className="seg" aria-label="View">
              <button
                type="button"
                className={`seg__button${
                  mode === 'single' && device === 'desktop'
                    ? ' seg__button--on'
                    : ''
                }`}
                title="One board"
                onClick={() => {
                  setMode('single');
                  setDevice('desktop');
                }}
              >
                ▭
              </button>
              {manifest.boards.length > 1 && (
                <button
                  type="button"
                  className={`seg__button${
                    mode === 'side' && device === 'desktop'
                      ? ' seg__button--on'
                      : ''
                  }`}
                  title="Side by side"
                  onClick={() => {
                    setMode('side');
                    setDevice('desktop');
                  }}
                >
                  ⊞
                </button>
              )}
              <button
                type="button"
                className={`seg__button${
                  device === 'phone' ? ' seg__button--on' : ''
                }`}
                title="Phone (390 × 844)"
                onClick={() => setDevice('phone')}
              >
                ▯
              </button>
            </span>
          )}
          {situations.length > 0 && !roomy && (
            <select
              className="proto-view__pick"
              aria-label="Situation"
              value={situation ?? ''}
              onChange={(event) => setSituation(event.target.value)}
            >
              {situations.map((candidate) => (
                <option key={candidate.slug} value={candidate.slug}>
                  {candidate.title}
                </option>
              ))}
            </select>
          )}
          {situations.length > 0 && roomy && (
            <span className="seg" role="tablist" aria-label="Situation">
              {situations.map((candidate) => (
                <button
                  key={candidate.slug}
                  type="button"
                  role="tab"
                  aria-selected={candidate.slug === situation}
                  className={`seg__button${
                    candidate.slug === situation ? ' seg__button--on' : ''
                  }`}
                  onClick={() => setSituation(candidate.slug)}
                >
                  {candidate.title}
                </button>
              ))}
            </span>
          )}
          <span className="proto-view__spacer" />
          {columns === 1 && device === 'desktop' && (
            <select
              className="proto-view__zoom"
              aria-label="Zoom"
              value={fit}
              onChange={(event) =>
                setFit(event.target.value === 'actual' ? 'actual' : 'fit')
              }
            >
              <option value="fit">
                Fit {Math.round(scaleOf(board) * 100)}%
              </option>
              <option value="actual">100%</option>
            </select>
          )}
          <a
            className="proto-view__tool"
            href={`${frameSrc(bases, manifest, board)}${
              situation === null ? '' : `?state=${situation}`
            }`}
            target="_blank"
            rel="noopener noreferrer"
            title="Open this board full screen in a new tab"
          >
            ⧉ New tab
          </a>
          <button
            type="button"
            className="proto-view__tool"
            title="Close (Esc)"
            aria-label="Close"
            onClick={onClose}
          >
            ✕
          </button>
        </header>
        <div
          ref={stageRef}
          className={`proto-view__stage${
            device === 'phone' ? ' proto-view__stage--phone' : ''
          }`}
        >
          {stage.width > 0 &&
            shown.map((candidate) => {
              const size = frameSize(candidate);
              const scale = scaleOf(candidate);

              return (
                <div key={candidate.letter} className="proto-view__column">
                  {columns > 1 && (
                    <div className="proto-view__column-head">
                      <strong>{candidate.letter}</strong> {candidate.title}
                    </div>
                  )}
                  <div
                    className="proto-view__frame-box"
                    style={{ width: size.w * scale, height: size.h * scale }}
                  >
                    <iframe
                      ref={(node) => {
                        if (node === null) {
                          frames.current.delete(candidate.letter);
                        } else {
                          frames.current.set(candidate.letter, node);
                        }
                      }}
                      key={`${manifest.version}:${candidate.file}:${device}`}
                      title={`${candidate.letter} · ${candidate.title}`}
                      src={frameSrc(bases, manifest, candidate)}
                      // Scripts only: no same-origin (it can't read the
                      // inbox), no forms, popups or top navigation.
                      sandbox="allow-scripts"
                      style={{
                        width: size.w,
                        height: size.h,
                        transform: `scale(${scale})`,
                      }}
                      onLoad={() => {
                        post(candidate.letter, { type: 'hello' });

                        if (situation !== null) {
                          post(candidate.letter, {
                            type: 'state',
                            slug: situation,
                          });
                        }
                      }}
                    />
                  </div>
                  {device === 'phone' && (
                    <div className="muted proto-view__size">390 × 844</div>
                  )}
                  {columns > 1 && (
                    <button
                      type="button"
                      className="chip"
                      title="Add “Going with …” to the chat box"
                      onClick={() => addToChat(pickLine(candidate))}
                    >
                      Pick {candidate.letter}
                    </button>
                  )}
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
};

// ── the lightbox ────────────────────────────────────────────────────────────

/** The prototype and spot a picture shows, when it shows one we have. */
export const tryTargetOf = (
  made: Made | null,
  picture: string
): ViewTarget | null => {
  const stillsOf =
    /^designs\/([a-z0-9-]+)\/prototype\/v(\d+)\/stills\/([A-Z])\/([a-z0-9-]+)\.png$/.exec(
      picture
    );

  if (stillsOf !== null) {
    const slug = stillsOf[1] ?? '';

    return groupOf(made, slug) === undefined
      ? null
      : {
          slug,
          version: Number(stillsOf[2]),
          letter: stillsOf[3],
          situation: stillsOf[4] === 'poster' ? null : stillsOf[4],
        };
  }

  const spot = pictureOnPrototype(picture);
  const newest =
    spot === null ? undefined : groupOf(made, spot.slug)?.versions[0];

  if (spot === null || newest === undefined) {
    return null;
  }

  return {
    slug: spot.slug,
    version: newest.version,
    letter: spot.letter ?? newest.boards[0]?.letter,
    situation: newest.situations.some(
      (situation) => situation.slug === spot.situation
    )
      ? spot.situation
      : undefined,
  };
};

const pictureLabel = (picture: string): string =>
  picture
    .replace(/^designs\//, '')
    .replace(/\.png$/, '')
    .split('/')
    .join(' · ');

export const Lightbox = ({
  podId,
  made,
  start,
  onClose,
  onTry,
}: {
  podId: string;
  made: Made | null;
  start: string;
  onClose: () => void;
  onTry: (target: ViewTarget) => void;
}) => {
  const all = useMemo(() => {
    const listed = (made?.pictures ?? []).map((picture) => picture.path);

    return listed.includes(start) ? listed : [start, ...listed];
  }, [made, start]);
  const [index, setIndex] = useState(() => Math.max(0, all.indexOf(start)));
  const picture = all[Math.min(index, all.length - 1)] ?? start;
  const target = tryTargetOf(made, picture);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }

      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        const step = event.key === 'ArrowRight' ? 1 : -1;
        setIndex((now) => (now + step + all.length) % all.length);
      }
    };
    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [all.length, onClose]);

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Picture"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <button
        type="button"
        className="lightbox__close"
        aria-label="Close"
        onClick={onClose}
      >
        ✕
      </button>
      {all.length > 1 && (
        <button
          type="button"
          className="lightbox__step lightbox__step--back"
          aria-label="Previous picture"
          onClick={() => setIndex((now) => (now - 1 + all.length) % all.length)}
        >
          ‹
        </button>
      )}
      <figure className="lightbox__figure">
        <img src={fileSrc(podId, picture)} alt={pictureLabel(picture)} />
        <figcaption>
          <span>{pictureLabel(picture)}</span>
          <span className="muted">
            {index + 1} of {all.length}
          </span>
          {target !== null && (
            <button
              type="button"
              className="chip"
              onClick={() => onTry(target)}
            >
              ⤢ Try it live
            </button>
          )}
        </figcaption>
      </figure>
      {all.length > 1 && (
        <button
          type="button"
          className="lightbox__step lightbox__step--next"
          aria-label="Next picture"
          onClick={() => setIndex((now) => (now + 1) % all.length)}
        >
          ›
        </button>
      )}
    </div>
  );
};

// ── the Made here rail ──────────────────────────────────────────────────────

/** Scroll the chat to a message and flash it. */
const jumpTo = (msgId: string): void => {
  const node = document.querySelector(`[data-msg="${CSS.escape(msgId)}"]`);

  if (node instanceof HTMLElement) {
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.remove('msg-flash');
    // Restart the animation when it's the same message again.
    void node.offsetWidth;
    node.classList.add('msg-flash');
  }
};

const sentIn = (
  thread: ThreadMessage[],
  item: Parameters<typeof messageShows>[1]
): string | null =>
  [...thread].reverse().find((message) => messageShows(message.text, item))
    ?.id ?? null;

const JumpLink = ({ msgId }: { msgId: string | null }) =>
  msgId === null ? (
    <span className="muted made__unsent">not sent</span>
  ) : (
    <button
      type="button"
      className="link-button made__jump"
      onClick={() => jumpTo(msgId)}
    >
      ↳ jump to message
    </button>
  );

type MadeTab = 'all' | 'prototypes' | 'pictures';

const groupLabel = (group: string): string =>
  group === 'shots'
    ? 'Screenshots'
    : group.startsWith('shots/')
    ? `Screenshots · ${group.slice('shots/'.length)}`
    : `Pictures · ${group.replace(/^designs\/?/, '') || 'designs'}`;

export const MadeRail = ({ thread }: { thread: ThreadMessage[] }) => {
  const viewer = useViewer();
  const [tab, setTab] = useState<MadeTab>('all');
  const refresh = viewer?.refresh;

  // Fresh each time the rail opens.
  useEffect(() => {
    refresh?.();
  }, [refresh]);

  if (viewer === null) {
    return <p className="rail__empty">Nothing on screen.</p>;
  }

  const { made, podId } = viewer;
  const groups = (made?.pictures ?? []).reduce<Map<string, MadePicture[]>>(
    (byGroup, picture) =>
      byGroup.set(picture.group, [
        ...(byGroup.get(picture.group) ?? []),
        picture,
      ]),
    new Map()
  );
  const empty =
    made !== null && made.prototypes.length === 0 && made.pictures.length === 0;

  return (
    <div className="rail__scroll made">
      <div className="seg made__tabs" role="tablist">
        {(['all', 'prototypes', 'pictures'] as const).map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="tab"
            aria-selected={tab === candidate}
            className={`seg__button${
              tab === candidate ? ' seg__button--on' : ''
            }`}
            onClick={() => setTab(candidate)}
          >
            {candidate === 'all'
              ? 'All'
              : candidate === 'prototypes'
              ? 'Prototypes'
              : 'Pictures'}
          </button>
        ))}
      </div>
      {made === null && <p className="muted">Loading…</p>}
      {empty && (
        <p className="muted">
          Nothing yet. Prototypes, design pictures and screenshots this Lambda
          makes show up here.
        </p>
      )}
      {tab !== 'pictures' &&
        (made?.prototypes ?? []).map((group) => {
          const [latest, ...older] = group.versions;

          if (latest === undefined) {
            return null;
          }

          const [first] = latest.boards;
          const still =
            first === undefined
              ? undefined
              : stillOf(first, firstSituation(latest, first));

          return (
            <section key={group.slug} className="made__item">
              <h4 className="made__kicker">Prototype</h4>
              <button
                type="button"
                className="made__proto"
                onClick={() =>
                  viewer.openPrototype({
                    slug: group.slug,
                    version: latest.version,
                  })
                }
              >
                {still !== undefined && (
                  <img src={fileSrc(podId, still)} alt="" />
                )}
                <span className="made__proto-title">
                  <strong>{latest.title}</strong>
                  <span className="muted">
                    v{latest.version} · {latest.boards.length} board
                    {latest.boards.length === 1 ? '' : 's'}
                  </span>
                </span>
              </button>
              <JumpLink
                msgId={sentIn(thread, {
                  prototype: { slug: group.slug, version: latest.version },
                })}
              />
              {older.length > 0 && (
                <details className="made__older">
                  <summary>Older versions ({older.length})</summary>
                  <ul>
                    {older.map((manifest) => (
                      <li key={manifest.version}>
                        <button
                          type="button"
                          className="link-button"
                          onClick={() =>
                            viewer.openPrototype({
                              slug: group.slug,
                              version: manifest.version,
                            })
                          }
                        >
                          v{manifest.version}
                        </button>
                        <span className="muted">
                          {' '}
                          {new Date(manifest.createdAt).toLocaleString([], {
                            month: 'short',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                          {manifest.note === undefined
                            ? ''
                            : ` · ${manifest.note}`}
                        </span>{' '}
                        <JumpLink
                          msgId={sentIn(thread, {
                            prototype: {
                              slug: group.slug,
                              version: manifest.version,
                            },
                          })}
                        />
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
          );
        })}
      {tab !== 'prototypes' &&
        Array.from(groups.entries()).map(([group, pictures]) => {
          const shownIn = pictures
            .map((picture) => sentIn(thread, { picture: picture.path }))
            .find((msgId) => msgId !== null);

          return (
            <section key={group} className="made__item">
              <h4 className="made__kicker">{groupLabel(group)}</h4>
              <div className="made__grid">
                {pictures.map((picture) => (
                  <button
                    key={picture.path}
                    type="button"
                    className="made__thumb"
                    title={pictureLabel(picture.path)}
                    onClick={() => viewer.openPicture(picture.path)}
                  >
                    <img
                      src={fileSrc(podId, picture.path)}
                      alt={pictureLabel(picture.path)}
                      loading="lazy"
                    />
                    <span>
                      {picture.path
                        .split('/')
                        .at(-1)
                        ?.replace(/\.png$/, '')}
                    </span>
                  </button>
                ))}
              </div>
              <JumpLink msgId={shownIn ?? null} />
            </section>
          );
        })}
    </div>
  );
};
