import { useEffect, useRef, useState } from 'react';

import {
  type ComputerRow,
  canPause,
  computerRows,
  computersCounts,
} from '../shared/computersFooter';
import type { LambdaInfo, PodSummary } from '../shared/types';

/**
 * The sidebar's computers, as one line at the foot however many there are,
 * opening a popover: computers needing attention first (paused with work
 * waiting, offline), then building, then idle; Pause all and Resume all.
 */

const BIG_GROUP = 3;

const Dot = ({ row }: { row: ComputerRow }) => (
  <span
    className={`computers__dot computers__dot--${row.state}`}
    aria-hidden="true"
  />
);

export const ComputersLine = ({
  pods,
  lambda,
  now,
  onPause,
  onOpenComputer,
  onOpenTerminal,
  onOpenPage,
  onOpenTickets,
}: {
  pods: PodSummary[];
  lambda: LambdaInfo | undefined;
  now: number;
  onPause: (podId: string, pause: boolean) => void;
  onOpenComputer: (podId: string) => void;
  onOpenTerminal: (podId: string) => void;
  onOpenPage: () => void;
  onOpenTickets: () => void;
}) => {
  const [open, setOpen] = useState(false);
  /** Where the popover sits: fixed, so the sidebar's scroll can't clip it. */
  const [at, setAt] = useState<{ left: number; bottom: number } | null>(null);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const box = useRef<HTMLDivElement>(null);
  const rows = computerRows(lambda, pods, now);
  const counts = computersCounts(rows);
  const needle = query.trim().toLowerCase();
  const shown = rows.filter(
    (row) => needle === '' || row.name.toLowerCase().includes(needle)
  );
  const attention = shown.filter((row) => row.attention);
  const working = shown.filter(
    (row) =>
      !row.attention &&
      ['building', 'testing', 'shipping', 'blocked'].includes(row.state)
  );
  const idle = shown.filter((row) => !row.attention && !working.includes(row));
  const buildingPods = rows.flatMap((row) =>
    row.podId === null
      ? []
      : [{ podId: row.podId, paused: row.state === 'paused' }]
  );

  // A click elsewhere or Escape closes it.
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const away = (event: MouseEvent): void => {
      if (
        box.current !== null &&
        event.target instanceof Node &&
        !box.current.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const row = (one: ComputerRow) => (
    <div key={one.name} className="computers__row">
      <Dot row={one} />
      <button
        type="button"
        className="computers__name"
        disabled={one.podId === null}
        onClick={() => {
          if (one.podId !== null) {
            setOpen(false);
            onOpenComputer(one.podId);
          }
        }}
      >
        {one.name}
      </button>
      <span className="computers__detail">{one.detail}</span>
      {one.state === 'paused' && one.podId !== null && (
        <button
          type="button"
          className="computers__act"
          onClick={() => one.podId !== null && onPause(one.podId, false)}
        >
          Resume
        </button>
      )}
      {one.state === 'offline' && (
        <button
          type="button"
          className="computers__act"
          onClick={() => {
            setOpen(false);
            onOpenTickets();
          }}
        >
          Reassign
        </button>
      )}
      {canPause(one) && (
        <button
          type="button"
          className="computers__act"
          onClick={() => one.podId !== null && onPause(one.podId, true)}
        >
          Pause
        </button>
      )}
      {canPause(one) && (
        <button
          type="button"
          className="computers__act computers__act--quiet"
          title="Open terminal"
          onClick={() => {
            if (one.podId !== null) {
              setOpen(false);
              onOpenTerminal(one.podId);
            }
          }}
        >
          Terminal
        </button>
      )}
    </div>
  );

  const group = (id: string, title: string, members: ComputerRow[]) =>
    members.length === 0 ? null : (
      <div className="computers__group">
        <p className="computers__head">
          {title} · {members.length}
        </p>
        {(showAll[id] === true || members.length <= BIG_GROUP + 1
          ? members
          : members.slice(0, BIG_GROUP)
        ).map(row)}
        {showAll[id] !== true && members.length > BIG_GROUP + 1 && (
          <button
            type="button"
            className="computers__more"
            onClick={() => setShowAll({ ...showAll, [id]: true })}
          >
            + {members.length - BIG_GROUP} more {title.toLowerCase()}
          </button>
        )}
      </div>
    );

  return (
    <div className="computers" ref={box}>
      <button
        type="button"
        className={`computers__line${open ? ' computers__line--open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Computers"
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setAt({
            left: box.right - 36,
            bottom: window.innerHeight - box.top + 4,
          });
          setOpen(!open);
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <rect x="4" y="5" width="16" height="11" rx="1.5" />
          <path d="M2 19h20" />
        </svg>
        <span className="computers__counts">
          {counts.map((part, index) => (
            <span key={part.label} className={`computers__count--${part.tone}`}>
              {index > 0 && ' · '}
              {part.label}
            </span>
          ))}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          aria-hidden="true"
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
      {open && (
        <div
          className="computers__popover"
          style={at === null ? undefined : { left: at.left, bottom: at.bottom }}
          role="dialog"
          aria-label="Computers"
        >
          <div className="computers__top">
            <strong>Computers</strong>
            <label className="computers__search">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" />
              </svg>
              <input
                type="search"
                placeholder="Search"
                aria-label="Search computers"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
          {attention.length > 0 && (
            <div className="computers__group computers__group--attention">
              <p className="computers__head">Needs attention</p>
              {attention.map(row)}
            </div>
          )}
          {group('building', 'Building', working)}
          {group('idle', 'Idle', idle)}
          <div className="computers__foot">
            <button
              type="button"
              className="computers__button"
              disabled={buildingPods.every((one) => one.paused)}
              onClick={() =>
                buildingPods
                  .filter((one) => !one.paused)
                  .forEach((one) => onPause(one.podId, true))
              }
            >
              Pause all
            </button>
            <button
              type="button"
              className="computers__button"
              disabled={buildingPods.every((one) => !one.paused)}
              onClick={() =>
                buildingPods
                  .filter((one) => one.paused)
                  .forEach((one) => onPause(one.podId, false))
              }
            >
              Resume all
            </button>
            <span className="computers__spacer" />
            <button
              type="button"
              className="computers__link"
              onClick={() => {
                setOpen(false);
                onOpenPage();
              }}
            >
              Open Computers ›
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
