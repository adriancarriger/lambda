import { useEffect, useMemo, useRef, useState } from 'react';

import {
  DEFAULT_LOOK,
  type DesignSystemPage,
  type ForProject,
  MAKE_IT_EXPLAINED,
  type MadeDesignSystem,
  NEEDS_CLAUDE_DESIGN,
  type PageLine,
  createdLine,
  designSystemControls,
  forProject,
  openTicketLine,
  rereadsDesignSystem,
  showsMakeIt,
  systemLines,
} from '../shared/designSystem';
import type { LambdaInfo } from '../shared/types';
import { ProjectPicker } from './ProjectPicker';
import { type Code, type Device, type ProcessSettings, api } from './api';
import { errorText, latestLoader } from './loading';
import type { SettingsTab } from './page';
import { processControls, rereadsOnTick } from './processControls';
import { chosenProjectId } from './projects';

const ago = (at: number): string => {
  const minutes = Math.floor((Date.now() - at) / 60_000);

  if (minutes < 2) {
    return 'active now';
  }

  if (minutes < 60) {
    return `${minutes} min ago`;
  }

  const hours = Math.floor(minutes / 60);

  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} days ago`;
};

/** Settings → Devices: who's signed in, Sign out on one, Add a device. */
const Devices = ({ tick }: { tick: number }) => {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [pairing, setPairing] = useState<Code | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  // A good answer clears an old error (latestLoader).
  const loadDevices = useMemo(
    () => latestLoader<Device[]>({ value: setDevices, error: setError }),
    []
  );
  const load = () => loadDevices(api.devices().then((data) => data.devices));

  useEffect(() => {
    void load();
  }, [tick]);

  // The code's countdown.
  useEffect(() => {
    if (pairing === null) {
      return undefined;
    }

    const id = window.setInterval(() => setNow(Date.now()), 1000);

    return () => window.clearInterval(id);
  }, [pairing]);

  const left = pairing === null ? 0 : Math.max(0, pairing.expiresAt - now);

  return (
    <>
      {error !== null && <p className="error">{error}</p>}
      <ul className="account-list">
        {(devices ?? []).map((device) => (
          <li key={device.id} className="account-list__row">
            <strong>
              {device.label}
              {device.current ? ' (this device)' : ''}
            </strong>
            <span className="muted"> {ago(device.lastSeenAt)}</span>
            {!device.current && (
              <button
                type="button"
                className="ghost"
                onClick={() =>
                  api
                    .signOutDevice(device.id)
                    .then(load)
                    .catch((caught: unknown) => setError(errorText(caught)))
                }
              >
                Sign out
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="account-page__actions">
        <button
          type="button"
          className="primary"
          onClick={() =>
            api
              .deviceCode()
              .then((code) => {
                setNow(Date.now());
                setPairing(code);
              })
              .catch((caught: unknown) => setError(errorText(caught)))
          }
        >
          Add a device
        </button>
      </div>
      {pairing !== null && (
        <div className="dialog" role="dialog" aria-label="Add a device">
          <h2>Add a device</h2>
          <p>Enter this code on the other device’s sign-in screen:</p>
          <p className="dialog__big-code">{pairing.code}</p>
          <p className="muted">
            {left === 0
              ? 'Expired. Make a new one with Add a device.'
              : `Works once · expires in ${Math.floor(left / 60_000)}:${String(
                  Math.floor((left % 60_000) / 1000)
                ).padStart(2, '0')}`}
          </p>
          <button
            type="button"
            className="ghost"
            onClick={() => setPairing(null)}
          >
            Done
          </button>
        </div>
      )}
    </>
  );
};

/** Settings → Process: switches for the optional steps; quality steps locked. */
const Process = ({
  lambda,
  tick,
}: {
  lambda: LambdaInfo | undefined;
  tick: number;
}) => {
  const [picked, setPicked] = useState<string | null>(null);
  const projectId = chosenProjectId(picked, lambda);
  const [settings, setSettings] = useState<ProcessSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const controls = useMemo(
    () =>
      processControls<ProcessSettings>(
        { read: api.process, flip: api.switchStep },
        {
          value: setSettings,
          error: (text) => {
            setError(text);

            if (text !== null) {
              setSettings(null);
            }
          },
          busy: setBusy,
        }
      ),
    []
  );

  // Read when the page or project changes, and after each switch: each
  // read is a trip to the computer, so not on every heartbeat.
  useEffect(() => {
    if (projectId === null) {
      return;
    }

    void controls.read(projectId);
  }, [controls, projectId]);

  // After an error, each heartbeat tries again: the computer coming back
  // online brings the switches back without a click.
  useEffect(() => {
    if (projectId !== null && rereadsOnTick({ error, busy })) {
      void controls.read(projectId);
    }
  }, [tick]);

  if (projectId === null) {
    return <p className="muted">Add a codebase first.</p>;
  }

  const flip = (process: 'planning' | 'building', step: string, on: boolean) =>
    controls.flip(projectId, process, step, on);

  const section = (process: 'planning' | 'building', title: string) => (
    <div className="process">
      <h3>{title}</h3>
      {(settings?.[process] ?? []).flatMap((stage) =>
        stage.steps.map((step) => (
          <div key={`${stage.id}/${step.id}`} className="process__row">
            <span>
              {step.label}
              {step.added ? ' (added)' : ''}
            </span>
            {step.setting === 'locked' ? (
              <span className="muted">locked</span>
            ) : (
              <label className="switch">
                <input
                  type="checkbox"
                  role="switch"
                  checked={step.setting === 'on'}
                  disabled={busy}
                  onChange={(event) =>
                    flip(process, step.id, event.target.checked)
                  }
                />
                <span className="switch__track" aria-hidden="true">
                  <span className="switch__thumb" />
                </span>
                <span>{step.setting === 'on' ? 'On' : 'Off'}</span>
              </label>
            )}
          </div>
        ))
      )}
    </div>
  );

  return (
    <>
      <ProjectPicker lambda={lambda} value={projectId} onChange={setPicked} />
      {error !== null && (
        <>
          <p className="error">{error}</p>
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => void controls.read(projectId)}
          >
            Try again
          </button>
        </>
      )}
      {settings !== null && (
        <>
          {section('planning', 'Planning')}
          {section('building', 'Building')}
          <p className="muted">Anything more is set in .lambda/ files.</p>
        </>
      )}
    </>
  );
};

const TicketLink = ({ url }: { url: string | null }) =>
  url === null ? null : (
    <>
      {' '}
      <a href={url} target="_blank" rel="noreferrer">
        Open ticket ↗
      </a>
    </>
  );

const Line = ({ line }: { line: PageLine }) => (
  <p className={line.issue === true ? 'design-system__issue' : undefined}>
    {line.text}
    {line.link !== undefined &&
      (line.link.url === null ? (
        line.link.label
      ) : (
        <a href={line.link.url} target="_blank" rel="noreferrer">
          {`${line.link.label} ↗`}
        </a>
      ))}
  </p>
);

/**
 * What Settings → Design system shows for a page state: the design system on
 * main (view-only), the setup ticket, or Make it. Make it's "Created …" shows
 * even with no page, when the read after it failed.
 */
export const DesignSystemView = ({
  page,
  made,
  busy,
  onMake,
}: {
  /** Null: not read, or the read failed. */
  page: DesignSystemPage | null;
  /** Make it's answer this visit, when it created the ticket. */
  made: MadeDesignSystem | null;
  busy: boolean;
  onMake: () => void;
}) => {
  if (page !== null && page.system !== null) {
    return (
      <div className="design-system">
        {systemLines(page).map((line, index) => (
          <Line key={`${index}:${line.text}`} line={line} />
        ))}
      </div>
    );
  }

  if (made !== null && !made.existing) {
    return (
      <div className="design-system">
        <p>
          {createdLine(made)}
          <TicketLink url={made.url} />
        </p>
      </div>
    );
  }

  if (page === null) {
    return null;
  }

  if (page.setupTicket !== null) {
    return (
      <div className="design-system">
        <p>
          {openTicketLine(page.setupTicket)}
          <TicketLink url={page.setupTicket.url} />
        </p>
      </div>
    );
  }

  return (
    <div className="design-system">
      <p>No design system yet. {DEFAULT_LOOK}</p>
      {showsMakeIt(page) && (
        <div className="design-system__make">
          <button
            type="button"
            className="primary"
            disabled={busy || page.designAvailable === false}
            onClick={onMake}
          >
            Make it
          </button>
          {page.designAvailable === false && (
            <span className="muted">{NEEDS_CLAUDE_DESIGN}</span>
          )}
        </div>
      )}
      <p className="muted">{MAKE_IT_EXPLAINED}</p>
    </div>
  );
};

/** Settings → Design system: one page per project, read from its main branch. */
const DesignSystem = ({
  lambda,
  tick,
}: {
  lambda: LambdaInfo | undefined;
  tick: number;
}) => {
  const [picked, setPicked] = useState<string | null>(null);
  const projectId = chosenProjectId(picked, lambda);
  const [page, setPage] = useState<DesignSystemPage | null>(null);
  // Make it's answer and failure, each kept with the project it was pressed
  // on: one that lands after a project change never shows on the other page.
  const [madeFor, setMade] = useState<ForProject<MadeDesignSystem> | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  // Make it's failure: no read clears it, only the next press or project.
  const [makeErrorFor, setMakeError] = useState<ForProject<string> | null>(
    null
  );
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const shown = useRef(projectId);
  shown.current = projectId;
  const controls = useMemo(
    () =>
      designSystemControls({
        read: api.designSystem,
        make: api.makeDesignSystem,
        load: latestLoader<DesignSystemPage>({
          value: setPage,
          error: (text) => {
            setError(text);

            if (text !== null) {
              setPage(null);
            }
          },
        }),
        errorText,
        shown: () => shown.current,
        target: {
          page: setPage,
          error: setError,
          made: setMade,
          makeError: setMakeError,
          busy: setBusy,
          reading: setReading,
        },
      }),
    []
  );

  // Each read is a trip to the computer: on opening and on a project change.
  useEffect(() => {
    if (projectId === null) {
      return;
    }

    void controls.open(projectId);
  }, [controls, projectId]);

  // After an error (the computer was offline), each heartbeat tries again.
  useEffect(() => {
    if (
      projectId !== null &&
      rereadsDesignSystem({ readError: error, busy: busy || reading })
    ) {
      void controls.read(projectId);
    }
  }, [tick]);

  if (projectId === null) {
    return <p className="muted">Add a codebase first.</p>;
  }

  const made = forProject(madeFor, projectId);
  const makeError = forProject(makeErrorFor, projectId);

  return (
    <>
      <ProjectPicker lambda={lambda} value={projectId} onChange={setPicked} />
      {error !== null && (
        <>
          <p className="error">{error}</p>
          <button
            type="button"
            className="ghost"
            disabled={busy || reading}
            onClick={() => void controls.read(projectId)}
          >
            Try again
          </button>
        </>
      )}
      {makeError !== null && <p className="error">{makeError}</p>}
      <DesignSystemView
        page={page}
        made={made}
        busy={busy}
        onMake={() => void controls.make(projectId)}
      />
    </>
  );
};

const TABS: [SettingsTab, string][] = [
  ['devices', 'Devices'],
  ['process', 'Process'],
  ['design-system', 'Design system'],
];

export const SettingsPage = ({
  tab,
  onTab,
  lambda,
  tick,
}: {
  tab: SettingsTab;
  onTab: (tab: SettingsTab) => void;
  lambda: LambdaInfo | undefined;
  tick: number;
}) => (
  <section className="account-page">
    <div className="tabs">
      {TABS.map(([id, label]) => (
        <button
          key={id}
          type="button"
          className={`tab${tab === id ? ' tab--active' : ''}`}
          onClick={() => onTab(id)}
        >
          {label}
        </button>
      ))}
    </div>
    {tab === 'devices' && <Devices tick={tick} />}
    {tab === 'process' && <Process lambda={lambda} tick={tick} />}
    {tab === 'design-system' && <DesignSystem lambda={lambda} tick={tick} />}
  </section>
);
