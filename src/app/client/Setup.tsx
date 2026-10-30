import { type FormEvent, useCallback, useEffect, useState } from 'react';

import type { FolderListing } from '../../setup/folders';
import type { SetupState } from '../../setup/routes';
import { renewsLine } from '../../setup/tokenExpiry';
import { type AskWho, setupApi } from './api';
import { STEPS, type Step, firstUnfinished, stepAfter } from './setupSteps';

/**
 * First run, at `/setup`: Connect Claude, pick or make a project folder,
 * choose where tickets live. The same pages in the Mac app's window and in
 * any browser; the work runs on the mothership, and where setup stopped
 * lives there too, so it resumes at the first unfinished step anywhere.
 */

/** The Mac app's preload bridge: the native folder picker. */
declare global {
  interface Window {
    lambda?: { pickFolder: () => Promise<string | null> };
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isRunning = (state: SetupState): boolean => {
  const { phase } = state.steps.claude.run;

  return (
    phase === 'installing' ||
    phase === 'signing-in' ||
    state.steps.browser.phase === 'installing'
  );
};

const Bar = ({ percent }: { percent: number | null }) => (
  <div
    className={`setup__bar${percent === null ? ' setup__bar--moving' : ''}`}
    role="progressbar"
    aria-valuenow={percent ?? undefined}
    aria-valuemin={0}
    aria-valuemax={100}
  >
    <div
      className="setup__bar-fill"
      style={percent === null ? undefined : { width: `${percent}%` }}
    />
  </div>
);

const Lines = ({ lines }: { lines: string[] }) =>
  lines.length === 0 ? null : (
    <pre className="setup__lines">{lines.join('\n')}</pre>
  );

const StepIndicator = ({
  state,
  current,
  onPick,
}: {
  state: SetupState;
  current: Step;
  onPick: (step: Step) => void;
}) => (
  <ol className="setup__steps">
    {STEPS.map(({ step, label }) => {
      const { done } = state.steps[step];
      const mark = step === current ? '●' : done ? '✓' : '○';

      return (
        <li key={step}>
          <button
            type="button"
            className={`setup__step${
              step === current ? ' setup__step--current' : ''
            }`}
            disabled={!done && step !== current}
            onClick={() => onPick(step)}
          >
            <span aria-hidden="true">{mark}</span> {label}
          </button>
        </li>
      );
    })}
  </ol>
);

const BrowserProgress = ({
  state,
  onRetry,
}: {
  state: SetupState;
  onRetry: () => void;
}) => {
  const { browser } = state.steps;

  if (browser.phase === 'installing') {
    return (
      <div className="setup__browser">
        <p className="muted">Getting the browser agents test with…</p>
        <Bar percent={browser.percent} />
      </div>
    );
  }

  if (browser.phase === 'failed') {
    return (
      <div className="setup__browser">
        <p className="setup__error">
          The browser agents test with didn't download.
        </p>
        <Lines lines={browser.lines} />
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }

  return null;
};

export const ClaudeStep = ({
  state,
  onContinue,
  refresh,
}: {
  state: SetupState;
  onContinue: () => void;
  refresh: () => void;
}) => {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { run, done } = state.steps.claude;
  const connect = () => {
    setError(null);
    setupApi
      .connectClaude()
      .then(refresh)
      .catch((caught: unknown) => setError(errorText(caught)));
  };
  const sendCode = (event: FormEvent) => {
    event.preventDefault();
    setupApi
      .sendCode(code)
      .then(() => {
        setCode('');
        refresh();
      })
      .catch((caught: unknown) => setError(errorText(caught)));
  };

  if (run.phase === 'installing') {
    return (
      <section className="setup__body">
        <p>Lambda's agents run on Claude Code, with your own Claude account.</p>
        <p>Installing Claude Code from Anthropic…</p>
        <div className="setup__progress">
          <Bar percent={run.percent} />
          {run.percent !== null && <span>{run.percent}%</span>}
        </div>
        {run.percent === null && run.line !== '' && (
          <p className="muted setup__line">{run.line}</p>
        )}
        <p className="muted">
          Next, your browser opens so you can sign in to Claude.
        </p>
      </section>
    );
  }

  if (run.phase === 'signing-in') {
    return (
      <section className="setup__body">
        <p>Sign in to Claude in your browser.</p>
        {run.url !== null && (
          <p>
            <button
              type="button"
              className="primary"
              onClick={() => {
                // A browser on another device opens it there; the Mac app
                // sends https links to the default browser.
                window.open(run.url ?? '', '_blank', 'noreferrer');
              }}
            >
              Open the Claude sign-in
            </button>
          </p>
        )}
        {run.needsCode && (
          <form className="setup__row" onSubmit={sendCode}>
            <label htmlFor="setup-code">Paste the code Claude shows you</label>
            <input
              id="setup-code"
              autoFocus
              spellCheck={false}
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <button
              type="submit"
              className="primary"
              disabled={code.trim() === ''}
            >
              Send
            </button>
          </form>
        )}
        {error !== null && <p className="setup__error">{error}</p>}
      </section>
    );
  }

  if (done && state.claudeExpiresOn !== null) {
    return (
      <section className="setup__body">
        <p>✓ Claude connected · {renewsLine(state.claudeExpiresOn)}</p>
        {/* A Reconnect that failed keeps the old sign-in: say why. */}
        {run.phase === 'failed' && (
          <>
            <p className="setup__error">{run.message}</p>
            <Lines lines={run.lines} />
          </>
        )}
        <div className="setup__actions">
          <button type="button" onClick={connect}>
            Reconnect Claude
          </button>
          <button type="button" className="primary" onClick={onContinue}>
            Continue
          </button>
        </div>
        {error !== null && <p className="setup__error">{error}</p>}
      </section>
    );
  }

  return (
    <section className="setup__body">
      <p>Lambda's agents run on Claude Code, with your own Claude account.</p>
      {run.phase === 'failed' && (
        <>
          <p className="setup__error">{run.message}</p>
          <Lines lines={run.lines} />
        </>
      )}
      <div className="setup__actions">
        <button type="button" className="primary" onClick={connect}>
          {run.phase === 'failed'
            ? run.step === 'install'
              ? 'Retry'
              : 'Reconnect Claude'
            : 'Connect Claude'}
        </button>
      </div>
      {error !== null && <p className="setup__error">{error}</p>}
    </section>
  );
};

/** The folder list a plain browser gets in place of the macOS picker. */
const FolderBrowser = ({
  onUse,
  onCancel,
}: {
  onUse: (folder: string) => void;
  onCancel: () => void;
}) => {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const open = useCallback((folder: string) => {
    setError(null);
    setupApi
      .folders(folder)
      .then((found) => {
        setListing(found);
        setTyped(found.path);
      })
      .catch((caught: unknown) => setError(errorText(caught)));
  }, []);

  useEffect(() => open(''), [open]);

  return (
    <div className="setup__folders">
      <form
        className="setup__row"
        onSubmit={(event) => {
          event.preventDefault();
          open(typed);
        }}
      >
        <input
          aria-label="Folder"
          spellCheck={false}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
        <button type="submit">Go</button>
      </form>
      {error !== null && <p className="setup__error">{error}</p>}
      {listing !== null && (
        <ul className="setup__folder-list">
          {listing.parent !== null && (
            <li>
              <button type="button" onClick={() => open(listing.parent ?? '')}>
                ↑ Up
              </button>
            </li>
          )}
          {listing.folders.map((name) => (
            <li key={name}>
              <button
                type="button"
                onClick={() => open(`${listing.path}/${name}`)}
              >
                {name}
              </button>
            </li>
          ))}
          {listing.folders.length === 0 && (
            <li className="muted">No folders here.</li>
          )}
        </ul>
      )}
      <div className="setup__actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          // Never the whole home folder (the list starts there).
          disabled={listing === null || listing.parent === null}
          onClick={() => listing !== null && onUse(listing.path)}
        >
          Use this folder
        </button>
      </div>
    </div>
  );
};

const ProjectStep = ({ onDone }: { onDone: () => void }) => {
  const [mode, setMode] = useState<'choose' | 'browse' | 'new'>('choose');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const use = (body: { folder: string } | { name: string }) => {
    setBusy(true);
    setError(null);
    setupApi
      .project(body)
      .then(onDone)
      .catch((caught: unknown) => setError(errorText(caught)))
      .finally(() => setBusy(false));
  };

  const chooseFolder = () => {
    const bridge = window.lambda;

    if (bridge === undefined) {
      setMode('browse');

      return;
    }

    bridge
      .pickFolder()
      .then((folder) => {
        if (folder !== null) {
          use({ folder });
        }
      })
      .catch((caught: unknown) => setError(errorText(caught)));
  };

  return (
    <section className="setup__body">
      <p className="setup__question">What are you working on?</p>
      {mode === 'browse' ? (
        <FolderBrowser
          onUse={(folder) => use({ folder })}
          onCancel={() => setMode('choose')}
        />
      ) : (
        <div className="setup__actions setup__actions--start">
          <button type="button" disabled={busy} onClick={chooseFolder}>
            Choose a folder…
          </button>
          <button type="button" disabled={busy} onClick={() => setMode('new')}>
            Start something new
          </button>
        </div>
      )}
      {mode === 'new' && (
        <form
          className="setup__row"
          onSubmit={(event) => {
            event.preventDefault();
            use({ name });
          }}
        >
          <label htmlFor="setup-name">Name</label>
          <input
            id="setup-name"
            autoFocus
            spellCheck={false}
            placeholder="pawnee-parks-app"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <span className="muted">
            → ~/Lambda/{name.trim() === '' ? '…' : name.trim()}
          </span>
          <button
            type="submit"
            className="primary"
            disabled={busy || name.trim() === ''}
          >
            Create
          </button>
        </form>
      )}
      {error !== null && <p className="setup__error">{error}</p>}
    </section>
  );
};

const KEY_LINKS = {
  linear: {
    href: 'https://linear.app/settings/account/security',
    text: 'Make one in Linear → Settings → API ↗',
  },
  jira: {
    href: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    text: 'Make one in Atlassian → Security → API tokens ↗',
  },
};

/**
 * After the Tickets step saves: a checked key stays on the step, showing the
 * "Connected as …" line it came back with, until Continue; markdown (nothing
 * to check) carries straight on.
 */
export const afterTicketsSaved = (
  connectedAs: string | null
): 'stay' | 'continue' => (connectedAs === null ? 'continue' : 'stay');

/**
 * After a key connects whose login isn't yours yet. A computer builds only
 * tickets you reported, so: is this login you? Yes counts it as yours; No
 * asks for the one that is (a build computer's own login is a No).
 */
export const WhoAreYou = ({
  ask,
  tracker,
}: {
  ask: AskWho;
  tracker: 'Linear' | 'Jira';
}) => {
  const [answer, setAnswer] = useState<'ask' | 'other'>('ask');
  const [yours, setYours] = useState(ask.yourEmail ?? '');
  const [counted, setCounted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const claim = (login: string) => {
    setBusy(true);
    setError(null);
    setupApi
      .you(login)
      .then((result) => setCounted(result.counts))
      .catch((caught: unknown) => setError(errorText(caught)))
      .finally(() => setBusy(false));
  };

  if (counted !== null) {
    return <p>✓ Tickets reported by {counted} are yours</p>;
  }

  const { name, email } = ask.login;

  return (
    <div className="setup__who">
      <p>
        Lambda builds only the tickets you report. Is {name}
        {email === null ? '' : ` (${email})`} you?
      </p>
      {answer === 'ask' ? (
        <div className="setup__actions setup__actions--start">
          <button
            type="button"
            disabled={busy}
            onClick={() => claim(email ?? name)}
          >
            Yes, that&apos;s me
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setAnswer('other')}
          >
            No, it&apos;s this computer&apos;s own login
          </button>
        </div>
      ) : (
        <>
          <label className="setup__field">
            Your email in {tracker}
            <input
              type="email"
              spellCheck={false}
              value={yours}
              onChange={(event) => setYours(event.target.value)}
            />
          </label>
          <div className="setup__actions setup__actions--start">
            <button
              type="button"
              disabled={busy || yours.trim() === ''}
              onClick={() => claim(yours)}
            >
              Save
            </button>
          </div>
        </>
      )}
      {error !== null && <p className="setup__error">{error}</p>}
    </div>
  );
};

export const TicketsStep = ({
  state,
  onDone,
  connected = null,
}: {
  state: SetupState;
  onDone: () => void;
  /** Already connected as (tests start here). */
  connected?: string | null;
}) => {
  const [source, setSource] = useState<'markdown' | 'linear' | 'jira'>(
    state.ticketSource ?? 'markdown'
  );
  const [apiKey, setApiKey] = useState('');
  const [site, setSite] = useState('');
  const [email, setEmail] = useState('');
  const [connectedAs, setConnectedAs] = useState<string | null>(connected);
  const [askWho, setAskWho] = useState<AskWho | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const body =
      source === 'markdown'
        ? { source }
        : source === 'linear'
        ? { source, apiKey }
        : { source, site, email, apiToken: apiKey };
    setupApi
      .tickets(body)
      .then((result) => {
        setConnectedAs(result.connectedAs);
        setAskWho(result.askWho);

        if (afterTicketsSaved(result.connectedAs) === 'continue') {
          onDone();
        }
      })
      .catch((caught: unknown) => setError(errorText(caught)))
      .finally(() => setBusy(false));
  };

  const options: { value: typeof source; label: string }[] = [
    { value: 'markdown', label: 'Right here in Lambda' },
    { value: 'linear', label: 'Linear' },
    { value: 'jira', label: 'Jira' },
  ];

  return (
    <form className="setup__body" onSubmit={submit}>
      <p className="setup__question">Where should tickets live?</p>
      <fieldset className="setup__choices" aria-label="Where tickets live">
        {options.map((option) => (
          <label key={option.value}>
            <input
              type="radio"
              name="ticket-source"
              checked={source === option.value}
              onChange={() => {
                setSource(option.value);
                setError(null);
                setConnectedAs(null);
                setAskWho(null);
              }}
            />{' '}
            {option.label}
          </label>
        ))}
      </fieldset>
      {source === 'jira' && (
        <>
          <label className="setup__field">
            Jira site
            <input
              spellCheck={false}
              placeholder="https://pawnee.atlassian.net"
              value={site}
              onChange={(event) => setSite(event.target.value)}
            />
          </label>
          <label className="setup__field">
            Email
            <input
              type="email"
              spellCheck={false}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
        </>
      )}
      {source !== 'markdown' && (
        <>
          <label className="setup__field">
            {source === 'linear' ? 'Linear API key' : 'Jira API token'}
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          <a href={KEY_LINKS[source].href} target="_blank" rel="noreferrer">
            {KEY_LINKS[source].text}
          </a>
        </>
      )}
      {error !== null && <p className="setup__error">{error}</p>}
      {connectedAs !== null && <p>✓ Connected as {connectedAs}</p>}
      {askWho !== null && source !== 'markdown' && (
        <WhoAreYou
          ask={askWho}
          tracker={source === 'linear' ? 'Linear' : 'Jira'}
        />
      )}
      <div className="setup__actions">
        {connectedAs !== null ? (
          <button type="button" className="primary" onClick={onDone}>
            Continue
          </button>
        ) : (
          <button
            type="submit"
            className="primary"
            disabled={
              busy ||
              (source !== 'markdown' && apiKey.trim() === '') ||
              (source === 'jira' && (site.trim() === '' || email.trim() === ''))
            }
          >
            Continue
          </button>
        )}
      </div>
    </form>
  );
};

/** `/setup?step=claude`: the renewal banner's Reconnect Claude. */
const askedStep = (): Step | null => {
  const asked = new URLSearchParams(window.location.search).get('step');

  return STEPS.find(({ step }) => step === asked)?.step ?? null;
};

export const Setup = ({ onFinished }: { onFinished: () => void }) => {
  const [state, setState] = useState<SetupState | null>(null);
  const [step, setStep] = useState<Step | null>(askedStep);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (options: { retryBrowser?: boolean } = {}) =>
      setupApi
        .state(options)
        .then((next): SetupState | null => {
          setState(next);
          setError(null);

          return next;
        })
        .catch((caught: unknown) => {
          setError(errorText(caught));

          return null;
        }),
    []
  );

  useEffect(() => {
    void load();
    // The mothership says when anything changed (a step's progress included).
    const events = new EventSource('/api/events');
    events.onmessage = () => void load();

    return () => events.close();
  }, [load]);

  // Belt and braces while something runs: the bar keeps moving.
  useEffect(() => {
    if (state === null || !isRunning(state)) {
      return undefined;
    }

    const timer = setInterval(() => void load(), 1000);

    return () => clearInterval(timer);
  }, [state, load]);

  if (state === null) {
    return (
      <main className="setup">
        <div className="setup__card">
          <p className="setup__brand">Lambda · Set up</p>
          {error !== null && <p className="setup__error">{error}</p>}
        </div>
      </main>
    );
  }

  const current = step ?? firstUnfinished(state) ?? 'claude';
  const next = (after: Step) => {
    void load().then((fresh) => {
      // Couldn't reload: the error shows, and the step stays put.
      if (fresh === null) {
        return;
      }

      const following = stepAfter(after, fresh);
      setStep(following);

      if (following === null) {
        onFinished();
      }
    });
  };

  return (
    <main className="setup">
      <div className="setup__card">
        <p className="setup__brand">Lambda · Set up</p>
        <StepIndicator state={state} current={current} onPick={setStep} />
        <BrowserProgress
          state={state}
          onRetry={() => void load({ retryBrowser: true })}
        />
        {current === 'claude' && (
          <ClaudeStep
            state={state}
            onContinue={() => next('claude')}
            refresh={() => void load()}
          />
        )}
        {current === 'project' && (
          <ProjectStep onDone={() => next('project')} />
        )}
        {current === 'tickets' && (
          <TicketsStep state={state} onDone={() => next('tickets')} />
        )}
        {error !== null && <p className="setup__error">{error}</p>}
      </div>
    </main>
  );
};
