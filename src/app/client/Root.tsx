import { lazy, useCallback, useEffect, useState } from 'react';

import type { SetupState } from '../../setup/routes';
import { Lazy } from './ChunkBoundary';
import { RenewalBanner } from './RenewalBanner';
import { SignIn } from './SignIn';
import { SIGNED_OUT_EVENT, api, setupApi } from './api';
import { type Status, sessionStatus } from './sessionStatus';
import { setupDone } from './setupSteps';
import { setUiLogSignedIn } from './uiLog';

/**
 * The page's first screen. Without a session nothing else loads: it's the
 * sign-in screen. With one, the app (its own chunk) takes over.
 */
const App = lazy(() =>
  import('./App').then((module) => ({ default: module.App }))
);

const Setup = lazy(() =>
  import('./Setup').then((module) => ({ default: module.Setup }))
);

/** First run's state; `failed`: unreadable, so the app opens as it would. */
type SetupStatus =
  | { kind: 'checking' }
  | { kind: 'read'; state: SetupState }
  | { kind: 'failed' };

const onSetupPage = (): boolean =>
  window.location.pathname.startsWith('/setup');

export const Root = () => {
  const [status, setStatus] = useState<Status>({ kind: 'checking' });

  const check = useCallback(
    () =>
      api
        .session()
        .then((session) => setStatus(sessionStatus({ session })))
        .catch((error: unknown) => setStatus(sessionStatus({ error }))),
    []
  );

  useEffect(() => {
    check();
    // A request refused for want of a session (signed out on another device,
    // or 30 days unused): back to the sign-in screen.
    const onSignedOut = () => setStatus({ kind: 'out' });
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);

    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, [check]);

  useEffect(() => setUiLogSignedIn(status.kind === 'in'), [status.kind]);

  const [setup, setSetup] = useState<SetupStatus>({ kind: 'checking' });

  useEffect(() => {
    if (status.kind !== 'in') {
      return;
    }

    setupApi
      .state()
      .then((state) => setSetup({ kind: 'read', state }))
      .catch(() => setSetup({ kind: 'failed' }));
  }, [status.kind]);

  if (status.kind === 'checking') {
    return null;
  }

  if (status.kind === 'out') {
    return <SignIn onSignedIn={() => window.location.reload()} />;
  }

  if (status.kind === 'unreachable') {
    return (
      <main className="sign-in">
        <div className="sign-in__card">
          <p className="sign-in__brand">Lambda</p>
          <p className="sign-in__title">Can't reach Lambda — try again.</p>
          <button
            type="button"
            onClick={() => {
              setStatus({ kind: 'checking' });
              void check();
            }}
          >
            Try again
          </button>
        </div>
      </main>
    );
  }

  if (setup.kind === 'checking') {
    return null;
  }

  return (
    <SignedIn
      state={setup.kind === 'read' ? setup.state : null}
      setupPage={onSetupPage()}
    />
  );
};

/**
 * Signed in: setup while it's unfinished (or on /setup, Run setup again…),
 * else the app. The renewal banner sits above either: every page shows it.
 */
export const SignedIn = ({
  state,
  setupPage,
  day,
  zone,
}: {
  /** First run's state; null when it couldn't be read. */
  state: SetupState | null;
  setupPage: boolean;
  /** Today, for the banner (tests pin it). */
  day?: string;
  /** The banner's time zone (tests pin it). */
  zone?: string;
}) => {
  const showSetup = setupPage || (state !== null && !setupDone(state));

  return (
    <div className="with-banner">
      <RenewalBanner
        expiresOn={state?.claudeExpiresOn ?? null}
        day={day}
        zone={zone}
      />
      <div className="with-banner__app">
        <Lazy fallback={null}>
          {showSetup ? (
            <Setup
              onFinished={() => {
                window.location.assign('/');
              }}
            />
          ) : (
            <App />
          )}
        </Lazy>
      </div>
    </div>
  );
};
