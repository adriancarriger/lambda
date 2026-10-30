import { type FormEvent, useState } from 'react';

import { api } from './api';

/**
 * Every visit without a session lands here. A code from Add a device signs
 * this device in; on the computer running Lambda, `lambda open` skips it.
 */
export const SignIn = ({ onSignedIn }: { onSignedIn: () => void }) => {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent): void => {
    event.preventDefault();

    if (code.trim() === '' || busy) {
      return;
    }

    setBusy(true);
    setError(null);
    api
      .pair(code)
      .then(onSignedIn)
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : String(caught));
        setBusy(false);
      });
  };

  return (
    <main className="sign-in">
      <form className="sign-in__card" onSubmit={submit}>
        <p className="sign-in__brand">Lambda</p>
        {/* The design says "Sign in to Leslie's Lambda", but the owner's name
            can't be read before sign-in without a fifth public endpoint, and
            the public list (PUBLIC_ROUTES, mothership/gate.ts) is pinned to
            four. */}
        <h1 className="sign-in__title">Sign in to your Lambda</h1>
        <label className="sign-in__label" htmlFor="sign-in-code">
          Enter the code from &ldquo;Add a device&rdquo;
        </label>
        <input
          id="sign-in-code"
          className="sign-in__code"
          autoFocus
          autoComplete="one-time-code"
          spellCheck={false}
          placeholder="XXXX-XXXX"
          value={code}
          disabled={busy}
          onChange={(event) => setCode(event.target.value)}
        />
        {error !== null && (
          <p className="sign-in__error" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="primary"
          disabled={code.trim() === '' || busy}
        >
          Sign in
        </button>
        <p className="muted sign-in__hint">
          On the computer running Lambda? Run <code>lambda open</code> to sign
          in at once.
        </p>
      </form>
    </main>
  );
};
