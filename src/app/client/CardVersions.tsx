import { type ReactNode, useEffect, useRef, useState } from 'react';

import {
  type CardChange,
  type Timeline,
  lastChange,
} from '../shared/cardHistory';

/**
 * Versions of a checkpoint, on one timeline. The checkpoint's own dropdown
 * lists every version (what changed, the time on it); each card inside —
 * a screen, a ticket, a decision — says when it last changed ("changed v8")
 * and opens the same list, with the versions that touched it marked. Picking
 * any version shows the whole checkpoint as it was then, read-only.
 */

const KIND_LABEL: Record<Timeline['versions'][number]['kind'], string> = {
  posted: 'posted',
  reposted: 're-posted',
  edited: 'edited',
};

const CHANGE_LABEL = {
  added: 'added',
  changed: 'changed',
  removed: 'removed',
};

/** 24m · 8m 30s · 45s · 1h 5m */
export const formatSpent = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  if (minutes > 0) {
    return rest > 0 && minutes < 10 ? `${minutes}m ${rest}s` : `${minutes}m`;
  }

  return `${rest}s`;
};

/** today 9:12 am · Oct 16, 4:10 pm */
const formatWhen = (iso: string, now: Date = new Date()): string => {
  const at = new Date(iso);
  const time = at
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    .toLowerCase();

  return at.toDateString() === now.toDateString()
    ? `today ${time}`
    : `${at.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      })}, ${time}`;
};

/** A button that opens a list below it; click outside or Esc closes it. */
const Dropdown = ({
  className,
  label,
  title,
  children,
}: {
  className: string;
  label: ReactNode;
  title: string;
  children: (close: () => void) => ReactNode;
}) => {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const onPointer = (event: PointerEvent): void => {
      if (
        !(event.target instanceof Node) ||
        box.current?.contains(event.target) !== true
      ) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span className="versions" ref={box}>
      <button
        type="button"
        className={className}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen(!open)}
      >
        {label} {open ? '▴' : '▾'}
      </button>
      {open && (
        <div className="versions__menu" role="listbox">
          {children(() => setOpen(false))}
        </div>
      )}
    </span>
  );
};

/** The checkpoint's versions, at the top of the card. */
export const VersionMenu = ({
  timeline,
  viewing,
  onView,
  itemMs,
  versionMs,
  cp,
}: {
  timeline: Timeline;
  viewing: number;
  /** Show this version (null: the current one). */
  onView: (version: number | null) => void;
  itemMs: number;
  versionMs: (version: number) => number;
  cp: number | undefined;
}) => {
  const current = timeline.versions.at(-1)?.version ?? 1;

  return (
    <span className="versions__line">
      <Dropdown
        className="versions__pill"
        label={`v${viewing}`}
        title="Versions of this checkpoint"
      >
        {(close) => (
          <>
            <div className="versions__head">
              <span>
                Checkpoint {cp} · {timeline.versions.length}{' '}
                {timeline.versions.length === 1 ? 'version' : 'versions'}
              </span>
              <span>{formatSpent(itemMs)} total</span>
            </div>
            {[...timeline.versions].reverse().map((meta) => (
              <button
                key={meta.version}
                type="button"
                role="option"
                aria-selected={meta.version === viewing}
                className={`versions__row versions__row--touched${
                  meta.version === viewing ? ' versions__row--on' : ''
                }`}
                onClick={() => {
                  onView(meta.version === current ? null : meta.version);
                  close();
                }}
              >
                <span className="versions__v">v{meta.version}</span>
                <span className="versions__when">
                  {meta.version === current ? 'current · ' : ''}
                  {formatWhen(meta.at)} · {KIND_LABEL[meta.kind]}
                  {meta.version === 1
                    ? ''
                    : meta.changes === 0
                    ? ' · no changes'
                    : ` · ${meta.changes} ${
                        meta.changes === 1 ? 'change' : 'changes'
                      }`}
                </span>
                <span className="versions__ms">
                  {formatSpent(versionMs(meta.version))}
                </span>
              </button>
            ))}
          </>
        )}
      </Dropdown>
      <span>{formatSpent(itemMs)} on this checkpoint</span>
    </span>
  );
};

/**
 * One card's mark: "changed v8 · 2m ▾". The list is the checkpoint's whole
 * timeline, with the versions that touched this card marked.
 */
export const CardMark = ({
  cardKey,
  title,
  timeline,
  viewing,
  onView,
  msOf,
}: {
  cardKey: string;
  title: string;
  timeline: Timeline;
  viewing: number;
  /** Show this version — keeping this card where it is on screen. */
  onView: (version: number | null, anchor: string) => void;
  /** Active ms on this card: on these versions, or on all of them. */
  msOf: (versions?: number[]) => number;
}) => {
  const last = lastChange(timeline, cardKey, viewing);
  const touched = timeline.cards.get(cardKey) ?? new Map<number, CardChange>();
  const current = timeline.versions.at(-1)?.version ?? 1;
  const totalMs = msOf();

  if (last === undefined) {
    return null;
  }

  return (
    <Dropdown
      className="versions__mark"
      label={`${last.change} v${last.version}${
        totalMs >= 1000 ? ` · ${formatSpent(totalMs)}` : ''
      }`}
      title="When this card changed, and the time on it"
    >
      {(close) => (
        <>
          <div className="versions__head">
            <span>
              {title} · changed in {touched.size} of {timeline.versions.length}
            </span>
            <span>{formatSpent(totalMs)} total</span>
          </div>
          {[...timeline.versions].reverse().map((meta) => {
            const change = touched.get(meta.version);

            return (
              <button
                key={meta.version}
                type="button"
                role="option"
                aria-selected={meta.version === viewing}
                className={`versions__row${
                  change === undefined ? '' : ' versions__row--touched'
                }${meta.version === viewing ? ' versions__row--on' : ''}`}
                onClick={() => {
                  onView(
                    meta.version === current ? null : meta.version,
                    cardKey
                  );
                  close();
                }}
              >
                <span className="versions__v">
                  {change === undefined ? '' : '● '}v{meta.version}
                </span>
                <span className="versions__when">
                  {change === undefined
                    ? 'no change'
                    : `${CHANGE_LABEL[change]} · ${formatWhen(meta.at)}`}
                  {meta.version === current ? ' · current' : ''}
                </span>
                <span className="versions__ms">
                  {formatSpent(msOf([meta.version]))}
                </span>
              </button>
            );
          })}
        </>
      )}
    </Dropdown>
  );
};

/** Above everything while an earlier version is on screen. */
export const OldVersionNote = ({
  version,
  of,
  onBack,
}: {
  version: number;
  of: number;
  onBack: () => void;
}) => (
  <div className="versions__old">
    <span>
      Viewing v{version} of {of} · not current
    </span>
    <button type="button" className="link-button" onClick={onBack}>
      Back to current →
    </button>
  </div>
);
