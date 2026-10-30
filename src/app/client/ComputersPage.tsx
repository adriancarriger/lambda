import { useEffect, useMemo, useState } from 'react';

import type { SharedTrackerUser, Tracker } from '../../tickets/assignees';
import { type Computer, type TailscaleStep, api } from './api';
import { errorText, latestLoader } from './loading';

/** How often Add a computer checks Tailscale again while it's open. */
const TAILSCALE_RECHECK_MS = 5000;

type Listen =
  | { phase: 'idle' }
  | { phase: 'asking' }
  | { phase: 'ready'; command: string }
  | { phase: 'failed'; line: string };

/**
 * Add a computer: put both machines on Tailscale, see this computer's
 * private address, paste one `lambda join` line on the other. Every check
 * and the listen write run on the mothership; this only shows them.
 */
const AddComputerDialog = ({ onDone }: { onDone: () => void }) => {
  const [tailscale, setTailscale] = useState<TailscaleStep | null>(null);
  const [listen, setListen] = useState<Listen>({ phase: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const check = () => {
      api
        .tailscale()
        .then((step) => {
          setTailscale(step);
          setError(null);
        })
        .catch((caught: unknown) => setError(errorText(caught)));
    };
    check();
    const timer = setInterval(check, TAILSCALE_RECHECK_MS);

    return () => clearInterval(timer);
  }, []);

  const isUp = tailscale?.state === 'up';

  // Once step 1 is ✓: listen on the Tailscale address, then make the code.
  useEffect(() => {
    if (!isUp || listen.phase !== 'idle') {
      return;
    }

    setListen({ phase: 'asking' });
    api
      .listenOnTailscale()
      .then(async ({ server }) => {
        const { command } = await api.computerCode();
        setListen({ phase: 'ready', command: `${command} --server ${server}` });
      })
      .catch((caught: unknown) =>
        setListen({ phase: 'failed', line: errorText(caught) })
      );
  }, [isUp, listen.phase]);

  return (
    <div className="dialog" role="dialog" aria-label="Add a computer">
      <h2>Add a computer</h2>
      {error !== null && <p className="error">{error}</p>}
      <ol className="dialog__steps">
        <li>
          <strong>Put both machines on Tailscale</strong>{' '}
          <span className={isUp ? '' : 'muted'}>
            {tailscale?.step ?? 'Checking…'}
          </span>
          <p className="muted">Tailscale is a free private network.</p>
        </li>
        {isUp && (
          <li>
            <strong>This Mac's private address</strong>
            <p>
              {tailscale.label} · {tailscale.address}
            </p>
          </li>
        )}
        {isUp && listen.phase === 'failed' && (
          <li>
            <p className="error">{listen.line}</p>
          </li>
        )}
        {isUp && listen.phase === 'ready' && (
          <li>
            <strong>On the other machine, run:</strong>
            <p className="dialog__code">
              <code>{listen.command}</code>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  navigator.clipboard
                    .writeText(listen.command)
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false));
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </p>
            <p className="muted">
              This code works once and expires in 10 minutes.
            </p>
            <p className="muted">Waiting for it to join…</p>
          </li>
        )}
      </ol>
      <button type="button" className="ghost" onClick={onDone}>
        Done
      </button>
    </div>
  );
};

/**
 * Computers: the machines themselves (name, project, state). A computer
 * works on one project at a time and moves to a waiting project after 5 idle
 * minutes. Add a computer walks through joining another one over Tailscale.
 */
const TRACKER_NAMES: Record<Tracker, string> = {
  linear: 'Linear',
  jira: 'Jira',
};

/** "A and B", "A, B and C". */
const listed = (names: string[]): string =>
  names.length <= 1
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;

export const ComputersPage = ({ tick }: { tick: number }) => {
  const [computers, setComputers] = useState<Computer[] | null>(null);
  const [shared, setShared] = useState<SharedTrackerUser[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A good answer clears an old error (latestLoader).
  const load = useMemo(
    () => latestLoader<Computer[]>({ value: setComputers, error: setError }),
    []
  );

  useEffect(() => {
    void load(
      api.computers().then((data) => {
        setShared(data.shared ?? []);

        return data.computers;
      })
    );
  }, [load, tick]);

  return (
    <section className="account-page">
      {error !== null && <p className="error">{error}</p>}
      {computers === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <ul className="account-list">
          {shared.map((one) => (
            <li
              key={`${one.tracker}/${one.who}`}
              className="account-list__row account-list__warning"
              role="status"
            >
              {listed(one.computers)} share the {TRACKER_NAMES[one.tracker]}{' '}
              user {one.who}: a ticket assigned to it may be built by either.
            </li>
          ))}
          {computers.map((computer) => (
            <li key={computer.id} className="account-list__row">
              <strong>{computer.name}</strong>
              {computer.project !== null && <span> · {computer.project}</span>}
              <span className="muted"> · {computer.state}</span>
              <span className="account-list__trackers">
                {(computer.trackers ?? []).length === 0
                  ? 'No tracker connected: tickets can’t be assigned to it in Linear or Jira'
                  : (computer.trackers ?? [])
                      .map(
                        (identity) =>
                          `${TRACKER_NAMES[identity.tracker]}: ${
                            identity.name ?? identity.who
                          } ✓`
                      )
                      .join(' · ')}
              </span>
            </li>
          ))}
          {computers.length === 0 && (
            <li className="muted">
              No computers yet. Run lambda start on this one.
            </li>
          )}
        </ul>
      )}
      <div className="account-page__actions">
        <button
          type="button"
          className="primary"
          onClick={() => setAdding(true)}
        >
          Add a computer
        </button>
      </div>
      {adding && <AddComputerDialog onDone={() => setAdding(false)} />}
    </section>
  );
};
